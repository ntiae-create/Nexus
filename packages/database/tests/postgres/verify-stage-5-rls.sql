\set ON_ERROR_STOP on
-- Fase 5 (G13): verificacao de integridade, RLS e auditoria de `nexus.tool_grants`,
-- `nexus.tool_grant_audit` e `nexus.user_assistant_preferences`.
--
-- Roda como `nexus_app` (LOGIN NOSUPERUSER NOBYPASSRLS), igual a integration.sql, depois do
-- bootstrap. Cada bloco prova um requisito da subfase 5.1. Nenhum mock: e PostgreSQL 17 real.
--
-- Convencao: um DO que nao levanta excecao e um requisito satisfeito.

DO $$
BEGIN
  IF current_user <> 'nexus_app' THEN
    RAISE EXCEPTION 'Phase 5 checks must run as nexus_app, got %', current_user;
  END IF;
END
$$;

-- =============================================================================================
-- A0. Invariantes de ESQUEMA (catalogo) — nao podem ser provados por comportamento
-- =============================================================================================
-- `FORCE ROW LEVEL SECURITY` merece verificacao propria por duas razoes:
--   * para `nexus_app`, que NAO e dono da tabela, `ENABLE` ja basta: FORCE nao muda nada. Logo,
--     nenhum teste de comportamento executado como `nexus_app` poderia detectar a remocao de
--     FORCE. So o catalogo prova.
--   * a protecao que FORCE oferece e contra o PROPRIO DONO da tabela. Ele NAO protege contra
--     SUPERUSER nem contra papeis com BYPASSRLS — esses ignoram RLS com ou sem FORCE. Sao duas
--     defesas distintas e por isso sao verificadas separadamente abaixo.
DO $$
DECLARE
  relation record;
  checked integer := 0;
  expected_tables constant text[] := ARRAY[
    'tool_grants', 'tool_grant_audit', 'user_assistant_preferences'
  ];
BEGIN
  FOR relation IN
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'nexus' AND c.relname = ANY (expected_tables)
    ORDER BY c.relname
  LOOP
    checked := checked + 1;
    IF NOT relation.relrowsecurity THEN
      RAISE EXCEPTION '%.% must have ROW LEVEL SECURITY enabled', 'nexus', relation.relname;
    END IF;
    IF NOT relation.relforcerowsecurity THEN
      RAISE EXCEPTION '%.% must have FORCE ROW LEVEL SECURITY', 'nexus', relation.relname;
    END IF;
  END LOOP;

  IF checked <> array_length(expected_tables, 1) THEN
    RAISE EXCEPTION 'Expected % Phase 5 tables, found %', array_length(expected_tables, 1), checked;
  END IF;

  -- O papel de aplicacao nao pode ser dono: enquanto nao for, FORCE e redundante para ele; se a
  -- propriedade mudar, FORCE passa a ser a unica barreira. Verificar as duas coisas torna a
  -- regressao visivel nos dois cenarios.
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'nexus' AND tablename = ANY (expected_tables)
      AND tableowner = current_user
  ) THEN
    RAISE EXCEPTION 'Application role must not own personal-data tables';
  END IF;
END
$$;

-- Nenhum papel alem de `nexus_app` pode receber privilegio de tabela nas tabelas da Fase 5.
-- Defesa em profundidade: hoje `nexus_anonymous` tambem nao tem USAGE no schema `nexus`, entao um
-- GRANT acidental nao chega a ser exploravel — mas depender so dessa segunda barreira deixaria a
-- regressao invisivel. Aqui as duas sao verificadas de forma independente.
DO $$
DECLARE
  expected_tables constant text[] := ARRAY[
    'tool_grants', 'tool_grant_audit', 'user_assistant_preferences'
  ];
  offender record;
