-- Etapa 3C.3, Fase 5 (G13): catalogo global x configuracoes pessoais.
--
-- Escopo desta migration: apenas persistencia e isolamento. Nao ha repositorio TypeScript,
-- rota, nem integracao de `evaluateToolPolicy` aqui — isso e 5.2/5.3/5.4.
--
-- Modelo conceitual (docs/FASE_5_G13_CATALOGO_GLOBAL_CONFIGURACOES_PESSOAIS.md, §4):
--   * `nexus.tool_grants`               autorizacao pessoal: quem (owner) permite qual ferramenta
--                                       para qual assistente. Deny-by-default: a ausencia de linha
--                                       significa "nao concedido".
--   * `nexus.tool_grant_audit`          trilha append-only de concessoes e revogacoes.
--   * `nexus.user_assistant_preferences` preferencias de apresentacao do owner. Nao autorizam nada.
--
-- Regras desta migration:
--   * ADITIVA. Nenhuma tabela, coluna ou linha existente e alterada. 00001-00006 sao imutaveis.
--   * IDENTIDADE COMPOSTA com `owner_id` nas tres tabelas. As tabelas de preferencia legadas
--     (`assistant_provider_preferences`, `conversation_provider_preferences`) usam PK sem
--     `owner_id` e so funcionam porque `nexus.owner_identity` e singleton. O padrao nao e
--     repetido aqui: `(owner_id, assistant_id)` e `(owner_id, assistant_id, tool_id)`.
--   * RLS `ENABLE` + `FORCE` nas tres tabelas. `FORCE` importa porque garante que o isolamento
--     vale tambem para o proprietario das tabelas, nao apenas para `nexus_app`.
--   * A auditoria e escrita exclusivamente por funcao `SECURITY DEFINER`, e a aplicacao recebe
--     apenas `SELECT` sobre ela. A funcao pertence ao papel `nexus_audit_writer` (NOLOGIN,
--     NOSUPERUSER, NOBYPASSRLS) e escreve via policy de INSERT escopada a esse papel — sem
--     SUPERUSER/BYPASSRLS e sem policy generica de INSERT (ver secao 2.1).
--   * Os enums desta migration nao ficam com `USAGE` para PUBLIC: ver bloco final de ACL.
--
-- Adaptacoes em relacao a `nexus.memory_permissions` (padrao de referencia), todas justificadas:
--   1. `memory_permissions` usa `UNIQUE (memory_id, assistant_id)` sem `owner_id`. Aqui a
--      unicidade inclui `owner_id`, pelo motivo acima.
--   2. `memory_permissions` guarda `granted_by_owner_id`/`revoked_by_owner_id`; mantemos os dois
--      campos e acrescentamos `created_at`/`updated_at`, que `memory_permissions` nao tem. Isso
--      permite ordenar e auditar a linha sem depender de `granted_at`/`revoked_at`.
--   3. `memory_permissions` aceita historico apenas pelo par status+timestamps. Aqui o mesmo par e
--      exigido, mais um trigger que impede reaproveitar a linha para outro escopo (ver abaixo).
BEGIN;

CREATE TYPE nexus.tool_grant_status AS ENUM ('granted', 'revoked');
CREATE TYPE nexus.tool_grant_action AS ENUM ('granted', 'revoked');

