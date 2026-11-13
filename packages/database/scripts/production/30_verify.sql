-- =============================================================================
-- NEXUS — verificacao final do banco
-- =============================================================================
-- Executar como `nexus_migrator` (ou qualquer papel que leia o schema).
--
-- ESTE ARQUIVO FALHA. Nao e relatorio: cada invariante obrigatorio e checado com
-- RAISE EXCEPTION, e `\set ON_ERROR_STOP on` faz o psql sair com codigo != 0 no
-- primeiro que falhar. O instalador trata esse codigo e NAO imprime "CONCLUIDO".
--
-- Antes deste arquivo ser assim, ele imprimia contagens e terminava com
-- "VERIFICACAO CONCLUIDA" independentemente dos numeros — um banco com 3 tabelas
-- produzia a mesma mensagem final que um banco correto. Divergencia nao e aviso.
--
-- O que NAO e fatal (e por que):
--   * contagens sao diagnosticadas por seção, mas as obrigatorias falham;
--   * `nexus_anonymous` sem privilegios: e NOLOGIN e nao usado pelo runtime
--     (medido: nenhuma migration o referencia), entao ausencia de GRANT nao e erro.
--
-- Nao altera nada. Somente leitura.
-- =============================================================================

\set ON_ERROR_STOP on
\pset footer off

\echo '=================================================================='
\echo '1. LEDGER — as 8 migrations aplicadas, sem lacuna'
\echo '=================================================================='
SELECT version, filename, applied_at
  FROM nexus_migrations.schema_migrations
 ORDER BY version;

\echo ''
\echo 'Totais:'
SELECT count(*) AS aplicadas, min(version) AS menor, max(version) AS maior
  FROM nexus_migrations.schema_migrations;

\echo ''
\echo 'Versoes ausentes (esperado: nenhuma):'
SELECT v AS versao_faltando
  FROM generate_series(1, 8) AS v
 WHERE NOT EXISTS (SELECT 1 FROM nexus_migrations.schema_migrations m WHERE m.version = v);

-- OBRIGATORIO: exatamente 8, versoes 1..8, nenhuma lacuna.
DO $$
DECLARE
  n integer;
  faltando integer[];
BEGIN
  IF to_regclass('nexus_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'FALHA: ledger nexus_migrations.schema_migrations nao existe — nenhuma migration foi aplicada';
  END IF;

  SELECT count(*) INTO n FROM nexus_migrations.schema_migrations;
  IF n <> 8 THEN
    RAISE EXCEPTION 'FALHA: ledger tem % migrations, esperado 8', n;
  END IF;

  SELECT array_agg(v ORDER BY v) INTO faltando
    FROM generate_series(1,8) v
   WHERE NOT EXISTS (SELECT 1 FROM nexus_migrations.schema_migrations m WHERE m.version = v);
  IF faltando IS NOT NULL THEN
    RAISE EXCEPTION 'FALHA: versoes ausentes no ledger: %', faltando;
  END IF;

  IF EXISTS (SELECT 1 FROM nexus_migrations.schema_migrations WHERE version NOT BETWEEN 1 AND 8) THEN
    RAISE EXCEPTION 'FALHA: ledger contem versao fora de 1..8';
  END IF;

  RAISE NOTICE 'OK  ledger: 8 migrations, versoes 1..8, sem lacuna';
END
$$;

\echo ''
\echo '=================================================================='
\echo '2. TABELAS — as 27 do schema nexus'
\echo '=================================================================='
SELECT c.relname AS tabela,
       CASE WHEN c.relrowsecurity AND c.relforcerowsecurity THEN 'FORCE RLS'
            WHEN c.relrowsecurity THEN 'RLS'
            ELSE '-' END AS seguranca
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'nexus' AND c.relkind = 'r'
 ORDER BY c.relname;

\echo ''
\echo 'Totais (esperado: 27 tabelas, 20 com FORCE RLS, 27 com PK):'
SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='nexus' AND c.relkind='r') AS tabelas,
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='nexus' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity) AS force_rls,
       (SELECT count(DISTINCT i.indrelid) FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='nexus' AND i.indisprimary) AS com_pk;

-- OBRIGATORIO: 27 tabelas, 20 com FORCE RLS, 27 com PK.
-- Os numeros vem de bootstrap.sql:22-27 e do conteudo das migrations
-- (16 em 00001 + 1 em 00003 + 3 em 00007 = 20 com FORCE RLS).
DO $$
DECLARE
  tabelas integer;
  force_rls integer;
  com_pk integer;
  sem_rls text[];