BEGIN
  FOR offender IN
    SELECT c.relname, acl.grantee::regrole::text AS role_name, acl.privilege_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS acl
    WHERE n.nspname = 'nexus'
      AND c.relname = ANY (expected_tables)
      AND acl.grantee <> 0                              -- 0 = PUBLIC
      AND acl.grantee <> c.relowner                     -- o dono sempre tem privilegio
      AND acl.grantee <> 'nexus_app'::regrole
      -- Unica excecao: o papel escritor da trilha. Ele so pode INSERT, e so em
      -- tool_grant_audit — o que e verificado explicitamente logo abaixo. Qualquer outro
      -- privilegio dele em qualquer dessas tabelas continua sendo falha.
      AND NOT (acl.grantee = 'nexus_audit_writer'::regrole
               AND c.relname = 'tool_grant_audit'
               AND acl.privilege_type = 'INSERT')
  LOOP
    RAISE EXCEPTION 'Unexpected grant on nexus.% to % (%)',
      offender.relname, offender.role_name, offender.privilege_type;
  END LOOP;

  -- O papel escritor da trilha: exatamente INSERT em tool_grant_audit, e nada mais em lugar
  -- nenhum. Sem esta assercao positiva, a excecao acima poderia mascarar um GRANT a mais.
  FOR offender IN
    SELECT c.relname AS role_name, a.privilege_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS a
    WHERE n.nspname = 'nexus'
      AND c.relname = ANY (expected_tables)
      AND a.grantee = 'nexus_audit_writer'::regrole
      AND NOT (c.relname = 'tool_grant_audit' AND a.privilege_type = 'INSERT')
  LOOP
    RAISE EXCEPTION 'nexus_audit_writer must only INSERT on tool_grant_audit, found % on nexus.%',
      offender.role_name, offender.role_name;
  END LOOP;

  -- E a aplicacao NAO pode escrever a trilha: SELECT e o teto.
  FOR offender IN
    SELECT a.privilege_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS a
    WHERE n.nspname = 'nexus'
      AND c.relname = 'tool_grant_audit'
      AND a.grantee = 'nexus_app'::regrole
      AND a.privilege_type <> 'SELECT'
  LOOP
    RAISE EXCEPTION 'nexus_app must not hold % on the grant audit trail', offender.privilege_type;
  END LOOP;

  -- PUBLIC nao pode ter privilegio nenhum.
  FOR offender IN
    SELECT c.relname, acl.privilege_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS acl
    WHERE n.nspname = 'nexus'
      AND c.relname = ANY (expected_tables)
      AND acl.grantee = 0
  LOOP
    RAISE EXCEPTION 'PUBLIC must not hold % on nexus.%', offender.privilege_type, offender.relname;
  END LOOP;
END
$$;

-- `nexus_anonymous` continua sem acesso ao schema (barreira que ja existe desde 00001).
DO $$
BEGIN
  IF has_schema_privilege('nexus_anonymous', 'nexus', 'USAGE') THEN
    RAISE EXCEPTION 'nexus_anonymous must not have USAGE on schema nexus';
  END IF;
END
$$;

-- `nexus_app` nunca pode escapar do RLS por atributo de papel. Esta e a unica verificacao que
-- cobre SUPERUSER/BYPASSRLS: FORCE nao cobre, por definicao.
DO $$
DECLARE
  role_record record;
BEGIN
  SELECT rolsuper, rolbypassrls, rolcanlogin, rolinherit INTO role_record
  FROM pg_roles WHERE rolname = 'nexus_app';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Role nexus_app does not exist';
  END IF;
  IF role_record.rolsuper THEN
    RAISE EXCEPTION 'nexus_app must not be SUPERUSER (would bypass RLS regardless of FORCE)';
  END IF;
  IF role_record.rolbypassrls THEN
    RAISE EXCEPTION 'nexus_app must not have BYPASSRLS (would bypass RLS regardless of FORCE)';
  END IF;
  IF NOT role_record.rolcanlogin THEN
    RAISE EXCEPTION 'nexus_app must be able to log in';
  END IF;
  -- NOINHERIT: nenhum privilegio chega por heranca de outro papel.
  IF role_record.rolinherit THEN
    RAISE EXCEPTION 'nexus_app must be NOINHERIT';
  END IF;

  -- Reforco no proprio backend: os atributos que importam vem do catalogo acima, mas o
  -- `current_user` efetivo tambem precisa confirmar que nao ha elevacao nesta sessao.
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'Current user must not be SUPERUSER';
  END IF;
END
$$;

-- =============================================================================================
-- A00. Repetibilidade
-- =============================================================================================
-- Este arquivo usa UUIDs fixos para que as assercoes sejam legiveis. Sem isolamento, uma segunda
-- execucao no mesmo banco colidiria na PK e falharia por motivo errado — foi exatamente o que
-- aconteceu durante a investigacao das sabotagens B e D.
--
-- A limpeza NAO e feita aqui: `nexus_app` nao tem privilegio de DELETE na auditoria (por design),
-- e conceder esse privilegio para "facilitar o teste" seria exatamente o enfraquecimento que a
-- subfase proibe. O isolamento e responsabilidade do harness, que roda este arquivo em banco
-- recem-criado (uma execucao por banco). Ver `scripts/test-postgres-integration.sh`.
--
-- O arquivo VERIFICA a propria pre-condicao em vez de assumi-la. Se rodar sobre um banco que ja
-- executou esta verificacao, falha imediatamente com a causa real, em vez de produzir um erro
-- enganoso de PK mais adiante (foi o que aconteceu durante a investigacao de B e D).
-- A checagem PRECISA rodar com contexto RLS: sem ele, o RLS faz toda leitura devolver 0 linhas e
-- a guarda seria estruturalmente incapaz de detectar um banco sujo (foi o que aconteceu na
-- primeira tentativa). `nexus.tool_grants` e `nexus.tool_grant_audit` exigem `actor_type='owner'`
-- no SELECT; `user_assistant_preferences` apenas contexto de owner.
BEGIN;
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);
DO $$
DECLARE
  grant_rows integer;
  audit_rows integer;
  preference_rows integer;