-- ---------------------------------------------------------------------------------------------
-- 1. Autorizacao pessoal de ferramenta
-- ---------------------------------------------------------------------------------------------
CREATE TABLE nexus.tool_grants (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES nexus.assistants(id) ON DELETE RESTRICT,
  -- `tool_id` referencia o catalogo de `packages/tools`, que vive em codigo e nao em tabela.
  -- Nao ha FK possivel: `nexus.tool_definitions` nao existe (decisao explicita da Fase 5 —
  -- criar um espelho sem leitor seria estrutura sobreposta). A integridade e garantida por:
  --   * formato, via CHECK de unicidade de id nao vazio;
  --   * existencia no catalogo, na camada de dominio (5.3/5.4), antes do INSERT.
  tool_id text NOT NULL,
  status nexus.tool_grant_status NOT NULL,
  granted_by_owner_id uuid NOT NULL,
  granted_at timestamptz NOT NULL,
  revoked_by_owner_id uuid,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tool_grants_unique_scope UNIQUE (owner_id, assistant_id, tool_id),
  CONSTRAINT tool_grants_tool_id_not_blank CHECK (btrim(tool_id) <> ''),
  CONSTRAINT tool_grants_tool_id_format
    CHECK (tool_id ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$'),
  -- Um grant so pode ser concedido pelo proprio owner da linha. Este CHECK torna impossivel
  -- gravar uma concessao "em nome de outro owner" mesmo por SQL privilegiado: o RLS compara com
  -- o contexto, nao com a semantica da linha, entao essa coerencia precisa existir no schema.
  CONSTRAINT tool_grants_granted_by_owner CHECK (granted_by_owner_id = owner_id),
  CONSTRAINT tool_grants_revoked_by_owner
    CHECK (revoked_by_owner_id IS NULL OR revoked_by_owner_id = owner_id),
  -- Estados temporalmente coerentes: ou ativo sem revogacao, ou revogado com revogacao completa
  -- e posterior a concessao. Nao existe "revogado sem quem revogou" nem "ativo com revoked_at".
  CONSTRAINT tool_grants_state_coherent CHECK (
    (status = 'granted' AND revoked_by_owner_id IS NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_by_owner_id IS NOT NULL
        AND revoked_at IS NOT NULL AND revoked_at >= granted_at)
  ),
  CONSTRAINT tool_grants_timestamps_ordered CHECK (updated_at >= created_at)
);

-- Caminho quente da politica: "existe grant ativo para (owner, assistente, ferramenta)?"
CREATE INDEX tool_grants_active_lookup_idx
  ON nexus.tool_grants (owner_id, assistant_id, tool_id)
  WHERE status = 'granted';
-- Listagem de interface, que inclui as linhas revogadas.
CREATE INDEX tool_grants_by_owner_assistant_idx
  ON nexus.tool_grants (owner_id, assistant_id);

-- Coerencia de ciclo de vida que um CHECK nao consegue expressar (depende de OLD):
--   * uma linha nasce concedida — nao existe "revogacao sem concessao previa";
--   * o escopo (owner, assistente, ferramenta) e imutavel — uma linha revogada nao pode ser
--     reaproveitada para autorizar outro par, o que criaria uma trilha de auditoria mentirosa.
CREATE FUNCTION nexus.enforce_tool_grant_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  -- (1) Uma linha de autorizacao nasce CONCEDIDA. Nao existe historico que comece revogado, e
  -- uma linha ativa nao pode nascer com marcadores de revogacao.
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'granted' THEN
      RAISE EXCEPTION 'Tool grant history must begin with an explicit grant'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by_owner_id IS NOT NULL THEN
      RAISE EXCEPTION 'An active tool grant cannot carry revocation markers'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- (3) e (5) `revoked` e TERMINAL e IMUTAVEL: nenhuma coluna pode mudar depois da revogacao.
  -- Isto cobre `revoked -> granted`, `revoked -> revoked` com novo `revoked_at`, troca de
  -- `revoked_by_owner_id` e qualquer outra atualizacao de linha revogada.
  IF OLD.status = 'revoked' THEN
    RAISE EXCEPTION 'Revoked tool grant is immutable' USING ERRCODE = '42501';
  END IF;

  -- (6) Escopo imutavel em QUALQUER atualizacao (inclusive na transicao para revogado).
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.assistant_id IS DISTINCT FROM OLD.assistant_id
     OR NEW.tool_id IS DISTINCT FROM OLD.tool_id THEN
    RAISE EXCEPTION 'Tool grant scope is immutable' USING ERRCODE = '42501';
  END IF;

  -- (7) Proveniencia da concessao imutavel: `granted_by`/`granted_at` nunca sao reescritos,
  -- nem na transicao para revogado. Sem isso seria possivel retro-datar uma concessao ja
  -- auditada e deixar a trilha contando uma historia falsa.
  IF NEW.granted_by_owner_id IS DISTINCT FROM OLD.granted_by_owner_id
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
    RAISE EXCEPTION 'Tool grant provenance is immutable' USING ERRCODE = '42501';
  END IF;

  -- (2) A unica transicao de status a partir de `granted` e `granted -> revoked`.
  -- `granted -> granted` e REJEITADO, inclusive tocar apenas `updated_at`: um grant ativo nao e
  -- editavel. Isso fecha a ultima brecha na qual um UPDATE passava sem gerar evento de auditoria,
  -- deixando a coluna alterada e a trilha sem registro. Toda escrita em `tool_grants` ou e a
  -- concessao (INSERT) ou e a revogacao (unica transicao) — as duas auditadas.
  IF NEW.status = 'granted' THEN
    RAISE EXCEPTION 'Active tool grant is immutable: the only allowed update is granted -> revoked'
      USING ERRCODE = '42501';
  END IF;

  -- (4) Aqui OLD.status = 'granted' e NEW.status = 'revoked'. A revogacao precisa estar completa:
  -- quem revogou e quando. `tool_grants_state_coherent` tambem exige, mas o trigger da o erro
  -- com nome de regra em vez de violacao de CHECK.
  IF NEW.revoked_by_owner_id IS NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'Revocation requires both revoked_by_owner_id and revoked_at'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER tool_grants_lifecycle_guard
BEFORE INSERT OR UPDATE ON nexus.tool_grants
FOR EACH ROW EXECUTE FUNCTION nexus.enforce_tool_grant_lifecycle();

-- ---------------------------------------------------------------------------------------------
-- 2. Auditoria append-only
-- ---------------------------------------------------------------------------------------------
-- POLITICA DE RETENCAO desta trilha (decidida e verificada):
--
--   * append-only durante toda a vida da instalacao: `nexus_app` nao tem privilegio de INSERT,
--     UPDATE ou DELETE aqui, e existe apenas uma policy de SELECT. Escrita somente pela funcao
--     SECURITY DEFINER abaixo;
--   * excluir um GRANT preserva seus eventos. `grant_id` e deliberadamente SEM foreign key:
--     e um snapshot historico, e sobrevive ao DELETE da linha correspondente em `tool_grants`.
--     Verificado no bloco L de `tests/postgres/verify-stage-5-rls.sql`;
--   * excluir DEFINITIVAMENTE o owner apaga a trilha junto. `owner_id` tem `ON DELETE CASCADE`
--     porque remover a linha de `owner_identity` representa a destruicao integral dos dados da
--     instalacao, e nao uma operacao de rotina. Verificado no bloco de cascata;
--   * o mesmo raciocinio vale para `memory_permission_audit` em 00001, que guarda uuids como
--     snapshot pelo mesmo motivo.
--
-- A distincao entre os dois primeiros casos e o que impede ler "append-only" como "imortal":
-- a trilha e imutavel, nao e indestrutivel.
--
-- LIMITE DE SEGURANCA — SUPERUSER ESTA FORA DA FRONTEIRA DO RLS. Verificado em PostgreSQL 17.11:
-- mesmo com `ENABLE` + `FORCE` e sem NENHUMA policy de INSERT para o dono, um SUPERUSER consegue
-- inserir direto em `tool_grant_audit` sem contexto. `FORCE` faz o RLS valer para o DONO da
-- tabela, nao para SUPERUSER/BYPASSRLS — isso e o modelo do PostgreSQL, nao um defeito desta
-- policy, e nao ha como corrigi-lo dentro do RLS. Consequencias praticas, aceitas:
--   * quem tem SUPERUSER pode forjar ou apagar auditoria; a trilha protege contra a APLICACAO
--     (`nexus_app`), contra o dono do schema e contra papeis comuns, nao contra o DBA;
--   * a operacao normal NAO precisa de SUPERUSER: a gravacao da trilha e feita pelo papel
--     `nexus_audit_writer` (NOLOGIN, NOSUPERUSER, NOBYPASSRLS) via SECURITY DEFINER, e o
--     provisionamento exige apenas CREATEROLE + GRANT OPTION (ver secao 2.1);
--   * por isso a recomendacao operacional e: SUPERUSER so em janela administrativa, e
--     `nexus_app`/`nexus_audit_writer` NUNCA com SUPERUSER ou BYPASSRLS.
-- O teste `C2.4c` de `tests/postgres/verify-stage-5-grants-lifecycle.sql` fixa esse limite como
-- comportamento ESPERADO: se um dia um superusuario deixar de conseguir furar o RLS, o teste
-- falha e esta documentacao precisa ser revista.
CREATE TABLE nexus.tool_grant_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  grant_id uuid NOT NULL,
  assistant_id uuid NOT NULL REFERENCES nexus.assistants(id) ON DELETE RESTRICT,
  tool_id text NOT NULL,
  action nexus.tool_grant_action NOT NULL,
  actor_owner_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tool_grant_audit_actor_is_owner CHECK (actor_owner_id = owner_id)
);
CREATE INDEX tool_grant_audit_by_grant_idx
  ON nexus.tool_grant_audit (owner_id, grant_id, occurred_at DESC);