BEGIN
  SELECT count(*) INTO tabelas
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='nexus' AND c.relkind='r';
  IF tabelas <> 27 THEN
    RAISE EXCEPTION 'FALHA: schema nexus tem % tabelas, esperado 27', tabelas;
  END IF;

  SELECT count(*) INTO force_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='nexus' AND c.relkind='r'
     AND c.relrowsecurity AND c.relforcerowsecurity;
  IF force_rls <> 20 THEN
    RAISE EXCEPTION 'FALHA: % tabelas com FORCE ROW LEVEL SECURITY, esperado 20', force_rls;
  END IF;

  SELECT count(DISTINCT i.indrelid) INTO com_pk
    FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='nexus' AND i.indisprimary;
  IF com_pk <> 27 THEN
    RAISE EXCEPTION 'FALHA: % tabelas com chave primaria, esperado 27', com_pk;
  END IF;

  -- Toda tabela de dado pessoal precisa estar protegida. Ausencia de FORCE RLS
  -- numa tabela que deveria ter e vazamento entre owners, nao detalhe cosmetico.
  SELECT array_agg(c.relname ORDER BY c.relname) INTO sem_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='nexus' AND c.relkind='r'
     AND c.relname IN ('conversations','conversation_assistants','messages','core_runs',
                       'core_run_assistants','run_steps','run_results','tool_events',
                       'assistant_memories','memory_permissions','memory_permission_audit',
                       'provider_authorizations','global_provider_preferences',
                       'assistant_provider_preferences','conversation_provider_preferences',
                       'sync_cursors','tombstones','tool_grants','tool_grant_audit',
                       'user_assistant_preferences')
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF sem_rls IS NOT NULL THEN
    RAISE EXCEPTION 'FALHA: tabelas de dado pessoal sem FORCE RLS: %', sem_rls;
  END IF;

  RAISE NOTICE 'OK  tabelas: 27 total, 20 com FORCE RLS, 27 com PK';
END
$$;

\echo ''
\echo '=================================================================='
\echo '3. POLICIES de RLS (esperado: 49)'
\echo '=================================================================='
SELECT count(*) AS policies FROM pg_policies WHERE schemaname = 'nexus';

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname='nexus';
  IF n <> 49 THEN
    RAISE EXCEPTION 'FALHA: % policies de RLS, esperado 49', n;
  END IF;
  RAISE NOTICE 'OK  policies: 49';
END
$$;

\echo ''
\echo '=================================================================='
\echo '4. PAPEIS — atributos e memberships'
\echo '=================================================================='
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreatedb, rolcreaterole
  FROM pg_roles
 WHERE rolname IN ('nexus_migrator','nexus_app','nexus_anonymous','nexus_audit_writer')
 ORDER BY rolname;

\echo ''
\echo 'nexus_migrator pode SET ROLE no escritor? (esperado: true)'
SELECT pg_has_role('nexus_migrator', 'nexus_audit_writer', 'SET') AS pode_assumir_escritor;

\echo ''
\echo 'Memberships do escritor (esperado: nenhuma — ele nao herda nada de ninguem):'
SELECT parent.rolname AS membership_indevida
  FROM pg_auth_members am
  JOIN pg_roles child  ON child.oid  = am.member
  JOIN pg_roles parent ON parent.oid = am.roleid
 WHERE child.rolname = 'nexus_audit_writer';

-- OBRIGATORIO: os 4 papeis existem com os atributos documentados.
DO $$
DECLARE
  r record;
  esperados text[] := ARRAY['nexus_migrator','nexus_app','nexus_anonymous','nexus_audit_writer'];
