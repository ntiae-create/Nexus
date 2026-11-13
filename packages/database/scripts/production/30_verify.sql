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
-- The legacy-ledger adoption path runs this verifier before a checksum column exists.
-- Modern installs require eight valid digests; migrate.sh also compares them to the files.
SELECT EXISTS (
  SELECT 1 FROM pg_attribute
   WHERE attrelid = to_regclass('nexus_migrations.schema_migrations')
     AND attname = 'checksum' AND attnum > 0 AND NOT attisdropped
) AS ledger_has_checksum \gset
\if :ledger_has_checksum
  SELECT version, filename, checksum, applied_at
    FROM nexus_migrations.schema_migrations ORDER BY version;
  DO $$
  BEGIN
    IF (SELECT count(*) FROM nexus_migrations.schema_migrations
         WHERE checksum IS NOT NULL AND checksum ~ '^[0-9a-f]{64}$') <> 8 THEN
      RAISE EXCEPTION 'FALHA: ledger checksum ausente ou formato inválido';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM nexus_migrations.schema_migrations m
        JOIN (VALUES
          (1, '00001_initial_schema.sql'),
          (2, '00002_auth_security.sql'),
          (3, '00003_persistence_integrity.sql'),
          (4, '00004_core_execution_hierarchy.sql'),
          (5, '00005_assistant_seed_parity.sql'),
          (6, '00006_assistant_seed_vivy.sql'),
          (7, '00007_tool_grants_and_preferences.sql'),
          (8, '00008_owner_deletion_tombstone_guard.sql')
        ) expected(version, filename) USING (version)
       WHERE m.filename IS DISTINCT FROM expected.filename
    ) THEN
      RAISE EXCEPTION 'FALHA: ledger filename diverge do contrato 00001-00008';
    END IF;
    RAISE NOTICE 'OK  ledger checksums: oito SHA-256 válidos (comparação do arquivo feita pelo runner)';
  END $$;
\else
  \echo 'Ledger legado sem coluna checksum: verificação estrutural; adoção explícita necessária.'
\endif

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
\echo '3. POLICIES de RLS — conjunto exato das migrations (49)'
\echo '=================================================================='
SELECT count(*) AS policies FROM pg_policies WHERE schemaname = 'nexus';

-- Contrato derivado de CREATE POLICY nas migrations 00001, 00003 e 00007.
-- A lista inclui tabela, nome, comando, permissividade, roles e os dois
-- predicados. Atualizar este contrato junto com uma mudanca intencional de RLS.
DO $$
DECLARE
  total integer;
  ausentes text[];
  alteradas text[];
  inesperadas text[];