BEGIN
  SELECT count(*) INTO grant_rows FROM nexus.tool_grants;
  SELECT count(*) INTO audit_rows FROM nexus.tool_grant_audit;
  SELECT count(*) INTO preference_rows FROM nexus.user_assistant_preferences;

  IF grant_rows <> 0 OR audit_rows <> 0 OR preference_rows <> 0 THEN
    RAISE EXCEPTION
      'Phase 5 verification requires a fresh database (found grants=%, audit=%, preferences=%). Recreate nexus_test or use a new database.',
      grant_rows, audit_rows, preference_rows
      USING ERRCODE = '55000';
  END IF;
END
$$;
COMMIT;

-- =============================================================================================
-- A. Privilegios efetivos do papel de aplicacao
-- =============================================================================================
DO $$
DECLARE
  can_insert_audit boolean;
  can_update_audit boolean;
  can_delete_audit boolean;
  can_select_audit boolean;
  can_write_grants boolean;
BEGIN
  can_select_audit := has_table_privilege(current_user, 'nexus.tool_grant_audit', 'SELECT');
  can_insert_audit := has_table_privilege(current_user, 'nexus.tool_grant_audit', 'INSERT');
  can_update_audit := has_table_privilege(current_user, 'nexus.tool_grant_audit', 'UPDATE');
  can_delete_audit := has_table_privilege(current_user, 'nexus.tool_grant_audit', 'DELETE');
  can_write_grants := has_table_privilege(current_user, 'nexus.tool_grants', 'INSERT,UPDATE,DELETE');

  IF NOT can_select_audit THEN
    RAISE EXCEPTION 'Application role must be able to read the grant audit trail';
  END IF;
  IF can_insert_audit OR can_update_audit OR can_delete_audit THEN
    RAISE EXCEPTION 'Application role must not write the grant audit trail (insert=%, update=%, delete=%)',
      can_insert_audit, can_update_audit, can_delete_audit;
  END IF;
  IF NOT can_write_grants THEN
    RAISE EXCEPTION 'Application role must be able to grant and revoke';
  END IF;
END
$$;

-- =============================================================================================
-- B. Sem contexto RLS: nenhuma operacao pessoal obtem acesso
-- =============================================================================================
DO $$
BEGIN
  IF (SELECT count(*) FROM nexus.tool_grants) <> 0 THEN
    RAISE EXCEPTION 'Missing owner context exposed tool grants';
  END IF;
  IF (SELECT count(*) FROM nexus.tool_grant_audit) <> 0 THEN
    RAISE EXCEPTION 'Missing owner context exposed grant audit';
  END IF;
  IF (SELECT count(*) FROM nexus.user_assistant_preferences) <> 0 THEN
    RAISE EXCEPTION 'Missing owner context exposed assistant preferences';
  END IF;

  BEGIN
    INSERT INTO nexus.tool_grants (
      id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at
    ) VALUES (
      'a0000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000001',
      'personal.tasks', 'granted',
      '00000000-0000-4000-8000-000000000004', now()
    );
    RAISE EXCEPTION 'Grant insert without owner context unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO nexus.user_assistant_preferences (owner_id, assistant_id)
    VALUES ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'Preference insert without owner context unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

-- =============================================================================================
-- C. Owner A: concessao, leitura, auditoria automatica e revogacao
-- =============================================================================================
BEGIN;
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);

DO $$
DECLARE
  active_count integer;
  audit_count integer;
BEGIN
  INSERT INTO nexus.tool_grants (
    id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at
  ) VALUES (
    'a1000000-0000-4000-8000-000000000001', nexus.current_owner_id(),
    '00000000-0000-4000-8000-000000000001', 'personal.tasks', 'granted',
    nexus.current_owner_id(), now()
  );

  -- 7. grant ativo persistido corretamente
  SELECT count(*) INTO active_count
  FROM nexus.tool_grants
  WHERE owner_id = nexus.current_owner_id()
    AND assistant_id = '00000000-0000-4000-8000-000000000001'
    AND tool_id = 'personal.tasks'
    AND status = 'granted'
    AND revoked_at IS NULL;
  IF active_count <> 1 THEN
    RAISE EXCEPTION 'Active grant was not persisted (found %)', active_count;
  END IF;

  -- 11. auditoria gerada automaticamente
  SELECT count(*) INTO audit_count FROM nexus.tool_grant_audit WHERE grant_id = 'a1000000-0000-4000-8000-000000000001';
  IF audit_count <> 1 THEN
    RAISE EXCEPTION 'Grant insert must produce exactly one audit row, found %', audit_count;
  END IF;

  UPDATE nexus.tool_grants
  SET status = 'revoked', revoked_by_owner_id = nexus.current_owner_id(), revoked_at = now()
  WHERE id = 'a1000000-0000-4000-8000-000000000001';

  -- 8. revogacao mantem historico coerente: 1 linha, 2 eventos
  SELECT count(*) INTO audit_count FROM nexus.tool_grant_audit WHERE grant_id = 'a1000000-0000-4000-8000-000000000001';
  IF audit_count <> 2 THEN
    RAISE EXCEPTION 'Grant + revoke must produce two audit rows, found %', audit_count;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM nexus.tool_grant_audit
    WHERE grant_id = 'a1000000-0000-4000-8000-000000000001'
      AND action = 'revoked'
      AND actor_owner_id = nexus.current_owner_id()
  ) THEN
    RAISE EXCEPTION 'Revocation audit row is missing or has the wrong actor';
  END IF;

  -- Atualizacao sem mudanca de status nao gera evento espurio. Aqui a linha JA esta revogada, e
  -- `revoked` e terminal (trigger `enforce_tool_grant_lifecycle`): o UPDATE tem de ser recusado,
  -- nao silenciosamente aceito. Fazer o UPDATE "passar" para testar o silencio da auditoria
  -- contradiria a imutabilidade da revogacao.
  BEGIN
    UPDATE nexus.tool_grants SET updated_at = now() WHERE id = 'a1000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'Update of a revoked tool grant was accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
  SELECT count(*) INTO audit_count FROM nexus.tool_grant_audit WHERE grant_id = 'a1000000-0000-4000-8000-000000000001';
  IF audit_count <> 2 THEN
    RAISE EXCEPTION 'A rejected update must not produce an audit row, found %', audit_count;
  END IF;
