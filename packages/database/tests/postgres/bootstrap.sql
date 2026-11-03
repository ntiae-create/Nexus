\set ON_ERROR_STOP on

DO $$
DECLARE
  table_count integer;
  primary_key_table_count integer;
  protected_table_count integer;
  policy_count integer;
  owner_count integer;
  foreign_key_count integer;
  check_constraint_count integer;
  custom_index_count integer;
BEGIN
  IF current_database() <> 'nexus_test' THEN
    RAISE EXCEPTION 'Expected isolated nexus_test database, got %', current_database();
  END IF;
  IF current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'Expected PostgreSQL 17, got %', current_setting('server_version');
  END IF;
  SELECT count(*) INTO table_count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nexus' AND c.relkind='r';
  IF table_count <> 21 THEN RAISE EXCEPTION 'Expected 21 tables, found %', table_count; END IF;
  SELECT count(DISTINCT i.indrelid) INTO primary_key_table_count FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nexus' AND i.indisprimary;
  IF primary_key_table_count <> 21 THEN RAISE EXCEPTION 'Expected primary keys on all 21 tables, found %', primary_key_table_count; END IF;
  SELECT count(*) INTO protected_table_count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nexus' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity;
  IF protected_table_count <> 16 THEN RAISE EXCEPTION 'Expected RLS on 16 personal-data tables, found %', protected_table_count; END IF;
  SELECT count(*) INTO policy_count FROM pg_policies WHERE schemaname='nexus';
  IF policy_count <> 38 THEN RAISE EXCEPTION 'Expected 38 RLS policies, found %', policy_count; END IF;
  SELECT count(*) INTO foreign_key_count FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='nexus' AND c.contype='f';
  IF foreign_key_count < 40 THEN RAISE EXCEPTION 'Expected semantic and ownership foreign keys, found %', foreign_key_count; END IF;
  SELECT count(*) INTO check_constraint_count FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='nexus' AND c.contype='c';
  IF check_constraint_count < 35 THEN RAISE EXCEPTION 'Expected data integrity checks, found %', check_constraint_count; END IF;
  SELECT count(*) INTO custom_index_count FROM pg_indexes WHERE schemaname='nexus' AND indexname = ANY (ARRAY[
    'conversations_owner_updated_idx', 'conversation_assistants_by_assistant_idx',
    'messages_conversation_sequence_idx', 'messages_owner_created_idx',
    'core_runs_conversation_created_idx', 'core_runs_owner_status_created_idx',
    'run_steps_by_run_order_idx', 'run_results_by_run_created_idx', 'run_results_by_step_idx',
    'tool_events_by_run_time_idx', 'tool_events_by_step_time_idx',
    'assistant_memories_owner_assistant_idx', 'assistant_memories_owner_visibility_idx',
    'memory_permissions_active_lookup_idx', 'memory_permission_audit_item_idx', 'tombstones_owner_sequence_idx'
  ]);
  IF custom_index_count <> 16 THEN RAISE EXCEPTION 'Expected all 16 query indexes, found %', custom_index_count; END IF;
  SELECT count(*) INTO owner_count FROM nexus.owner_identity;
  IF owner_count <> 1 OR NOT (SELECT singleton FROM nexus.owner_identity) THEN
    RAISE EXCEPTION 'Owner identity must be a single singleton row';
  END IF;
  IF to_regclass('nexus.users') IS NOT NULL THEN RAISE EXCEPTION 'Multi-user registration table must not exist'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='nexus' AND column_name='user_id') THEN
    RAISE EXCEPTION 'Multi-user user_id columns must not exist';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nexus_app') THEN RAISE EXCEPTION 'nexus_app unexpectedly exists'; END IF;
END
$$;

SELECT current_setting('server_version') AS postgres_version;
SELECT count(*) AS nexus_table_count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nexus' AND c.relkind='r';
SELECT count(*) AS forced_rls_table_count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nexus' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity;
SELECT count(*) AS nexus_policy_count FROM pg_policies WHERE schemaname='nexus';

CREATE ROLE nexus_app LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
CREATE ROLE nexus_anonymous NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
GRANT CONNECT ON DATABASE nexus_test TO nexus_app;
GRANT USAGE ON SCHEMA nexus TO nexus_app;
GRANT SELECT ON nexus.owner_identity, nexus.assistants, nexus.assistant_config_versions, nexus.providers, nexus.models TO nexus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  nexus.conversations, nexus.conversation_assistants, nexus.messages, nexus.core_runs,
  nexus.run_steps, nexus.run_results, nexus.tool_events, nexus.assistant_memories,
  nexus.memory_permissions, nexus.provider_authorizations, nexus.global_provider_preferences,
  nexus.assistant_provider_preferences, nexus.conversation_provider_preferences, nexus.sync_cursors
TO nexus_app;
GRANT SELECT, INSERT ON nexus.memory_permission_audit, nexus.tombstones TO nexus_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA nexus TO nexus_app;

INSERT INTO nexus.providers (id, provider_key, display_name, availability, cost_status)
VALUES
  ('50000000-0000-4000-8000-000000000001', 'test-free', 'Test Free', 'available', 'free_confirmed'),
  ('50000000-0000-4000-8000-000000000002', 'test-paid', 'Test Paid', 'available', 'paid');
INSERT INTO nexus.models (id, provider_id, model_key, display_name, availability)
VALUES
  ('60000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'free-global', 'Free Global', 'available'),
  ('60000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', 'free-assistant', 'Free Assistant', 'available'),
  ('60000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000001', 'free-conversation', 'Free Conversation', 'available'),
  ('60000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000002', 'paid-model', 'Paid Model', 'available');