BEGIN
  WITH expected_policy(table_name, policy_name, command_name, permissive, role_names, using_kind, check_kind) AS (
    VALUES
      ('assistant_memories', 'assistant_memories_owner_delete', 'DELETE', 'PERMISSIVE', ARRAY['public']::text[], 'owner', NULL::text),
      ('assistant_memories', 'assistant_memories_owner_insert', 'INSERT', 'PERMISSIVE', ARRAY['public']::text[], NULL::text, 'owner'),
      ('assistant_memories', 'assistant_memories_owner_update', 'UPDATE', 'PERMISSIVE', ARRAY['public']::text[], 'owner', 'owner'),
      ('assistant_memories', 'assistant_memories_select_policy', 'SELECT', 'PERMISSIVE', ARRAY['public']::text[], 'assistant_memory', NULL::text),
      ('assistant_provider_preferences', 'assistant_provider_preferences_owner_delete', 'DELETE', 'PERMISSIVE', ARRAY['public']::text[], 'owner', NULL::text),
      ('assistant_provider_preferences', 'assistant_provider_preferences_owner_insert', 'INSERT', 'PERMISSIVE', ARRAY['public']::text[], NULL::text, 'owner'),
      ('assistant_provider_preferences', 'assistant_provider_preferences_owner_update', 'UPDATE', 'PERMISSIVE', ARRAY['public']::text[], 'owner', 'owner'),
      ('assistant_provider_preferences', 'assistant_provider_preferences_select', 'SELECT', 'PERMISSIVE', ARRAY['public']::text[], 'owner_scope', NULL::text),
      ('conversation_assistants', 'conversation_assistants_owner_access', 'ALL', 'PERMISSIVE', ARRAY['public']::text[], 'owner', 'owner'),
      ('conversation_provider_preferences', 'conversation_provider_preferences_owner_delete', 'DELETE', 'PERMISSIVE', ARRAY['public']::text[], 'owner', NULL::text),
      ('conversation_provider_preferences', 'conversation_provider_preferences_owner_insert', 'INSERT', 'PERMISSIVE', ARRAY['public']::text[], NULL::text, 'owner'),
      ('conversation_provider_preferences', 'conversation_provider_preferences_owner_update', 'UPDATE', 'PERMISSIVE', ARRAY['public']::text[], 'owner', 'owner'),
      ('conversation_provider_preferences', 'conversation_provider_preferences_select', 'SELECT', 'PERMISSIVE', ARRAY['public']::text[], 'owner_scope', NULL::text),
      ('conversations', 'conversations_owner_delete', 'DELETE', 'PERMISSIVE', ARRAY['public']::text[], 'owner', NULL::text),
      ('conversations', 'conversations_owner_insert', 'INSERT', 'PERMISSIVE', ARRAY['public']::text[], NULL::text, 'owner'),
      ('conversations', 'conversations_owner_select', 'SELECT', 'PERMISSIVE', ARRAY['public']::text[], 'owner_scope', NULL::text),
      ('conversations', 'conversations_owner_update', 'UPDATE', 'PERMISSIVE', ARRAY['public']::text[], 'owner', 'owner'),
      ('core_run_assistants', 'core_run_assistants_owner_access', 'ALL', 'PERMISSIVE', ARRAY['public']::text[], 'owner', 'owner'),
      ('core_runs', 'core_runs_owner_access', 'ALL', 'PERMISSIVE', ARRAY['public']::text[], 'owner', 'owner'),
      ('global_provider_preferences', 'global_provider_preferences_owner_delete', 'DELETE', 'PERMISSIVE', ARRAY['public']::text[], 'owner', NULL::text),
      ('global_provider_preferences', 'global_provider_preferences_owner_insert', 'INSERT', 'PERMISSIVE', ARRAY['public']::text[], NULL::text, 'owner'),
      ('global_provider_preferences', 'global_provider_preferences_owner_update', 'UPDATE', 'PERMISSIVE', ARRAY['public']::text[], 'owner', 'owner'),
      ('global_provider_preferences', 'global_provider_preferences_select', 'SELECT', 'PERMISSIVE', ARRAY['public']::text[], 'owner_scope', NULL::text),
      ('memory_permission_audit', 'memory_permission_audit_owner_select', 'SELECT', 'PERMISSIVE', ARRAY['public']::text[], 'owner', NULL::text),
      ('memory_permission_audit', 'memory_permission_audit_trigger_insert', 'INSERT', 'PERMISSIVE', ARRAY['public']::text[], NULL::text, 'trigger_owner'),
      ('memory_permissions', 'memory_permissions_owner_insert', 'INSERT', 'PERMISSIVE', ARRAY['public']::text[], NULL::text, 'owner'),
      ('memory_permissions', 'memory_permissions_owner_update', 'UPDATE', 'PERMISSIVE', ARRAY['public']::text[], 'owner', 'owner'),
      ('memory_permissions', 'memory_permissions_select_policy', 'SELECT', 'PERMISSIVE', ARRAY['public']::text[], 'owner_or_assistant', NULL::text),
      ('messages', 'messages_owner_access', 'ALL', 'PERMISSIVE', ARRAY['public']::text[], 'owner', 'owner'),
      ('provider_authorizations', 'provider_authorizations_owner_delete', 'DELETE', 'PERMISSIVE', ARRAY['public']::text[], 'owner', NULL::text),
      ('provider_authorizations', 'provider_authorizations_owner_insert', 'INSERT', 'PERMISSIVE', ARRAY['public']::text[], NULL::text, 'owner'),
      ('provider_authorizations', 'provider_authorizations_owner_update', 'UPDATE', 'PERMISSIVE', ARRAY['public']::text[], 'owner', 'owner'),
      ('provider_authorizations', 'provider_authorizations_select', 'SELECT', 'PERMISSIVE', ARRAY['public']::text[], 'owner_scope', NULL::text),
      ('run_results', 'run_results_owner_access', 'ALL', 'PERMISSIVE', ARRAY['public']::text[], 'owner', 'owner'),
      ('run_steps', 'run_steps_owner_access', 'ALL', 'PERMISSIVE', ARRAY['public']::text[], 'owner', 'owner'),
      ('sync_cursors', 'sync_cursors_owner_access', 'ALL', 'PERMISSIVE', ARRAY['public']::text[], 'owner', 'owner'),
      ('tombstones', 'tombstones_owner_select', 'SELECT', 'PERMISSIVE', ARRAY['public']::text[], 'owner', NULL::text),
      ('tombstones', 'tombstones_trigger_insert', 'INSERT', 'PERMISSIVE', ARRAY['public']::text[], NULL::text, 'trigger_owner'),
      ('tool_events', 'tool_events_owner_access', 'ALL', 'PERMISSIVE', ARRAY['public']::text[], 'owner', 'owner'),
      ('tool_grant_audit', 'tool_grant_audit_owner_select', 'SELECT', 'PERMISSIVE', ARRAY['public']::text[], 'owner', NULL::text),
      ('tool_grant_audit', 'tool_grant_audit_writer_insert', 'INSERT', 'PERMISSIVE', ARRAY['nexus_audit_writer']::text[], NULL::text, 'audit_owner'),
      ('tool_grants', 'tool_grants_owner_delete', 'DELETE', 'PERMISSIVE', ARRAY['public']::text[], 'owner', NULL::text),
      ('tool_grants', 'tool_grants_owner_insert', 'INSERT', 'PERMISSIVE', ARRAY['public']::text[], NULL::text, 'owner'),
      ('tool_grants', 'tool_grants_owner_select', 'SELECT', 'PERMISSIVE', ARRAY['public']::text[], 'owner', NULL::text),
      ('tool_grants', 'tool_grants_owner_update', 'UPDATE', 'PERMISSIVE', ARRAY['public']::text[], 'owner', 'owner'),
      ('user_assistant_preferences', 'user_assistant_preferences_owner_delete', 'DELETE', 'PERMISSIVE', ARRAY['public']::text[], 'owner', NULL::text),
      ('user_assistant_preferences', 'user_assistant_preferences_owner_insert', 'INSERT', 'PERMISSIVE', ARRAY['public']::text[], NULL::text, 'owner'),
      ('user_assistant_preferences', 'user_assistant_preferences_owner_update', 'UPDATE', 'PERMISSIVE', ARRAY['public']::text[], 'owner', 'owner'),
      ('user_assistant_preferences', 'user_assistant_preferences_select', 'SELECT', 'PERMISSIVE', ARRAY['public']::text[], 'owner_scope', NULL::text)
  ),
  expression_contract(kind, expression) AS (
    VALUES
      ('owner', $expr$((owner_id = nexus.current_owner_id()) AND (owner_id = nexus.configured_owner_id()) AND (nexus.current_actor_type() = 'owner'::text))$expr$),
      ('owner_scope', $expr$((owner_id = nexus.current_owner_id()) AND (owner_id = nexus.configured_owner_id()))$expr$),
      ('owner_or_assistant', $expr$((owner_id = nexus.current_owner_id()) AND (owner_id = nexus.configured_owner_id()) AND ((nexus.current_actor_type() = 'owner'::text) OR ((nexus.current_actor_type() = 'assistant'::text) AND (assistant_id = nexus.current_assistant_id()))))$expr$),
      ('assistant_memory', $expr$((owner_id = nexus.current_owner_id()) AND (owner_id = nexus.configured_owner_id()) AND ((nexus.current_actor_type() = 'owner'::text) OR ((nexus.current_actor_type() = 'assistant'::text) AND (status = 'active'::text) AND (((visibility = 'individual'::nexus.memory_visibility) AND (origin_assistant_id = nexus.current_assistant_id())) OR ((visibility = 'shared'::nexus.memory_visibility) AND (EXISTS ( SELECT 1 FROM nexus.memory_permissions permission WHERE ((permission.owner_id = assistant_memories.owner_id) AND (permission.memory_id = assistant_memories.id) AND (permission.assistant_id = nexus.current_assistant_id()) AND (permission.status = 'granted'::nexus.memory_permission_status)))))))))$expr$),
      ('trigger_owner', $expr$((owner_id = nexus.current_owner_id()) AND (owner_id = nexus.configured_owner_id()) AND (nexus.current_actor_type() = 'owner'::text) AND (pg_trigger_depth() > 0))$expr$),
      ('audit_owner', $expr$((nexus.current_owner_id() IS NOT NULL) AND (nexus.configured_owner_id() IS NOT NULL) AND (owner_id = nexus.current_owner_id()) AND (owner_id = nexus.configured_owner_id()) AND (actor_owner_id = owner_id))$expr$)
  ),
  expected AS (
    SELECT e.table_name, e.policy_name, e.command_name, e.permissive, e.role_names,
           CASE WHEN u.expression IS NULL THEN NULL
                ELSE regexp_replace(u.expression, '[[:space:]]+', ' ', 'g') END AS qual,
           CASE WHEN c.expression IS NULL THEN NULL
                ELSE regexp_replace(c.expression, '[[:space:]]+', ' ', 'g') END AS with_check
      FROM expected_policy e
      LEFT JOIN expression_contract u ON u.kind = e.using_kind
      LEFT JOIN expression_contract c ON c.kind = e.check_kind
  ),
  actual AS (
    SELECT p.tablename AS table_name, p.policyname AS policy_name,
           p.cmd AS command_name, p.permissive,
           ARRAY(SELECT r::text FROM unnest(p.roles) AS r ORDER BY r::text) AS role_names,
           CASE WHEN p.qual IS NULL THEN NULL
                ELSE regexp_replace(p.qual, '[[:space:]]+', ' ', 'g') END AS qual,
           CASE WHEN p.with_check IS NULL THEN NULL
                ELSE regexp_replace(p.with_check, '[[:space:]]+', ' ', 'g') END AS with_check
      FROM pg_policies p
     WHERE p.schemaname = 'nexus'
  )
  SELECT
    COALESCE((
      SELECT array_agg(format('%I.%I', e.table_name, e.policy_name) ORDER BY e.table_name, e.policy_name)
        FROM expected e
       WHERE NOT EXISTS (SELECT 1 FROM actual a WHERE a.table_name=e.table_name AND a.policy_name=e.policy_name)
    ), ARRAY[]::text[]),
    COALESCE((
      SELECT array_agg(
               format('%I.%I (%s)', e.table_name, e.policy_name,
                 array_to_string(ARRAY_REMOVE(ARRAY[
                   CASE WHEN a.command_name IS DISTINCT FROM e.command_name THEN 'cmd' END,
                   CASE WHEN a.permissive IS DISTINCT FROM e.permissive THEN 'permissive' END,
                   CASE WHEN a.role_names IS DISTINCT FROM e.role_names THEN 'roles' END,
                   CASE WHEN a.qual IS DISTINCT FROM e.qual THEN 'USING' END,
                   CASE WHEN a.with_check IS DISTINCT FROM e.with_check THEN 'WITH CHECK' END
                 ], NULL), ', ')
               ) ORDER BY e.table_name, e.policy_name
             )
        FROM expected e
        JOIN actual a ON a.table_name=e.table_name AND a.policy_name=e.policy_name
       WHERE a.command_name IS DISTINCT FROM e.command_name
          OR a.permissive IS DISTINCT FROM e.permissive
          OR a.role_names IS DISTINCT FROM e.role_names
          OR a.qual IS DISTINCT FROM e.qual
          OR a.with_check IS DISTINCT FROM e.with_check
    ), ARRAY[]::text[]),
    COALESCE((
      SELECT array_agg(format('%I.%I', a.table_name, a.policy_name) ORDER BY a.table_name, a.policy_name)
        FROM actual a
       WHERE NOT EXISTS (SELECT 1 FROM expected e WHERE e.table_name=a.table_name AND e.policy_name=a.policy_name)
    ), ARRAY[]::text[])
  INTO ausentes, alteradas, inesperadas;

  SELECT count(*) INTO total FROM pg_policies WHERE schemaname='nexus';
  IF total <> 49 THEN
    RAISE EXCEPTION 'FALHA: % policies de RLS, esperado 49 (ausentes: %, alteradas: %, inesperadas: %)',
      total, ausentes, alteradas, inesperadas;
  END IF;
  IF cardinality(ausentes) > 0 OR cardinality(alteradas) > 0 OR cardinality(inesperadas) > 0 THEN
    RAISE EXCEPTION 'FALHA: conjunto de policies divergente (ausentes: %, alteradas: %, inesperadas: %)',
      ausentes, alteradas, inesperadas;
  END IF;

  RAISE NOTICE 'OK  policies: 49; conjunto completo das migrations (tabela/nome/cmd/roles/USING/WITH CHECK)';