-- SECURITY DEFINER porque `nexus_app` tem apenas SELECT nesta tabela: a aplicacao le a trilha,
-- nunca a escreve. Sem isso, um comprometimento da credencial de aplicacao permitiria forjar
-- auditoria. Restricoes obrigatorias em toda funcao privilegiada:
--   * `SET search_path = pg_catalog` — nada e resolvido fora de `pg_catalog`, exceto os nomes
--     ja qualificados com `nexus.` abaixo;
--   * os dados vem exclusivamente de NEW/OLD (linhas ja validadas pelos CHECK da tabela);
--   * nao aceita parametro do chamador, portanto nao ha superficie de injecao;
--   * `REVOKE ALL ... FROM PUBLIC` imediatamente apos a criacao.
CREATE FUNCTION nexus.audit_tool_grant_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  audit_action nexus.tool_grant_action;
BEGIN
  -- Mapeamento EXPLICITO entre os dois enums, sem cast. `::text::` acoplava os rotulos dos dois
  -- tipos: se um deles ganhasse um valor novo sem o outro, o cast falharia em runtime, dentro do
  -- trigger. Com CASE, cada valor e tratado e um valor inesperado levanta erro nomeado.
  IF TG_OP = 'INSERT' THEN
    audit_action := 'granted';
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    audit_action := CASE NEW.status
                      WHEN 'granted' THEN 'granted'::nexus.tool_grant_action
                      WHEN 'revoked' THEN 'revoked'::nexus.tool_grant_action
                      ELSE NULL
                    END;
    IF audit_action IS NULL THEN
      RAISE EXCEPTION 'Unmapped tool grant status in audit trigger: %', NEW.status;
    END IF;
  ELSE
    -- Inalcancavel pelo trigger de ciclo de vida (todo UPDATE nao-revogacao passa por
    -- granted -> revoked). Mantido como barreira caso o trigger de lifecycle seja removido.
    RAISE EXCEPTION 'Tool grant update without status change reached the audit trigger'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO nexus.tool_grant_audit (
    owner_id, grant_id, assistant_id, tool_id, action, actor_owner_id
  ) VALUES (
    NEW.owner_id,
    NEW.id,
    NEW.assistant_id,
    NEW.tool_id,
    audit_action,
    CASE WHEN audit_action = 'granted'
         THEN NEW.granted_by_owner_id
         ELSE NEW.revoked_by_owner_id
    END
  );

  RETURN NEW;