END
$$;
COMMIT;

-- =============================================================================================
-- D. Rejeicoes de dominio (estados e duplicidade)
-- =============================================================================================
BEGIN;
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);
DO $$
BEGIN
  -- 9a. linha nao pode nascer revogada
  BEGIN
    INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at, revoked_by_owner_id, revoked_at)
    VALUES ('a2000000-0000-4000-8000-000000000001', nexus.current_owner_id(), '00000000-0000-4000-8000-000000000002',
            'research.search', 'revoked', nexus.current_owner_id(), now(), nexus.current_owner_id(), now());
    RAISE EXCEPTION 'Revoked row was accepted on insert';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  -- 9b. ativo com revoked_at preenchido e recusado. O trigger `enforce_tool_grant_lifecycle`
  -- roda ANTES dos CHECK e agora tambem recusa (42501); quando o trigger nao intervier, o CHECK
  -- `tool_grants_state_coherent` recusa (23514). As duas barreiras valem: o que nao pode existir
  -- e a linha, nao um SQLSTATE especifico.
  BEGIN
    INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at, revoked_at)
    VALUES ('a2000000-0000-4000-8000-000000000002', nexus.current_owner_id(), '00000000-0000-4000-8000-000000000002',
            'research.search', 'granted', nexus.current_owner_id(), now(), now());
    RAISE EXCEPTION 'Granted row with revoked_at was accepted';
  EXCEPTION WHEN check_violation OR SQLSTATE '42501' THEN NULL;
  END;

  -- 9c. revogado sem quem revogou viola o CHECK
  BEGIN
    INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at, revoked_at)
    VALUES ('a2000000-0000-4000-8000-000000000003', nexus.current_owner_id(), '00000000-0000-4000-8000-000000000002',
            'research.search', 'revoked', nexus.current_owner_id(), now(), now());
    RAISE EXCEPTION 'Revoked row without revoked_by_owner_id was accepted';
  EXCEPTION WHEN check_violation OR SQLSTATE '42501' THEN NULL;
  END;

  -- 9d. grant em nome de outro owner viola o CHECK (nao depende do RLS)
  BEGIN
    INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at)
    VALUES ('a2000000-0000-4000-8000-000000000004', nexus.current_owner_id(), '00000000-0000-4000-8000-000000000002',
            'research.search', 'granted', '99999999-0000-4000-8000-000000000001', now());
    RAISE EXCEPTION 'Grant attributed to another owner was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 9e. revogacao anterior a concessao viola o CHECK
  BEGIN
    INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at, revoked_by_owner_id, revoked_at)
    VALUES ('a2000000-0000-4000-8000-000000000005', nexus.current_owner_id(), '00000000-0000-4000-8000-000000000002',
            'research.search', 'revoked', nexus.current_owner_id(), now(), nexus.current_owner_id(), now() - interval '1 hour');
    RAISE EXCEPTION 'Revocation dated before grant was accepted';
  EXCEPTION WHEN check_violation OR SQLSTATE '42501' THEN NULL;
  END;

  -- 9f. tool_id vazio
  BEGIN
    INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at)
    VALUES ('a2000000-0000-4000-8000-000000000006', nexus.current_owner_id(), '00000000-0000-4000-8000-000000000002',
            '   ', 'granted', nexus.current_owner_id(), now());
    RAISE EXCEPTION 'Blank tool_id was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 10. duplicidade de grant
  BEGIN
    INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at)
    VALUES ('a2000000-0000-4000-8000-000000000007', nexus.current_owner_id(), '00000000-0000-4000-8000-000000000001',
            'personal.tasks', 'granted', nexus.current_owner_id(), now());
    RAISE EXCEPTION 'Duplicate (owner, assistant, tool) grant was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- escopo imutavel: nao se reaproveita a linha revogada para outra ferramenta
  BEGIN
    UPDATE nexus.tool_grants SET tool_id = 'personal.organize'
    WHERE id = 'a1000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'Tool grant scope mutation was accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  -- FK: assistente inexistente
  BEGIN
    INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at)
    VALUES ('a2000000-0000-4000-8000-000000000008', nexus.current_owner_id(), '99999999-0000-4000-8000-000000000009',
            'personal.tasks', 'granted', nexus.current_owner_id(), now());
    RAISE EXCEPTION 'Grant for an unknown assistant was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END