BEGIN
  FOR i IN 1..array_length(esperados,1) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = esperados[i]) THEN
      RAISE EXCEPTION 'FALHA: papel % nao existe', esperados[i];
    END IF;
  END LOOP;

  -- Nenhum deles pode ser superuser ou ter BYPASSRLS. Se algum for, o RLS
  -- deixa de valer para ele e o isolamento entre owners e cosmetico.
  SELECT rolname INTO r FROM pg_roles
   WHERE rolname = ANY (esperados) AND (rolsuper OR rolbypassrls) LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'FALHA: papel % tem SUPERUSER ou BYPASSRLS', r.rolname;
  END IF;

  -- O escritor e NOLOGIN por desenho: nao e credencial de login.
  IF (SELECT rolcanlogin FROM pg_roles WHERE rolname='nexus_audit_writer') THEN
    RAISE EXCEPTION 'FALHA: nexus_audit_writer pode fazer login (deveria ser NOLOGIN)';
  END IF;
  IF (SELECT rolcanlogin FROM pg_roles WHERE rolname='nexus_anonymous') THEN
    RAISE EXCEPTION 'FALHA: nexus_anonymous pode fazer login (deveria ser NOLOGIN)';
  END IF;

  -- O migrator precisa poder assumir o escritor para o ALTER FUNCTION ... OWNER TO da 00007.
  IF NOT pg_has_role('nexus_migrator','nexus_audit_writer','SET') THEN
    RAISE EXCEPTION 'FALHA: nexus_migrator nao pode SET ROLE nexus_audit_writer (a 00007 exige)';
  END IF;

  -- O escritor nao pode ser membro de ninguem: seria leitura ampla por heranca.
  IF EXISTS (
    SELECT 1 FROM pg_auth_members am
      JOIN pg_roles child ON child.oid = am.member
     WHERE child.rolname = 'nexus_audit_writer'
  ) THEN
    RAISE EXCEPTION 'FALHA: nexus_audit_writer e membro de outro papel (heranca indevida)';
  END IF;

  -- nexus_app nunca pode ser membro do escritor: escalada de privilegio
  -- (o escritor tem INSERT na trilha de auditoria).
  IF pg_has_role('nexus_app','nexus_audit_writer','MEMBER') THEN
    RAISE EXCEPTION 'FALHA: nexus_app e membro de nexus_audit_writer (escalada de privilegio)';
  END IF;

  RAISE NOTICE 'OK  papeis: 4 presentes, nenhum com SUPERUSER/BYPASSRLS, sem membership indevida';
END
$$;

\echo ''
\echo '=================================================================='
\echo '5. OWNERSHIP — funcoes SECURITY DEFINER'
\echo '=================================================================='
\echo 'A 00008 depende de record_deleted_entity pertencer a nexus_migrator.'
\echo 'audit_tool_grant_change pertence ao escritor por decisao da 00007.'
\echo ''
SELECT p.proname AS funcao,
       pg_get_userbyid(p.proowner) AS dono,
       p.prosecdef AS security_definer
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'nexus'
   AND p.proname IN ('record_deleted_entity','audit_tool_grant_change',
                     'audit_memory_permission_change','prevent_core_run_identity_mutation',
                     'enforce_tool_grant_lifecycle')
 ORDER BY p.proname;

-- OBRIGATORIO: os donos que a 00007 e a 00008 exigem.
DO $$
DECLARE
  d_owner text;
  a_owner text;
  a_secdef boolean;
BEGIN
  SELECT pg_get_userbyid(proowner), prosecdef INTO d_owner, a_secdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='nexus' AND p.proname='record_deleted_entity';
  IF d_owner IS NULL THEN
    RAISE EXCEPTION 'FALHA: funcao nexus.record_deleted_entity nao existe';
  END IF;
  -- 00008 depende disso: se o dono for outro (por exemplo `postgres`, porque as
  -- migrations rodaram como superuser), a exclusao de owner quebra em runtime.
  IF d_owner <> 'nexus_migrator' THEN
    RAISE EXCEPTION 'FALHA: record_deleted_entity pertence a %, esperado nexus_migrator', d_owner;
  END IF;
  IF NOT a_secdef THEN
    RAISE EXCEPTION 'FALHA: record_deleted_entity nao e SECURITY DEFINER';
  END IF;

  SELECT pg_get_userbyid(proowner) INTO a_owner
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='nexus' AND p.proname='audit_tool_grant_change';
  IF a_owner IS NULL THEN
    RAISE EXCEPTION 'FALHA: funcao nexus.audit_tool_grant_change nao existe';
  END IF;
  IF a_owner <> 'nexus_audit_writer' THEN
    RAISE EXCEPTION 'FALHA: audit_tool_grant_change pertence a %, esperado nexus_audit_writer', a_owner;
  END IF;

  RAISE NOTICE 'OK  ownership: record_deleted_entity -> nexus_migrator, audit_tool_grant_change -> nexus_audit_writer';