END
$$;

CREATE TRIGGER tool_grants_audit_changes
AFTER INSERT OR UPDATE ON nexus.tool_grants
FOR EACH ROW EXECUTE FUNCTION nexus.audit_tool_grant_change();
REVOKE ALL ON FUNCTION nexus.audit_tool_grant_change() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- 2.1 Papel de escrita da trilha — por que a funcao nao pertence ao dono do schema
-- ---------------------------------------------------------------------------------------------
-- `FORCE ROW LEVEL SECURITY` aplica as policies ao PROPRIO dono da tabela. Uma funcao
-- `SECURITY DEFINER` cujo dono fosse um papel de bootstrap (NOSUPERUSER/NOBYPASSRLS) NAO teria
-- policy de INSERT em `tool_grant_audit` e falharia com
--     new row violates row-level security policy for table "tool_grant_audit"
-- quando o bootstrap nao fosse superusuario. Verificado em PostgreSQL 17.11.
--
-- A saida NAO e uma policy permissiva para o dono nem BYPASSRLS: e um papel dedicado, sem login,
-- que so consegue inserir NESTA tabela. A funcao passa a pertencer a ele e a policy de INSERT e
-- escopada (`TO nexus_audit_writer`), de modo que o privilegio nao vaza para `nexus_app` nem para
-- o dono do schema. Assim a gravacao da trilha funciona igual em instalacao real sem SUPERUSER.
-- `CREATE ROLE` e objeto de CLUSTER, nao de banco: sobrevive a `DROP DATABASE` e nao e desfeito
-- por ROLLBACK. A criacao e idempotente; os atributos de um papel PREEXISTENTE sao VERIFICADOS
-- (nao reafirmados) — ver o bloco de checagem logo abaixo, que explica por que `ALTER ROLE` nao
-- pode ser usado por um provisionador sem SUPERUSER/CREATEDB/BYPASSRLS.
--
-- =============================================================================================
-- PROVISIONAMENTO EM INSTALACAO REAL SEM SUPERUSER (verificado em PostgreSQL 17.11)
-- =============================================================================================
-- O que NAO basta, comprovado por experimento:
--   * `CREATEROLE` sozinho NAO permite `ALTER FUNCTION ... OWNER TO nexus_audit_writer`:
--     falha com `must be able to SET ROLE "nexus_audit_writer"`.
--   * Criar o papel pela propria migration (como `CREATE ROLE`) NAO da ao provisionador o
--     direito de assumi-lo: a membresia automatica criada pelo `CREATE ROLE` tem
--     `set_option = false` e `grantor` = papel de bootstrap, nao o provisionador.
--   * `ALTER FUNCTION ... OWNER TO` exige que o NOVO dono tenha `CREATE` no schema do objeto.
--     Sem isso a mensagem e enganosa: `permission denied for schema nexus` (o problema e o
--     privilegio do novo dono, nao do executante).
--
-- Sequencia CORRETA para o provisionador (papel com CREATEROLE, NOSUPERUSER, NOBYPASSRLS):
--   1. `CREATE ROLE nexus_audit_writer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;`
--   2. `GRANT USAGE, CREATE ON SCHEMA nexus TO nexus_audit_writer;`
--   3. `GRANT nexus_audit_writer TO <provisionador> WITH SET TRUE, INHERIT TRUE;`
--   4. `GRANT USAGE, CREATE ON SCHEMA nexus TO <provisionador> WITH GRANT OPTION;`
--      `GRANT ALL ON ALL TABLES IN SCHEMA nexus TO <provisionador> WITH GRANT OPTION;`
--   5. aplicar as migrations (esta incluida), que fazem o `ALTER FUNCTION ... OWNER TO`.
--   6. (depois) `REVOKE CREATE ON SCHEMA nexus FROM nexus_audit_writer;` — o `CREATE` so era
--      necessario para a transferencia de propriedade; o INSERT nao precisa dele.
--
-- GRANT OPTION e obrigatorio no provisionador. Esta migration concede ao escritor
--     privilegios sobre objetos cujo dono e OUTRO papel (o que aplicou a 00001). Sem
--     `WITH GRANT OPTION` o PostgreSQL NAO levanta erro: emite
--         WARNING:  no privileges were granted for "owner_identity"
--     e o GRANT e silenciosamente ignorado. A migration "passa" com o escritor sem permissao e a
--     falha so aparece em runtime, na primeira auditoria (ver passo 4 acima).
--
-- Privilegios minimos do provisionador, no total: CREATEROLE (para criar o escritor) + USAGE e
-- CREATE no schema `nexus` + GRANT OPTION nos objetos que delega. Nada de SUPERUSER nem
-- BYPASSRLS — nem no provisionador, nem no escritor, nem em `nexus_app`. Nada de ownership
-- amplo: ele nao precisa ser dono das tabelas, so poder delegar sobre elas.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_audit_writer') THEN
    -- Os atributos sao definidos NA CRIACAO. `CREATE ROLE` permite ao papel com CREATEROLE
    -- definir NOSUPERUSER/NOBYPASSRLS/NOCREATEDB; `ALTER ROLE` NAO permite (ver abaixo).
    CREATE ROLE nexus_audit_writer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- ATENCAO — armadilha verificada em PostgreSQL 17.11: `ALTER ROLE ... NOSUPERUSER` exige que o
