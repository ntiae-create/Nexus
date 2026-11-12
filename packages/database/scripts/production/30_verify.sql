-- =============================================================================
-- NEXUS — verificacao final do banco (somente leitura)
-- =============================================================================
-- Executar como qualquer papel que consiga ler o schema. Nao altera nada.
-- Cada consulta imprime o esperado e o encontrado lado a lado, para que uma
-- divergencia seja visivel sem precisar interpretar numero solto.
--
-- Os valores de referencia vem de medicao neste repositorio:
--   * 27 tabelas  -> bootstrap.sql:22 e 00007 (24 ate 00006 + 3 da 00007)
--   * 20 tabelas com FORCE RLS -> 16 (00001) + 1 (00003) + 3 (00007) + 0 (00008)
--     (00008 tem 1 ocorrencia de FORCE, mas e sobre tabela ja contada)
--   * ledger com 8 linhas, versoes 1..8
-- =============================================================================

\set ON_ERROR_STOP on
\pset footer off

\echo '=================================================================='
\echo '1. LEDGER — quais migrations constam como aplicadas'
\echo '=================================================================='
SELECT version,
       filename,
       applied_at
  FROM nexus_migrations.schema_migrations
 ORDER BY version;

\echo ''
\echo 'Contagem (esperado: 8):'
SELECT count(*) AS aplicadas,
       min(version) AS menor,
       max(version) AS maior,
       bool_and(version BETWEEN 1 AND 8) AS versoes_esperadas
  FROM nexus_migrations.schema_migrations;

-- Lacuna: se alguma versao de 1..8 faltar no ledger, o banco esta meio migrado.
\echo ''
\echo 'Versoes ausentes do ledger (esperado: 0 linhas):'
SELECT v AS versao_faltando
  FROM generate_series(1, 8) AS v
 WHERE NOT EXISTS (
   SELECT 1 FROM nexus_migrations.schema_migrations m WHERE m.version = v
 );

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

\echo ''
\echo '=================================================================='
\echo '3. POLICIES de RLS (esperado: 49)'
\echo '=================================================================='
SELECT count(*) AS policies FROM pg_policies WHERE schemaname = 'nexus';

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
\echo 'nexus_audit_writer tem membership indevida? (esperado: 0 linhas)'
SELECT parent.rolname AS membership_indevida
  FROM pg_auth_members am
  JOIN pg_roles child  ON child.oid  = am.member
  JOIN pg_roles parent ON parent.oid = am.roleid
 WHERE child.rolname = 'nexus_audit_writer';

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

\echo ''
\echo '=================================================================='
\echo '6. DATOS — owner unico semeado pela 00001'
\echo '=================================================================='
\echo 'Esperado: exatamente 1 linha, singleton = true,'
\echo 'id = 00000000-0000-4000-8000-000000000004'
SELECT id, singleton, created_at FROM nexus.owner_identity;

\echo ''
\echo 'Nenhum provider ficticio de teste deve existir (esperado: 0 linhas):'
SELECT provider_key FROM nexus.providers WHERE provider_key IN ('test-free','test-paid');

\echo ''
\echo '=================================================================='
\echo '7. nexus_app CONSEGUE OPERAR? (checagem de privilegio, sem escrever)'
\echo '=================================================================='
\echo 'has_table_privilege responde sem executar a operacao e sem passar por RLS.'
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
\echo 'Esperado: nenhuma linha com situacao = FALTA GRANT.'
\echo ''
\echo 'Privilegio indevido que NAO deve existir (esperado: 0 linhas):'
\echo 'a trilha de autorizacao de ferramentas e append-only por trigger;'
\echo 'a credencial da aplicacao nao pode escrever nela diretamente.'
SELECT 'tool_grant_audit' AS tabela, 'INSERT' AS privilegio_indevido
 WHERE has_table_privilege('nexus_app', 'nexus.tool_grant_audit', 'INSERT');

\echo ''
\echo '=================================================================='
\echo 'VERIFICACAO CONCLUIDA'
\echo '=================================================================='