$$;
COMMIT;

-- =============================================================================================
-- E. Actor `assistant`: le grants? nao (variante estrita). Escreve? nao.
--    Le preferencias? sim (variante de leitura ampla). Escreve? nao.
-- =============================================================================================
BEGIN;
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);
INSERT INTO nexus.user_assistant_preferences (owner_id, assistant_id, sort_order, is_default)
VALUES (nexus.current_owner_id(), '00000000-0000-4000-8000-000000000002', 1, true);
COMMIT;

BEGIN;
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'assistant', true);
SELECT set_config('nexus.assistant_id', '00000000-0000-4000-8000-000000000002', true);
DO $$
BEGIN
  -- 5. actor assistant nao le grants
  IF (SELECT count(*) FROM nexus.tool_grants) <> 0 THEN
    RAISE EXCEPTION 'Assistant actor must not read tool grants';
  END IF;
  IF (SELECT count(*) FROM nexus.tool_grant_audit) <> 0 THEN
    RAISE EXCEPTION 'Assistant actor must not read the grant audit trail';
  END IF;

  -- mas precisa ler a preferencia (o CORE le dentro de transacao com actor assistant)
  IF (SELECT count(*) FROM nexus.user_assistant_preferences) <> 1 THEN
    RAISE EXCEPTION 'Assistant actor must be able to read assistant preferences';
  END IF;

  BEGIN
    INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at)
    VALUES ('a3000000-0000-4000-8000-000000000001', nexus.current_owner_id(), nexus.current_assistant_id(),
            'personal.tasks', 'granted', nexus.current_owner_id(), now());
    RAISE EXCEPTION 'Assistant actor wrote a tool grant';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- O USING da policy exige actor owner, entao nenhuma linha e visivel e o UPDATE afeta 0 sem
  -- sequer chegar ao trigger. `42501` tambem e aceito: sob algumas versoes o planner avalia a
  -- WITH CHECK antes. O que nao pode acontecer e a linha mudar de estado.
  BEGIN
    UPDATE nexus.tool_grants SET status = 'revoked', revoked_by_owner_id = nexus.current_owner_id(), revoked_at = now()
    WHERE tool_id = 'personal.tasks';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM nexus.tool_grants WHERE tool_id = 'personal.tasks' AND status = 'revoked') THEN
    RAISE EXCEPTION 'Assistant actor revoked a tool grant';
  END IF;

  BEGIN
    DELETE FROM nexus.tool_grants WHERE tool_id = 'personal.tasks';
    IF FOUND THEN RAISE EXCEPTION 'Assistant actor deleted a tool grant'; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- Preferencia tambem nao e escrita por assistente. Sob RLS, um UPDATE cujo USING nao casa
  -- nenhuma linha NAO levanta erro: ele afeta 0 linhas. O que se prova aqui e exatamente isso
  -- (nenhuma linha alterada), e nao uma excecao.
  UPDATE nexus.user_assistant_preferences SET sort_order = 99;
  IF FOUND THEN
    RAISE EXCEPTION 'Assistant actor wrote assistant preferences';
  END IF;
  IF (SELECT count(*) FROM nexus.user_assistant_preferences WHERE sort_order = 99) <> 0 THEN
    RAISE EXCEPTION 'Assistant actor changed a preference value';
  END IF;
END
$$;
COMMIT;

-- =============================================================================================
-- F. Isolamento entre owners (owner B sintetico)
--     `owner_identity` e singleton, entao um segundo owner legivel e impossivel de semear.
--     O que se prova aqui e a barreira que importa: um contexto cujo `nexus.owner_id` difere de
--     `nexus.configured_owner_id()` nao ve nem escreve nada, por mais que o cliente controle o
--     `set_config`. E o caso que continua correto quando a Fase 7 revisar o singleton.
-- =============================================================================================
BEGIN;
SELECT set_config('nexus.owner_id', '99999999-0000-4000-8000-000000000001', true);
SELECT set_config('nexus.actor_type', 'owner', true);
DO $$
BEGIN
  -- 2. owner B nao le grants do owner A (nem os proprios, porque nao e o owner configurado)
  IF (SELECT count(*) FROM nexus.tool_grants) <> 0 THEN
    RAISE EXCEPTION 'Foreign owner context exposed tool grants';
  END IF;
  IF (SELECT count(*) FROM nexus.tool_grant_audit) <> 0 THEN
    RAISE EXCEPTION 'Foreign owner context exposed the grant audit trail';
  END IF;
  IF (SELECT count(*) FROM nexus.user_assistant_preferences) <> 0 THEN
    RAISE EXCEPTION 'Foreign owner context exposed assistant preferences';
  END IF;

  -- 3/4. nao modifica nem exclui (0 linhas afetadas, e o CHECK/RLS barra o insert)
  UPDATE nexus.tool_grants SET status = 'revoked', revoked_by_owner_id = nexus.current_owner_id(), revoked_at = now()
  WHERE tool_id = 'personal.tasks';
  IF FOUND THEN RAISE EXCEPTION 'Foreign owner context modified a grant'; END IF;

  DELETE FROM nexus.tool_grants WHERE tool_id = 'personal.tasks';
  IF FOUND THEN RAISE EXCEPTION 'Foreign owner context deleted a grant'; END IF;

  DELETE FROM nexus.user_assistant_preferences;
  IF FOUND THEN RAISE EXCEPTION 'Foreign owner context deleted a preference'; END IF;

  BEGIN
    INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at)
    VALUES ('a4000000-0000-4000-8000-000000000001', nexus.current_owner_id(), '00000000-0000-4000-8000-000000000001',
            'personal.tasks', 'granted', nexus.current_owner_id(), now());
    RAISE EXCEPTION 'Foreign owner context created a grant';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