-- EXECUTANTE seja SUPERUSER, `ALTER ROLE ... NOCREATEDB` exige CREATEDB, e
-- `ALTER ROLE ... NOBYPASSRLS` exige BYPASSRLS. Um provisionador apenas com CREATEROLE recebe
--     ERROR: permission denied to alter role
--     DETAIL: Only roles with the SUPERUSER attribute may change the SUPERUSER attribute.
-- por isso a instrucao NAO e executada aqui: ela quebraria exatamente o cenario "sem superuser"
-- que este bloco existe para suportar. Em vez de reafirmar, VERIFICAMOS e falhamos com uma
-- mensagem acionavel — se um papel pre-existente estiver com atributo errado, quem corrige e um
-- superusuario, uma unica vez, e o erro diz isso.
DO $$
DECLARE
  r record;
BEGIN
  SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
    INTO r
    FROM pg_roles WHERE rolname = 'nexus_audit_writer';

  IF r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole THEN
    RAISE EXCEPTION
      'Role nexus_audit_writer has unsafe attributes (login=%, superuser=%, bypassrls=%, createdb=%, createrole=%). A superuser must fix it once with: ALTER ROLE nexus_audit_writer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;',
      r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole
      USING ERRCODE = '42501';
  END IF;
END
$$;

-- Memberships: o escritor nao herda nada de ninguem e nao e membro de nenhum outro papel. Se o
-- papel foi pre-existente com memberships (por exemplo alguem o adicionou a `pg_read_all_data`),
-- elas sao removidas aqui. Sem isso, o `INSERT` restrito a uma tabela poderia virar leitura
-- ampla do banco por heranca.
DO $$
DECLARE
  m record;
BEGIN
  FOR m IN
    SELECT parent.rolname AS parent
    FROM pg_auth_members am
    JOIN pg_roles child ON child.oid = am.member
    JOIN pg_roles parent ON parent.oid = am.roleid
    WHERE child.rolname = 'nexus_audit_writer'
  LOOP
    EXECUTE format('REVOKE %I FROM nexus_audit_writer', m.parent);
  END LOOP;
END
$$;

-- `nexus_app` nunca pode ser membro do escritor: seria escalada de privilegio (o escritor tem
-- INSERT na trilha). Se algum provisionamento deixou isso para tras, e removido aqui.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_app') THEN
    IF pg_has_role('nexus_app', 'nexus_audit_writer', 'MEMBER') THEN
      REVOKE nexus_audit_writer FROM nexus_app;
    END IF;
    IF pg_has_role('nexus_audit_writer', 'nexus_app', 'MEMBER') THEN
      REVOKE nexus_app FROM nexus_audit_writer;
    END IF;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA nexus TO nexus_audit_writer;
