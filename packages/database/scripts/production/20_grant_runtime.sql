-- =============================================================================
-- NEXUS — FASE 3 de 3: permissoes de runtime (nexus_app)
-- =============================================================================
-- Executar como `nexus_migrator`, DEPOIS das 8 migrations, DEPOIS das senhas.
--
-- Por que aqui e nao na fase 1: `GRANT ... ON nexus.conversations` exige que a
-- tabela exista. Na fase 1 o schema `nexus` ainda nao foi criado.
--
-- Fonte: replica os GRANTs de `packages/database/tests/postgres/bootstrap.sql`
-- (linhas 72-98), que e a referencia de privilegios de runtime do projeto, mas
-- SEM o que e exclusivo de teste: a checagem de nome de banco, as contagens
-- exatas, e os providers ficticios `test-free`/`test-paid`.
--
-- Idempotente. O unico REVOKE e na funcao de readiness, para fixar sua ACL
-- minima (sem EXECUTE de PUBLIC e apenas nexus_app como chamador). Nenhum dado
-- de aplicacao e alterado.
-- =============================================================================

\set ON_ERROR_STOP on
\echo '== Fase 3: privilegios de runtime para nexus_app =='

-- O migrator e dono do schema e das tabelas (criou tudo), portanto pode
-- conceder. Se esta secao falhar com "must be owner", as migrations nao foram
-- aplicadas por nexus_migrator — ver MIGRAR_RAILWAY.md, secao de diagnostico.

-- `nexus_anonymous` is NOLOGIN and intentionally receives no access to the
-- private application schema; no runtime path uses that role.
GRANT USAGE ON SCHEMA nexus TO nexus_app;

-- Readiness gets only a boolean from this narrow SECURITY DEFINER boundary.
-- The function is created by nexus_migrator (the controlled owner), fixes its
-- search_path, reads no application data, and fails closed for a missing,
-- inaccessible, malformed, incomplete, or checksum-divergent ledger. Keeping
-- this outside migrations avoids a self-referential checksum for migration 8.
BEGIN;
CREATE OR REPLACE FUNCTION nexus.migration_ledger_ready()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  ledger_matches boolean;
BEGIN
  -- Do not trust an object with the right name but unexpected kind/ownership.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_namespace AS schema_row
      JOIN pg_catalog.pg_class AS ledger_row
        ON ledger_row.relnamespace = schema_row.oid
      JOIN pg_catalog.pg_roles AS schema_owner
        ON schema_owner.oid = schema_row.nspowner
      JOIN pg_catalog.pg_roles AS ledger_owner
        ON ledger_owner.oid = ledger_row.relowner
     WHERE schema_row.nspname = 'nexus_migrations'
       AND schema_owner.rolname = 'nexus_migrator'
       AND ledger_row.relname = 'schema_migrations'
       AND ledger_row.relkind = 'r'
       AND ledger_owner.rolname = 'nexus_migrator'
  ) THEN
    RETURN false;
  END IF;

  -- The migration runner's ledger contract is version integer, immutable
  -- filename, SHA-256 checksum, and application timestamp. Missing or altered
  -- required columns are not a ready schema.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute AS column_row
     WHERE column_row.attrelid = 'nexus_migrations.schema_migrations'::pg_catalog.regclass
       AND column_row.attname = 'version'
       AND column_row.atttypid = 'integer'::pg_catalog.regtype
       AND column_row.attnotnull
       AND column_row.attnum > 0 AND NOT column_row.attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute AS column_row
     WHERE column_row.attrelid = 'nexus_migrations.schema_migrations'::pg_catalog.regclass
       AND column_row.attname = 'filename'
       AND column_row.atttypid = 'text'::pg_catalog.regtype
       AND column_row.attnotnull
       AND column_row.attnum > 0 AND NOT column_row.attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute AS column_row
     WHERE column_row.attrelid = 'nexus_migrations.schema_migrations'::pg_catalog.regclass
       AND column_row.attname = 'checksum'
       AND column_row.atttypid = 'text'::pg_catalog.regtype
       AND column_row.attnotnull
       AND column_row.attnum > 0 AND NOT column_row.attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute AS column_row
     WHERE column_row.attrelid = 'nexus_migrations.schema_migrations'::pg_catalog.regclass
       AND column_row.attname = 'applied_at'
       AND column_row.atttypid = 'timestamp with time zone'::pg_catalog.regtype
       AND column_row.attnotnull
       AND column_row.attnum > 0 AND NOT column_row.attisdropped
  ) THEN
    RETURN false;
  END IF;

  WITH expected(version, filename, checksum) AS (
    VALUES
      (1, '00001_initial_schema.sql', 'ab2f1b662582bdd1e4f3946a32c836dde932ce1f2bd2a7cf4cf365ab5b5aeeb3'),
      (2, '00002_auth_security.sql', '31a52e8d752cd27c3f037d622a03eff490f3810341fcb2e794624b7efa04d28d'),
      (3, '00003_persistence_integrity.sql', '2eb6d374b2b4e1665d62ff0bf77c2b00ae3bce7cc788596b99a56c76a49c7568'),
      (4, '00004_core_execution_hierarchy.sql', '7a86572dc6c7ceec76c424ad709ae824d00d3a5db2afc5512026a15b4bb12014'),
      (5, '00005_assistant_seed_parity.sql', '2b252c5497a2bc4f6252957b4b4669207f8a16973efd66bf9dae55ff16bfeaf8'),
      (6, '00006_assistant_seed_vivy.sql', 'fc50735e37dbd7577d488ab12a193af3af775e31c969fbeaa69bf752e6ad51d2'),
      (7, '00007_tool_grants_and_preferences.sql', 'b5d0f7685b56aac7a1a8403020eb5bff37633fe826e7fdd07176f60fb55f5f60'),
      (8, '00008_owner_deletion_tombstone_guard.sql', 'f7a7d509a5c3d4819d7509b33a4d5b07364ac6fab778d9c75205a78eeb9c48fb')
  )
  SELECT pg_catalog.count(*) = 8
         AND pg_catalog.bool_and(
           expected.version IS NOT NULL
           AND ledger.version IS NOT NULL
           AND ledger.filename IS NOT DISTINCT FROM expected.filename
           AND ledger.checksum IS NOT DISTINCT FROM expected.checksum
         )
    INTO ledger_matches
    FROM expected
    FULL JOIN nexus_migrations.schema_migrations AS ledger
      ON ledger.version = expected.version;

  RETURN COALESCE(ledger_matches, false);