COMMIT;

-- =============================================================================================
-- G. Auditoria append-only para a aplicacao (privilegio de tabela)
-- =============================================================================================
BEGIN;
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);
DO $$
BEGIN
  -- 12. `nexus_app` nao altera nem exclui auditoria, nem consegue inserir manualmente
  BEGIN
    UPDATE nexus.tool_grant_audit SET tool_id = 'forged';
    RAISE EXCEPTION 'Application role updated the grant audit trail';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    DELETE FROM nexus.tool_grant_audit;
    RAISE EXCEPTION 'Application role deleted from the grant audit trail';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO nexus.tool_grant_audit (owner_id, grant_id, assistant_id, tool_id, action, actor_owner_id)
    VALUES (nexus.current_owner_id(), 'a1000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000001', 'personal.tasks', 'granted', nexus.current_owner_id());
    RAISE EXCEPTION 'Application role inserted into the grant audit trail';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
COMMIT;

-- =============================================================================================
-- H. Preferencias: chave composta, padrao unico, limites de dominio
-- =============================================================================================
BEGIN;
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);
DO $$
DECLARE
  pref_count integer;
BEGIN
  -- 14/15. a mesma assistente tem uma linha; a chave e (owner, assistente)
  SELECT count(*) INTO pref_count
  FROM nexus.user_assistant_preferences
  WHERE owner_id = nexus.current_owner_id() AND assistant_id = '00000000-0000-4000-8000-000000000002';
  IF pref_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one preference row for (owner, assistant), found %', pref_count;
  END IF;

  BEGIN
    INSERT INTO nexus.user_assistant_preferences (owner_id, assistant_id)
    VALUES (nexus.current_owner_id(), '00000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'Duplicate (owner, assistant) preference was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- 15b. dois padroes para o mesmo owner
  BEGIN
    INSERT INTO nexus.user_assistant_preferences (owner_id, assistant_id, is_default)
    VALUES (nexus.current_owner_id(), '00000000-0000-4000-8000-000000000003', true);
    RAISE EXCEPTION 'A second default assistant was accepted for the same owner';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- ordem negativa
  BEGIN
    INSERT INTO nexus.user_assistant_preferences (owner_id, assistant_id, sort_order)
    VALUES (nexus.current_owner_id(), '00000000-0000-4000-8000-000000000003', -1);
    RAISE EXCEPTION 'Negative sort_order was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- rotulo com material de credencial
  BEGIN
    INSERT INTO nexus.user_assistant_preferences (owner_id, assistant_id, display_label)
    VALUES (nexus.current_owner_id(), '00000000-0000-4000-8000-000000000003', 'Bearer abcdefghijklmnopqrstuvwx');
    RAISE EXCEPTION 'Credential-looking display_label was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- verbosidade fora do vocabulario
  BEGIN
    INSERT INTO nexus.user_assistant_preferences (owner_id, assistant_id, response_verbosity)
    VALUES (nexus.current_owner_id(), '00000000-0000-4000-8000-000000000003', 'verbose');
    RAISE EXCEPTION 'Unknown response_verbosity was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- rotulo normal e aceito
  INSERT INTO nexus.user_assistant_preferences (owner_id, assistant_id, display_label, sort_order)
  VALUES (nexus.current_owner_id(), '00000000-0000-4000-8000-000000000003', 'Pesquisa', 2);
END
$$;
COMMIT;

-- =============================================================================================
-- I. 13. Rollback da operacao reverte tambem a auditoria
-- =============================================================================================
-- O bloco roda dentro de uma transacao com contexto valido: sem ele, o INSERT seria barrado pelo
-- RLS antes de chegar ao ponto que interessa (a atomicidade grant + audit).
BEGIN;
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);
DO $$
DECLARE
  audit_before integer;
  audit_after integer;