-- `CREATE` no schema e requisito do `ALTER FUNCTION ... OWNER TO` (ver bloco acima).
GRANT CREATE ON SCHEMA nexus TO nexus_audit_writer;
GRANT INSERT ON nexus.tool_grant_audit TO nexus_audit_writer;
-- A policy de INSERT da trilha compara a linha com `nexus.current_owner_id()` e
-- `nexus.configured_owner_id()`. A segunda le `nexus.owner_identity` como o PAPEL CORRENTE
-- (a funcao nao e SECURITY DEFINER), entao o escritor precisa de SELECT nessa tabela. Sem isso a
-- escrita falha com `permission denied for table owner_identity` dentro da policy. E o minimo
-- necessario: SELECT apenas em `owner_identity`, nada mais.
GRANT SELECT ON nexus.owner_identity TO nexus_audit_writer;
ALTER FUNCTION nexus.audit_tool_grant_change() OWNER TO nexus_audit_writer;
-- Depois da transferencia o `CREATE` nao serve para mais nada: a funcao ja e do escritor e ele
-- so precisa de INSERT. Reduzir aqui evita que o papel crie objetos no schema `nexus`.
REVOKE CREATE ON SCHEMA nexus FROM nexus_audit_writer;

-- ---------------------------------------------------------------------------------------------
-- 3. Preferencias pessoais de apresentacao
-- ---------------------------------------------------------------------------------------------
-- `user_assistant_settings` NAO e criada: teria a mesma chave `(owner_id, assistant_id)` e o
-- mesmo ciclo de vida, ou seja, responsabilidade sobreposta. Verbosidade entra aqui como coluna
-- tipada. "Confirmacoes" e "limites pessoais" nao entram: o primeiro precisa permanecer derivado
-- de `tool.requiresUserConfirmation` (uma coluna configuravel permitiria ao cliente desligar uma
-- exigencia de seguranca) e o segundo pertence a fase que o aplica (runtime de ferramentas).
CREATE TABLE nexus.user_assistant_preferences (
  owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES nexus.assistants(id) ON DELETE CASCADE,
  is_default boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  display_label text,
  response_verbosity text NOT NULL DEFAULT 'normal',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, assistant_id),
  CONSTRAINT user_assistant_preferences_sort_order CHECK (sort_order >= 0),
  CONSTRAINT user_assistant_preferences_label_length
    CHECK (display_label IS NULL OR char_length(display_label) BETWEEN 1 AND 64),
  -- `char_length` aceitaria '   ' (tres espacos) como rotulo de 3 caracteres. Branco apenas nao
  -- e rotulo. `btrim` NAO serve sozinho: sem argumento ele remove apenas espaco, nao TAB/quebra
  -- de linha — e `E'\t'` passaria. A expressao regular cobre todo branco POSIX
  -- (espaco, tab, newline, CR, FF, VT). NULL continua permitido (rotulo e opcional).
  CONSTRAINT user_assistant_preferences_label_not_blank
    CHECK (display_label IS NULL OR display_label ~ '[^[:space:]]'),
  -- Rotulo e texto livre digitado pelo owner; usa o helper de deteccao de credencial que ja
  -- existe em 00001 para impedir colar um token aqui. Nao ha coluna JSONB nesta migration, por
  -- isso `jsonb_has_credential_key` nao se aplica.
  CONSTRAINT user_assistant_preferences_label_not_credential
    CHECK (display_label IS NULL OR NOT nexus.text_looks_like_credential_material(display_label)),
  CONSTRAINT user_assistant_preferences_verbosity
    CHECK (response_verbosity IN ('concise', 'normal', 'detailed')),
  CONSTRAINT user_assistant_preferences_timestamps_ordered
    CHECK (updated_at >= created_at)
);

-- No maximo um assistente padrao por owner. Indice unico parcial em vez de trigger: a troca do
-- padrao exige que o repositorio (5.2) desmarque o anterior e marque o novo na MESMA transacao.
CREATE UNIQUE INDEX user_assistant_preferences_single_default_idx
  ON nexus.user_assistant_preferences (owner_id)
  WHERE is_default;

-- ---------------------------------------------------------------------------------------------
-- 4. Isolamento: RLS forcada + politicas explicitas por comando
-- ---------------------------------------------------------------------------------------------
-- Duas variantes de politica coexistem em 00001 e a escolha aqui e deliberada:
--
--   * `tool_grants` e `tool_grant_audit` usam a variante ESTRITA (SELECT tambem exige
--     `actor_type = 'owner'`). Um actor `assistant` nunca le nem escreve autorizacao: a
--     resolucao de "o que eu posso usar" e feita pelo servidor, com actor owner, antes de
--     qualquer delegacao. Dar leitura a um actor assistant permitiria ao modelo descobrir o
--     proprio conjunto de permissoes e contornar a regra de que YUI coordena mas nao e
--     onipotente.
--
--   * `user_assistant_preferences` usa a variante com LEITURA AMPLA (SELECT sem `actor_type`;
--     escrita exige `owner`), igual a `assistant_provider_preferences` em 00001. O motivo e o
--     mesmo daquelas tabelas: o CORE precisa ler a preferencia de apresentacao dentro de uma
--     transacao cujo actor e `assistant`, mas preferencia nunca e escrita por assistente.
--
-- A comparacao `owner_id = nexus.configured_owner_id()` e mantida em todas as policies. Hoje ela
-- e redundante porque `owner_identity` e singleton, mas e o que garante que um contexto com
-- `nexus.owner_id` sintetico (owner B) nao obtenha acesso — e continuara correta quando a Fase 7
-- revisar o singleton.