EXCEPTION
  -- Never disclose ledger contents, SQL details, or role/ACL errors to runtime.
  -- A failure is simply not ready; PostgreSQL cancellations still propagate.
  WHEN OTHERS THEN
    RETURN false;
END
$function$;
REVOKE ALL ON FUNCTION nexus.migration_ledger_ready() FROM PUBLIC;
REVOKE ALL ON FUNCTION nexus.migration_ledger_ready() FROM nexus_app;
GRANT EXECUTE ON FUNCTION nexus.migration_ledger_ready() TO nexus_app;
COMMIT;

-- Sessao: revogacao de token e estado de tentativas de login.
-- Sao as duas unicas tabelas de auth, e nenhuma delas tem RLS (medido em
-- 00002_auth_security.sql: nenhum `FORCE ROW LEVEL SECURITY`), por isso
-- funcionam com GRANT e sem contexto de owner.
GRANT SELECT, INSERT, UPDATE, DELETE
   ON nexus.auth_login_state, nexus.revoked_sessions
   TO nexus_app;

-- Catalogo e assistentes: somente leitura.
GRANT SELECT
   ON nexus.owner_identity, nexus.assistants, nexus.assistant_config_versions,
      nexus.providers, nexus.models
   TO nexus_app;

-- Dados do owner. RLS e FORCE: o acesso e filtrado por `nexus.owner_id` em
-- cada transacao, e o GRANT so define o teto de operacoes.
GRANT SELECT, INSERT, UPDATE, DELETE
   ON nexus.conversations, nexus.conversation_assistants, nexus.messages,
      nexus.core_runs, nexus.core_run_assistants, nexus.run_steps,
      nexus.run_results, nexus.tool_events, nexus.assistant_memories,
      nexus.memory_permissions, nexus.provider_authorizations,
      nexus.global_provider_preferences, nexus.assistant_provider_preferences,
      nexus.conversation_provider_preferences, nexus.sync_cursors,
      nexus.tool_grants, nexus.user_assistant_preferences
   TO nexus_app;

-- Trilhas: append-only para a aplicacao.
GRANT SELECT, INSERT
   ON nexus.memory_permission_audit, nexus.tombstones
   TO nexus_app;

-- A trilha de autorizacao de ferramentas e escrita APENAS pelo trigger
-- SECURITY DEFINER da 00007. `nexus_app` recebe somente SELECT, de proposito:
-- a credencial da aplicacao nao pode forjar a propria trilha.
GRANT SELECT ON nexus.tool_grant_audit TO nexus_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA nexus TO nexus_app;

-- Tipos cujo USAGE a 00007 revoga de PUBLIC.
GRANT USAGE ON TYPE nexus.tool_grant_status TO nexus_app;
GRANT USAGE ON TYPE nexus.tool_grant_action TO nexus_app;

\echo '== Fase 3 concluida =='

-- -----------------------------------------------------------------------------
-- Conferencia: toda tabela do schema deve ter algum privilegio para nexus_app.
-- Esperado: 0 linhas. Qualquer linha aqui e uma tabela que a API nao enxerga.
-- -----------------------------------------------------------------------------
\echo ''
\echo '== Tabelas sem privilegio para nexus_app (esperado: 0) =='
SELECT c.relname AS tabela_sem_grant
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'nexus'
   AND c.relkind = 'r'
   AND NOT has_table_privilege('nexus_app', c.oid, 'SELECT')
 ORDER BY c.relname;

\echo ''
\echo '== Total de tabelas no schema nexus (esperado: 27) =='
SELECT count(*) AS total_tabelas
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'nexus' AND c.relkind = 'r';