END
$$;

\echo ''
\echo '=================================================================='
\echo '6. DADOS — owner unico semeado pela 00001'
\echo '=================================================================='
SELECT id, singleton, created_at FROM nexus.owner_identity;

\echo ''
\echo 'Providers ficticios de teste (esperado: 0 linhas):'
SELECT provider_key FROM nexus.providers WHERE provider_key IN ('test-free','test-paid');

-- OBRIGATORIO: exatamente 1 owner, o id da 00001, e nenhum dado de teste.
DO $$
DECLARE
  n integer;
  oid_atual uuid;
  sing boolean;
  fake integer;
BEGIN
  SELECT count(*) INTO n FROM nexus.owner_identity;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHA: nexus.owner_identity tem % linhas, esperado exatamente 1', n;
  END IF;

  SELECT id, singleton INTO oid_atual, sing FROM nexus.owner_identity;
  IF NOT sing THEN
    RAISE EXCEPTION 'FALHA: owner_identity.singleton = false';
  END IF;
  IF oid_atual <> '00000000-0000-4000-8000-000000000004'::uuid THEN
    RAISE EXCEPTION 'FALHA: owner_identity.id = %, esperado ...0004 (o seed da 00001)', oid_atual;
  END IF;

  -- bootstrap.sql insere estes providers e e fixture de teste. Se aparecerem
  -- aqui, alguem rodou o script de teste em producao.
  SELECT count(*) INTO fake FROM nexus.providers WHERE provider_key IN ('test-free','test-paid');
  IF fake > 0 THEN
    RAISE EXCEPTION 'FALHA: % providers de teste (test-free/test-paid) no banco de producao — bootstrap.sql foi executado', fake;
  END IF;

  RAISE NOTICE 'OK  dados: 1 owner (...0004, singleton), nenhum provider ficticio';
END
$$;

\echo ''
\echo '=================================================================='
\echo '7. nexus_app CONSEGUE OPERAR?'
\echo '=================================================================='
\echo 'Cada tabela e checada na operacao que a API realmente usa:'
\echo '  catalogo (assistants, providers, models, owner_identity) -> somente SELECT'
\echo '  dados do owner (conversations, messages, ...)            -> SELECT+INSERT'
\echo ''
WITH esperado(tabela, precisa_inserir) AS (
  VALUES
    ('assistants', false), ('providers', false), ('models', false),
    ('owner_identity', false), ('assistant_config_versions', false),
    ('conversations', true), ('messages', true), ('core_runs', true),
    ('run_steps', true), ('run_results', true), ('tool_events', true),
    ('assistant_memories', true), ('memory_permissions', true),
    ('conversation_assistants', true), ('core_run_assistants', true),
    ('tool_grants', true), ('user_assistant_preferences', true),
    ('auth_login_state', true), ('revoked_sessions', true),
    ('tombstones', true), ('memory_permission_audit', true)
)
SELECT e.tabela,
       has_table_privilege('nexus_app', 'nexus.' || e.tabela, 'SELECT') AS pode_ler,
       has_table_privilege('nexus_app', 'nexus.' || e.tabela, 'INSERT') AS pode_inserir,
       CASE WHEN has_table_privilege('nexus_app', 'nexus.' || e.tabela, 'SELECT')
                 AND (NOT e.precisa_inserir
                      OR has_table_privilege('nexus_app', 'nexus.' || e.tabela, 'INSERT'))
            THEN 'OK' ELSE 'FALTA GRANT' END AS situacao
  FROM esperado e
 ORDER BY situacao DESC, e.tabela;

\echo ''
\echo 'Privilegio indevido que NAO deve existir (esperado: 0 linhas):'
SELECT 'tool_grant_audit' AS tabela, 'INSERT' AS privilegio_indevido
 WHERE has_table_privilege('nexus_app', 'nexus.tool_grant_audit', 'INSERT');

-- OBRIGATORIO: todo GRANT de runtime presente, e nenhum privilegio a mais.
DO $$
DECLARE
  faltando text[];
  sem_uso text;
