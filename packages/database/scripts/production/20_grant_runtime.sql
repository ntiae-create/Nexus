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
-- Idempotente: GRANT repetido nao altera nada e nao erra.
-- Nenhum REVOKE aqui. Nenhum dado alterado.
-- =============================================================================

\set ON_ERROR_STOP on
\echo '== Fase 3: privilegios de runtime para nexus_app =='

-- O migrator e dono do schema e das tabelas (criou tudo), portanto pode
-- conceder. Se esta secao falhar com "must be owner", as migrations nao foram
-- aplicadas por nexus_migrator — ver MIGRAR_RAILWAY.md, secao de diagnostico.

-- `nexus_anonymous` is NOLOGIN and intentionally receives no access to the
-- private application schema; no runtime path uses that role.
GRANT USAGE ON SCHEMA nexus TO nexus_app;

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