END
$$;

\echo ''
\echo '=================================================================='
\echo '4. PAPEIS — atributos e memberships'
\echo '=================================================================='
SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit, rolreplication
  FROM pg_roles
 WHERE rolname IN ('nexus_migrator','nexus_app','nexus_anonymous','nexus_audit_writer')
 ORDER BY rolname;

\echo ''
\echo 'nexus_migrator pode SET ROLE no escritor? (esperado: true)'
SELECT pg_has_role('nexus_migrator', 'nexus_audit_writer', 'SET') AS pode_assumir_escritor;

\echo ''
\echo 'nexus_migrator herda privilegios do escritor? (esperado: false)'
SELECT pg_has_role('nexus_migrator', 'nexus_audit_writer', 'USAGE') AS herda_escritor;

\echo ''
\echo 'Memberships que tocam os quatro papeis (esperado: apenas nexus_migrator -> nexus_audit_writer; admins superuser nao ganham privilegio adicional):'
SELECT child.rolname AS membro, parent.rolname AS papel,
       am.admin_option, am.inherit_option, am.set_option
  FROM pg_auth_members am
  JOIN pg_roles child  ON child.oid  = am.member
  JOIN pg_roles parent ON parent.oid = am.roleid
 WHERE child.rolname IN ('nexus_migrator','nexus_app','nexus_audit_writer','nexus_anonymous')
    OR parent.rolname IN ('nexus_migrator','nexus_app','nexus_audit_writer','nexus_anonymous')
 ORDER BY child.rolname, parent.rolname;