BEGIN
  -- O papel de runtime precisa conseguir LER o schema; sem USAGE nada funciona
  -- e a API falharia com "permission denied for schema nexus" em toda rota.
  IF NOT has_schema_privilege('nexus_app','nexus','USAGE') THEN
    RAISE EXCEPTION 'FALHA: nexus_app nao tem USAGE no schema nexus';
  END IF;

  -- Toda tabela do schema precisa ser legivel pela API.
  --
  -- CUIDADO: `has_table_privilege`/`has_sequence_privilege` LEVANTAM erro se o
  -- OID nao for do tipo certo ("pg_toast_N is not a table/sequence"). Um
  -- subselect comum NAO protege: o planejador achata a subconsulta e a funcao
  -- acaba avaliada em linhas de TOAST/index. `MATERIALIZED` cria uma barreira
  -- real de otimizacao e garante que so OIDs validos cheguem a funcao.
  WITH tabs AS MATERIALIZED (
    SELECT c.oid, c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='nexus' AND c.relkind='r'
  )
  SELECT array_agg(t.relname ORDER BY t.relname) INTO faltando
    FROM tabs t
   WHERE NOT has_table_privilege('nexus_app', t.oid, 'SELECT');
  IF faltando IS NOT NULL THEN
    RAISE EXCEPTION 'FALHA: nexus_app nao pode ler: %', faltando;
  END IF;

  -- As tabelas que a API escreve precisam de INSERT.
  SELECT array_agg(t ORDER BY t) INTO faltando
    FROM unnest(ARRAY['conversations','messages','core_runs','run_steps','run_results',
                      'tool_events','assistant_memories','memory_permissions',
                      'conversation_assistants','core_run_assistants','tool_grants',
                      'user_assistant_preferences','auth_login_state','revoked_sessions',
                      'tombstones','memory_permission_audit']) AS t
   WHERE NOT has_table_privilege('nexus_app','nexus.'||t,'INSERT');
  IF faltando IS NOT NULL THEN
    RAISE EXCEPTION 'FALHA: nexus_app nao pode inserir em: %', faltando;
  END IF;

  -- A trilha de autorizacao e append-only por trigger SECURITY DEFINER. Se a
  -- credencial da aplicacao puder escrever nela, a trilha pode ser forjada.
  IF has_table_privilege('nexus_app','nexus.tool_grant_audit','INSERT') THEN
    RAISE EXCEPTION 'FALHA: nexus_app tem INSERT em tool_grant_audit (a trilha pode ser forjada)';
  END IF;
  IF has_table_privilege('nexus_app','nexus.tool_grant_audit','UPDATE') THEN
    RAISE EXCEPTION 'FALHA: nexus_app tem UPDATE em tool_grant_audit (append-only violado)';
  END IF;
  IF has_table_privilege('nexus_app','nexus.tool_grant_audit','DELETE') THEN
    RAISE EXCEPTION 'FALHA: nexus_app tem DELETE em tool_grant_audit (append-only violado)';
  END IF;

  -- O catalogo e somente leitura para a API.
  SELECT array_agg(t ORDER BY t) INTO sem_uso
    FROM unnest(ARRAY['assistants','providers','models','owner_identity']) AS t
   WHERE has_table_privilege('nexus_app','nexus.'||t,'INSERT')
      OR has_table_privilege('nexus_app','nexus.'||t,'UPDATE')
      OR has_table_privilege('nexus_app','nexus.'||t,'DELETE');
  IF sem_uso IS NOT NULL THEN
    RAISE EXCEPTION 'FALHA: nexus_app tem escrita no catalogo (somente leitura): %', sem_uso;
  END IF;

  -- Sequencias: sem USAGE/SELECT o INSERT falha ao pedir nextval.
  -- Mesmo cuidado do bloco de tabelas: a CTE e MATERIALIZED para que a funcao
  -- de privilegio nunca receba OID de TOAST/index.
  IF EXISTS (
    WITH seqs AS MATERIALIZED (
      SELECT c.oid
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='nexus' AND c.relkind='S'
    )
    SELECT 1 FROM seqs WHERE NOT has_sequence_privilege('nexus_app', seqs.oid, 'USAGE')
  ) THEN
    RAISE EXCEPTION 'FALHA: nexus_app sem USAGE em alguma sequencia do schema nexus';
  END IF;

  RAISE NOTICE 'OK  nexus_app: leitura completa, escrita onde precisa, nenhum privilegio a mais';
END
$$;

\echo ''
\echo '=================================================================='
\echo 'VERIFICACAO CONCLUIDA — todos os invariantes obrigatorios passaram'
\echo '=================================================================='