ALTER TABLE nexus.tool_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.tool_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tool_grants_owner_select ON nexus.tool_grants
  FOR SELECT USING (
    owner_id = nexus.current_owner_id()
    AND owner_id = nexus.configured_owner_id()
    AND nexus.current_actor_type() = 'owner'
  );
CREATE POLICY tool_grants_owner_insert ON nexus.tool_grants
  FOR INSERT WITH CHECK (
    owner_id = nexus.current_owner_id()
    AND owner_id = nexus.configured_owner_id()
    AND nexus.current_actor_type() = 'owner'
  );
CREATE POLICY tool_grants_owner_update ON nexus.tool_grants
  FOR UPDATE USING (
    owner_id = nexus.current_owner_id()
    AND owner_id = nexus.configured_owner_id()
    AND nexus.current_actor_type() = 'owner'
  ) WITH CHECK (
    owner_id = nexus.current_owner_id()
    AND owner_id = nexus.configured_owner_id()
    AND nexus.current_actor_type() = 'owner'
  );
-- DELETE existe para o CONTRATO DE DOMINIO: o owner pode apagar um grant que e dado pessoal seu.
--
-- ATENCAO — a policy de DELETE NAO e o que permite o `ON DELETE CASCADE` de `owner_identity`
-- funcionar. Acoes de integridade referencial do PostgreSQL sao executadas como o dono da
-- constraint e NAO passam pelo RLS como um DELETE da aplicacao. Verificado em PostgreSQL 17.11:
-- remover esta policy e depois apagar a linha de `owner_identity` continua cascateando
-- `tool_grants` e `tool_grant_audit`. A ausencia da policy faria o DELETE da aplicacao afetar
-- 0 linhas silenciosamente, e so isso.
--
-- Nao ha policy de DELETE para actor assistant: a revogacao de autorizacao e representada por
-- `status = 'revoked'`, nao por remocao da linha.
CREATE POLICY tool_grants_owner_delete ON nexus.tool_grants
  FOR DELETE USING (
    owner_id = nexus.current_owner_id()
    AND owner_id = nexus.configured_owner_id()
    AND nexus.current_actor_type() = 'owner'
  );

-- Append-only: existem apenas policies de SELECT e INSERT. Sem policy de UPDATE/DELETE e com
-- FORCE RLS, nenhum comando de alteracao encontra linha. `nexus_app` tambem nao recebe o
-- privilegio de tabela correspondente (ver bootstrap), entao ha duas barreiras independentes.
ALTER TABLE nexus.tool_grant_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.tool_grant_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY tool_grant_audit_owner_select ON nexus.tool_grant_audit
  FOR SELECT USING (
    owner_id = nexus.current_owner_id()
    AND owner_id = nexus.configured_owner_id()
    AND nexus.current_actor_type() = 'owner'
  );
-- Insercao na trilha e permitida APENAS ao papel escritor da funcao SECURITY DEFINER acima.
-- Nao existe policy de INSERT para `nexus_app` (que tambem nao possui o privilegio de tabela),
-- nem para o dono do schema: FORCE RLS vale para ele e ele nao tem policy de INSERT.
--
-- `WITH CHECK (true)` foi substituido por verificacao de coerencia. A funcao SECURITY DEFINER
-- roda com o GUC `nexus.owner_id` do chamador ainda ativo (e o mesmo GUC usado por
-- `nexus.current_owner_id()` dentro do trigger de auditoria), entao a policy consegue comparar a
-- linha que esta sendo gravada com o contexto da transacao. Isso impede que qualquer outra funcao
-- futura com dono `nexus_audit_writer` grave evento de um owner ou de um actor que nao seja o do
-- contexto — o privilegio de INSERT deixa de ser "pode escrever qualquer linha" e passa a ser
-- "pode escrever a linha coerente com o contexto corrente".
CREATE POLICY tool_grant_audit_writer_insert ON nexus.tool_grant_audit
  FOR INSERT TO nexus_audit_writer WITH CHECK (
    -- As clausulas `IS NOT NULL` sao DEFESA EM PROFUNDIDADE; a analise honesta e esta: hoje elas
    -- nao mudam o resultado. `WITH CHECK` exige TRUE, e uma comparacao que resulte NULL conta
    -- como violacao — sem contexto, `owner_id = current_owner_id()` vira `uuid = NULL` = NULL e
    -- o INSERT ja seria recusado (verificado em PostgreSQL 17.11: remover as duas clausulas NAO
    -- faz o teste C2.3b passar a aceitar a linha). O que elas garantem e que isso continue
    -- valendo se alguem trocar a comparacao por `IS NOT DISTINCT FROM` (que devolve TRUE para
    -- NULL = NULL) ou envolve-la em `coalesce`. Mantidas porque custo zero e intencao explicita.
    nexus.current_owner_id() IS NOT NULL
    AND nexus.configured_owner_id() IS NOT NULL
    AND owner_id = nexus.current_owner_id()
    AND owner_id = nexus.configured_owner_id()
    AND actor_owner_id = owner_id
  );