BEGIN
  SELECT count(*) INTO audit_before FROM nexus.tool_grant_audit;
  BEGIN
    INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at)
    VALUES ('a5000000-0000-4000-8000-000000000001', nexus.current_owner_id(), '00000000-0000-4000-8000-000000000003',
            'technical.code_analysis', 'granted', nexus.current_owner_id(), now());
    RAISE EXCEPTION 'forced rollback';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  SELECT count(*) INTO audit_after FROM nexus.tool_grant_audit;
  IF audit_after <> audit_before THEN
    RAISE EXCEPTION 'Rolled-back grant left % audit row(s) behind', audit_after - audit_before;
  END IF;
  IF EXISTS (SELECT 1 FROM nexus.tool_grants WHERE id = 'a5000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'Rolled-back grant is still present';
  END IF;
END
$$;
COMMIT;

-- =============================================================================================
-- J. 16. Concorrencia serializada pelo UNIQUE (duas sessoes nao podem criar o mesmo par)
--     O teste de corrida real com dois backends esta no bloco de sessao dupla abaixo; aqui se
--     prova que uma segunda concessao do mesmo par, depois do commit da primeira, e rejeitada.
-- =============================================================================================
BEGIN;
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);
DO $$
BEGIN
  INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at)
  VALUES ('a6000000-0000-4000-8000-000000000001', nexus.current_owner_id(), '00000000-0000-4000-8000-000000000003',
          'technical.code_analysis', 'granted', nexus.current_owner_id(), now());

  BEGIN
    INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at)
    VALUES ('a6000000-0000-4000-8000-000000000002', nexus.current_owner_id(), '00000000-0000-4000-8000-000000000003',
            'technical.code_analysis', 'granted', nexus.current_owner_id(), now());
    RAISE EXCEPTION 'Concurrent-style duplicate grant was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END
$$;
COMMIT;

-- =============================================================================================
-- L. DELETE direto pelo owner (CONTRATO DE DOMINIO)
-- =============================================================================================
-- Este teste e POSITIVO de proposito. Todos os outros testes de DELETE deste arquivo sao
-- negativos ("nao pode apagar"), e um DELETE barrado por RLS afeta 0 linhas SEM erro — o que
-- torna esses testes cegos para a remocao da policy `tool_grants_owner_delete`. Sem um teste
-- positivo, apagar a policy passaria despercebido.
BEGIN;
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);
DO $$
DECLARE
  audit_before integer;
  audit_after integer;
BEGIN
  SELECT count(*) INTO audit_before
  FROM nexus.tool_grant_audit WHERE grant_id = 'a1000000-0000-4000-8000-000000000001';

  DELETE FROM nexus.tool_grants WHERE id = 'a1000000-0000-4000-8000-000000000001';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Owner could not delete their own tool grant';
  END IF;

  IF EXISTS (SELECT 1 FROM nexus.tool_grants WHERE id = 'a1000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'Deleted grant is still present';
  END IF;

  -- A trilha sobrevive: `grant_id` e snapshot historico, sem FK para `tool_grants`.
  SELECT count(*) INTO audit_after
  FROM nexus.tool_grant_audit WHERE grant_id = 'a1000000-0000-4000-8000-000000000001';
  IF audit_after <> audit_before THEN
    RAISE EXCEPTION 'Deleting a grant erased its audit history (% -> %)', audit_before, audit_after;
  END IF;
END
$$;
COMMIT;

-- =============================================================================================
-- M. ON DELETE CASCADE (INDEPENDENTE de policy de DELETE)
-- =============================================================================================
-- Ponto central, e o que explica a sabotagem D:
--   * acoes de integridade referencial do PostgreSQL rodam como o DONO da constraint e NAO passam
--     pelo RLS como um DELETE da aplicacao;
--   * logo, o `ON DELETE CASCADE` de `owner_identity` NAO depende de `tool_grants_owner_delete`;
--   * consequentemente, remover essa policy e invisivel para qualquer teste de cascade — o que
--     sobra para detecta-la e o teste POSITIVO de DELETE do bloco L.
--
-- Aqui se verifica o que esta ao alcance de `nexus_app`: as FKs estao declaradas com as acoes
-- corretas, e a aplicacao NAO consegue apagar a trilha de auditoria por conta propria (o que
-- tambem impede "limpar" a evidencia antes de uma cascata).
DO $$
DECLARE
  delete_rule_grants text;
  delete_rule_audit_owner text;
  delete_rule_prefs text;
BEGIN
  SELECT confdeltype INTO delete_rule_grants
  FROM pg_constraint WHERE conname = 'tool_grants_owner_id_fkey';
  SELECT confdeltype INTO delete_rule_audit_owner
  FROM pg_constraint WHERE conname = 'tool_grant_audit_owner_id_fkey';
  SELECT confdeltype INTO delete_rule_prefs
  FROM pg_constraint WHERE conname = 'user_assistant_preferences_owner_id_fkey';

  -- 'c' = CASCADE.
  -- Usa `IS DISTINCT FROM` e nao `<>`: se a constraint nao existir, a subconsulta devolve NULL e
  -- a comparacao `NULL <> 'c'` avalia NULL — que nao dispara o RAISE. Seria uma falha silenciosa
  -- exatamente no caso mais grave (FK ausente). `IS DISTINCT FROM` trata NULL como distinto.
  IF delete_rule_grants IS DISTINCT FROM 'c' THEN
    RAISE EXCEPTION 'tool_grants.owner_id must cascade on owner deletion, found %', coalesce(delete_rule_grants, 'missing constraint');
  END IF;
  IF delete_rule_audit_owner IS DISTINCT FROM 'c' THEN
    RAISE EXCEPTION 'tool_grant_audit.owner_id must cascade on owner deletion, found %', coalesce(delete_rule_audit_owner, 'missing constraint');
  END IF;
  IF delete_rule_prefs IS DISTINCT FROM 'c' THEN
    RAISE EXCEPTION 'user_assistant_preferences.owner_id must cascade, found %', coalesce(delete_rule_prefs, 'missing constraint');
  END IF;

  -- `grant_id` NAO tem FK: e snapshot, sobrevive ao DELETE do grant (provado no bloco L).
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'nexus.tool_grant_audit'::regclass
      AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE '%grant_id%'
  ) THEN
    RAISE EXCEPTION 'tool_grant_audit.grant_id must not have a foreign key';
  END IF;

  -- A aplicacao nao pode apagar a trilha (nem para "preparar" uma cascata).
  BEGIN
    DELETE FROM nexus.tool_grant_audit WHERE owner_id = nexus.current_owner_id();
    RAISE EXCEPTION 'Application role deleted grant audit rows';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