\echo ''
\echo 'Memberships do escritor como membro (esperado: nenhuma):'
SELECT parent.rolname AS membership_indevida,
       am.admin_option, am.inherit_option, am.set_option
  FROM pg_auth_members am
  JOIN pg_roles child  ON child.oid  = am.member
  JOIN pg_roles parent ON parent.oid = am.roleid
 WHERE child.rolname = 'nexus_audit_writer';

-- OBRIGATORIO: atributos completos e topologia exata de memberships dos quatro papeis.
DO $$
DECLARE
  esperado record;
  atual record;
  roles_verificados text[] := ARRAY['nexus_migrator','nexus_app','nexus_audit_writer','nexus_anonymous'];
  memberships_indevidas text[];
BEGIN
  FOR esperado IN
    SELECT * FROM (VALUES
      ('nexus_migrator'::text, true,  false, false, false, false, false, false),
      ('nexus_app'::text,      true,  false, false, false, false, false, false),
      ('nexus_audit_writer'::text, false, false, false, false, false, false, false),
      ('nexus_anonymous'::text,    false, false, false, false, false, false, false)
    ) AS v(rolname, canlogin, superuser, bypassrls, createdb, createrole, inherit, replication)
  LOOP
    SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit, rolreplication
      INTO atual FROM pg_roles WHERE rolname = esperado.rolname;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'FALHA: papel % nao existe', esperado.rolname;
    END IF;

    -- Mantem o diagnostico de seguranca existente para estes dois atributos.
    IF atual.rolsuper OR atual.rolbypassrls THEN
      RAISE EXCEPTION 'FALHA: papel % tem SUPERUSER ou BYPASSRLS', atual.rolname;
    END IF;
    -- E preservado tambem o diagnostico explicito anterior para os papeis NOLOGIN.
    IF atual.rolname = 'nexus_audit_writer' AND atual.rolcanlogin THEN
      RAISE EXCEPTION 'FALHA: nexus_audit_writer pode fazer login (deveria ser NOLOGIN)';
    END IF;
    IF atual.rolname = 'nexus_anonymous' AND atual.rolcanlogin THEN
      RAISE EXCEPTION 'FALHA: nexus_anonymous pode fazer login (deveria ser NOLOGIN)';
    END IF;

    IF ROW(atual.rolcanlogin, atual.rolsuper, atual.rolbypassrls,
           atual.rolcreatedb, atual.rolcreaterole, atual.rolinherit, atual.rolreplication)
       IS DISTINCT FROM
       ROW(esperado.canlogin, esperado.superuser, esperado.bypassrls,
           esperado.createdb, esperado.createrole, esperado.inherit, esperado.replication) THEN
      RAISE EXCEPTION
        'FALHA: papel % tem atributos divergentes (LOGIN=%, SUPERUSER=%, BYPASSRLS=%, CREATEDB=%, CREATEROLE=%, INHERIT=%, REPLICATION=%); esperado (LOGIN=%, SUPERUSER=%, BYPASSRLS=%, CREATEDB=%, CREATEROLE=%, INHERIT=%, REPLICATION=%)',
        atual.rolname, atual.rolcanlogin, atual.rolsuper, atual.rolbypassrls,
        atual.rolcreatedb, atual.rolcreaterole, atual.rolinherit, atual.rolreplication,
        esperado.canlogin, esperado.superuser, esperado.bypassrls,
        esperado.createdb, esperado.createrole, esperado.inherit, esperado.replication;
    END IF;
  END LOOP;

  IF has_schema_privilege('nexus_anonymous', 'nexus', 'USAGE') THEN
    RAISE EXCEPTION 'FALHA: nexus_anonymous tem USAGE no schema nexus';
  END IF;

  -- O migrator precisa assumir o escritor para o ALTER FUNCTION ... OWNER TO da 00007.
  IF NOT pg_has_role('nexus_migrator','nexus_audit_writer','SET') THEN
    RAISE EXCEPTION 'FALHA: nexus_migrator nao pode SET ROLE nexus_audit_writer (a 00007 exige)';
  END IF;
  IF pg_has_role('nexus_migrator','nexus_audit_writer','USAGE') THEN
    RAISE EXCEPTION 'FALHA: nexus_migrator herda privilegios de nexus_audit_writer';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_auth_members am
      JOIN pg_roles child  ON child.oid=am.member
      JOIN pg_roles parent ON parent.oid=am.roleid
     WHERE child.rolname='nexus_migrator' AND parent.rolname='nexus_audit_writer'
       AND am.set_option AND NOT am.inherit_option AND NOT am.admin_option
  ) THEN
    RAISE EXCEPTION 'FALHA: membership nexus_migrator -> nexus_audit_writer deve ter SET=true, INHERIT=false e ADMIN=false';
  END IF;

  -- O escritor nao pode ser assumido por nexus_app, nem receber outros membros
  -- nao-superuser; ambos criariam escalada para o INSERT da trilha de auditoria.
  IF pg_has_role('nexus_app','nexus_audit_writer','MEMBER') THEN
    RAISE EXCEPTION 'FALHA: nexus_app e membro de nexus_audit_writer (escalada de privilegio)';
  END IF;

  -- So a aresta acima e permitida. Isso tambem impede nexus_app de entrar em
  -- papeis adicionais, o escritor de herdar de terceiros, mudancas nas opcoes
  -- (ADMIN/INHERIT/SET) e qualquer relacao inesperada entre os quatro papeis.
  -- Um superuser externo ja tem acesso irrestrito sem membership; sua aresta nao
  -- adiciona privilegio e e ignorada (por exemplo, postgres -> papel audit).
  SELECT array_agg(
           format('%s -> %s [ADMIN=%s, INHERIT=%s, SET=%s]',
                  child.rolname, parent.rolname,
                  am.admin_option, am.inherit_option, am.set_option)
           ORDER BY child.rolname, parent.rolname
         )
    INTO memberships_indevidas
    FROM pg_auth_members am
    JOIN pg_roles child  ON child.oid=am.member
    JOIN pg_roles parent ON parent.oid=am.roleid
   WHERE (child.rolname = ANY(roles_verificados) OR parent.rolname = ANY(roles_verificados))
     AND NOT (
       child.rolname='nexus_migrator' AND parent.rolname='nexus_audit_writer'
       AND am.set_option AND NOT am.inherit_option AND NOT am.admin_option
     )
     AND NOT (child.rolsuper AND NOT (child.rolname = ANY(roles_verificados)));
  IF memberships_indevidas IS NOT NULL THEN
    RAISE EXCEPTION 'FALHA: memberships inesperadas ou com opcoes indevidas: %', memberships_indevidas;
  END IF;

  RAISE NOTICE 'OK  papeis: atributos completos dos 4 papeis; apenas migrator -> escritor (SET sem heranca), sem membership inesperada';
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
\echo '8. ALLOWLIST EFETIVA — PUBLIC, memberships, ownership e ACLs'
\echo '=================================================================='
\set NEXUS_REQUIRE_APP_GRANTS true
\ir assert_app_privileges.sql