ALTER TABLE nexus.user_assistant_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.user_assistant_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY user_assistant_preferences_select ON nexus.user_assistant_preferences
  FOR SELECT USING (
    owner_id = nexus.current_owner_id()
    AND owner_id = nexus.configured_owner_id()
  );
CREATE POLICY user_assistant_preferences_owner_insert ON nexus.user_assistant_preferences
  FOR INSERT WITH CHECK (
    owner_id = nexus.current_owner_id()
    AND owner_id = nexus.configured_owner_id()
    AND nexus.current_actor_type() = 'owner'
  );
CREATE POLICY user_assistant_preferences_owner_update ON nexus.user_assistant_preferences
  FOR UPDATE USING (
    owner_id = nexus.current_owner_id()
    AND owner_id = nexus.configured_owner_id()
    AND nexus.current_actor_type() = 'owner'
  ) WITH CHECK (
    owner_id = nexus.current_owner_id()
    AND owner_id = nexus.configured_owner_id()
    AND nexus.current_actor_type() = 'owner'
  );
CREATE POLICY user_assistant_preferences_owner_delete ON nexus.user_assistant_preferences
  FOR DELETE USING (
    owner_id = nexus.current_owner_id()
    AND owner_id = nexus.configured_owner_id()
    AND nexus.current_actor_type() = 'owner'
  );

-- Defesa em profundidade: o schema ja revoga tudo de PUBLIC em 00001, mas as tabelas novas nao
-- herdam esse REVOKE (ele foi executado antes de existirem). Repetir aqui garante que nenhum
-- papel inesperado receba privilegio por heranca de PUBLIC.
REVOKE ALL ON nexus.tool_grants FROM PUBLIC;
REVOKE ALL ON nexus.tool_grant_audit FROM PUBLIC;
REVOKE ALL ON nexus.user_assistant_preferences FROM PUBLIC;
REVOKE ALL ON FUNCTION nexus.enforce_tool_grant_lifecycle() FROM PUBLIC;

-- Enums: `CREATE TYPE` concede USAGE a PUBLIC por padrao. Registrado no catalogo:
--   typacl IS NULL  =>  acldefault('T', owner)  =>  PUBLIC=USAGE
-- Um tipo de dominio em `nexus` nao e material publico. Revogamos e concedemos apenas a quem
-- precisa: `nexus_app` (valores em colunas e comparacoes) e `nexus_audit_writer` (a funcao da
-- trilha materializa valores de `nexus.tool_grant_action` por CASE, sem cast de texto).
--
-- ORDEM DE BOOTSTRAP: as migrations rodam ANTES da criacao dos papeis de aplicacao, que vive em
-- `tests/postgres/bootstrap.sql` e no provisionamento real. Conceder a `nexus_app` aqui exigiria
-- que o papel ja existisse. Por isso o GRANT e condicional: se o papel existir, ele recebe USAGE
-- agora; se nao existir, o bootstrap da o mesmo GRANT (ver `tests/postgres/bootstrap.sql`).
-- A REVOKE de PUBLIC vale nos dois casos — e o que garante que ninguem herde USAGE por padrao.
REVOKE ALL ON TYPE nexus.tool_grant_status FROM PUBLIC;
REVOKE ALL ON TYPE nexus.tool_grant_action FROM PUBLIC;
GRANT USAGE ON TYPE nexus.tool_grant_status TO nexus_audit_writer;
GRANT USAGE ON TYPE nexus.tool_grant_action TO nexus_audit_writer;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_app') THEN
    EXECUTE 'GRANT USAGE ON TYPE nexus.tool_grant_status TO nexus_app';
    EXECUTE 'GRANT USAGE ON TYPE nexus.tool_grant_action TO nexus_app';
  END IF;
END
$$;

COMMIT;