-- O efeito pratico da cascata sobre as tres tabelas, exercitado onde e observavel: `tool_grants`
-- e `user_assistant_preferences` aceitam DELETE do owner, e a auditoria NAO e apagada por isso.
BEGIN;
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);
DO $$
DECLARE
  audit_before integer;
  audit_after integer;
BEGIN
  INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at)
  VALUES ('a8000000-0000-4000-8000-000000000001', nexus.current_owner_id(),
          '00000000-0000-4000-8000-000000000001', 'personal.tasks', 'granted',
          nexus.current_owner_id(), now());
  INSERT INTO nexus.user_assistant_preferences (owner_id, assistant_id)
  VALUES (nexus.current_owner_id(), '00000000-0000-4000-8000-000000000001');

  SELECT count(*) INTO audit_before FROM nexus.tool_grant_audit;

  DELETE FROM nexus.tool_grants WHERE owner_id = nexus.current_owner_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Owner could not remove their tool grants';
  END IF;
  DELETE FROM nexus.user_assistant_preferences WHERE owner_id = nexus.current_owner_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Owner could not remove their assistant preferences';
  END IF;

  SELECT count(*) INTO audit_after FROM nexus.tool_grant_audit;
  IF audit_after < audit_before THEN
    RAISE EXCEPTION 'Deleting grants removed audit history (% -> %)', audit_before, audit_after;
  END IF;
END
$$;
ROLLBACK;

-- =============================================================================================
-- K. Estados finais coerentes
-- =============================================================================================
BEGIN;
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);
DO $$
DECLARE
  grants integer;
  audit_rows integer;
  prefs integer;
BEGIN
  -- Concessoes: bloco C (1), bloco J (1), bloco M (1, revertido) e bloco L (1, apagado
  -- explicitamente) => 1 linha no fim. Somente o bloco L foi DELETE direto do owner.
  SELECT count(*) INTO grants FROM nexus.tool_grants;
  IF grants <> 1 THEN RAISE EXCEPTION 'Expected 1 grant at the end, found %', grants; END IF;

  -- Eventos persistidos: concessao do bloco C (1) + revogacao do bloco C (1) + concessao do
  -- bloco J (1) = 3. O bloco L apagou o grant do bloco C, mas a trilha dele SOBREVIVEU (por isso
  -- as duas primeiras linhas continuam contando). Os eventos do bloco M foram revertidos.
  SELECT count(*) INTO audit_rows FROM nexus.tool_grant_audit;
  IF audit_rows <> 3 THEN RAISE EXCEPTION 'Expected 3 audit rows at the end, found %', audit_rows; END IF;

  SELECT count(*) INTO prefs FROM nexus.user_assistant_preferences;
  IF prefs <> 2 THEN RAISE EXCEPTION 'Expected 2 preferences at the end, found %', prefs; END IF;

  -- nenhuma linha ficou em estado impossivel
  IF EXISTS (
    SELECT 1 FROM nexus.tool_grants
    WHERE (status = 'granted' AND (revoked_at IS NOT NULL OR revoked_by_owner_id IS NOT NULL))
       OR (status = 'revoked' AND (revoked_at IS NULL OR revoked_by_owner_id IS NULL))
  ) THEN
    RAISE EXCEPTION 'Inconsistent grant state survived the checks';
  END IF;
END
$$;
COMMIT;

DO $$ BEGIN RAISE NOTICE 'Phase 5 (G13) SQL verification passed'; END $$;