-- A migration role owns objects it created; the audit SECURITY DEFINER alone
-- is transferred to nexus_audit_writer. The runtime login must own none.
DO $$
DECLARE
  migrator_oid oid;
  audit_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_roles WHERE rolname = 'nexus_migrator';
  SELECT oid INTO audit_oid FROM pg_roles WHERE rolname = 'nexus_audit_writer';
  IF migrator_oid IS NULL OR audit_oid IS NULL THEN
    RAISE EXCEPTION 'FALHA: papéis de ownership ausentes';
  END IF;
  IF (SELECT nspowner FROM pg_namespace WHERE nspname = 'nexus') <> migrator_oid THEN
    RAISE EXCEPTION 'FALHA: schema nexus não pertence a nexus_migrator';
  END IF;
  IF (SELECT nspowner FROM pg_namespace WHERE nspname = 'nexus_migrations') <> migrator_oid THEN
    RAISE EXCEPTION 'FALHA: schema nexus_migrations não pertence a nexus_migrator';
  END IF;
  IF (SELECT relowner FROM pg_class WHERE oid = 'nexus_migrations.schema_migrations'::regclass) <> migrator_oid THEN
    RAISE EXCEPTION 'FALHA: ledger não pertence a nexus_migrator';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'nexus' AND c.relkind IN ('r','p','v','m','f','S')
       AND c.relowner <> migrator_oid
  ) THEN
    RAISE EXCEPTION 'FALHA: tabela/sequência em nexus com ownership inesperado';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'nexus' AND t.typtype IN ('e','d','r','m')
       AND t.typowner <> migrator_oid
  ) THEN
    RAISE EXCEPTION 'FALHA: tipo em nexus com ownership inesperado';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'nexus'
       AND ((p.proname = 'audit_tool_grant_change' AND p.proowner <> audit_oid)
         OR (p.proname <> 'audit_tool_grant_change' AND p.proowner <> migrator_oid))
  ) THEN
    RAISE EXCEPTION 'FALHA: função em nexus com ownership inesperado';
  END IF;
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'nexus' AND c.relkind = 'S') <> 3 THEN
    RAISE EXCEPTION 'FALHA: número de sequências divergente (esperado 3)';
  END IF;
  RAISE NOTICE 'OK  ownership: schema, tabelas, sequências, tipos e funções conforme contrato';
END
$$;

\echo ''
\echo '=================================================================='
\echo 'VERIFICACAO CONCLUIDA — todos os invariantes obrigatorios passaram'
\echo '=================================================================='
