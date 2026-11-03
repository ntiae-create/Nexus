\set ON_ERROR_STOP on

DO $$
DECLARE
  is_superuser boolean;
  bypasses_rls boolean;
BEGIN
  IF current_user <> 'nexus_app' OR session_user <> 'nexus_app' THEN
    RAISE EXCEPTION 'Checks must run as nexus_app, current_user=%, session_user=%', current_user, session_user;
  END IF;
  SELECT rolsuper, rolbypassrls INTO is_superuser, bypasses_rls FROM pg_roles WHERE rolname=current_user;
  IF is_superuser OR bypasses_rls THEN RAISE EXCEPTION 'Application role bypasses RLS'; END IF;
  IF (SELECT count(*) FROM nexus.owner_identity) <> 1 THEN RAISE EXCEPTION 'Expected exactly one owner'; END IF;
  IF has_table_privilege(current_user, 'nexus.owner_identity', 'INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Application role can mutate owner identity';
  END IF;
  IF has_schema_privilege('nexus_anonymous', 'nexus', 'USAGE') THEN
    RAISE EXCEPTION 'Anonymous role can access the database schema';
  END IF;
END
$$;

-- No transaction context means no personal rows are visible and writes fail RLS.
DO $$
BEGIN
  IF (SELECT count(*) FROM nexus.conversations) <> 0 THEN RAISE EXCEPTION 'Missing owner context exposed personal data'; END IF;
  BEGIN
    INSERT INTO nexus.conversations (id, owner_id, title)
    VALUES ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004', 'No context');
    RAISE EXCEPTION 'Insert without owner context unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

-- A transaction-local owner context works and clears on commit; same psql session is reused.
BEGIN;
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);
DO $$
BEGIN
  IF nexus.current_owner_id() <> nexus.configured_owner_id() THEN RAISE EXCEPTION 'Owner context mismatch'; END IF;
  INSERT INTO nexus.conversations (id, owner_id, title)
  VALUES ('20000000-0000-4000-8000-000000000001', nexus.current_owner_id(), 'Personal conversation');
  INSERT INTO nexus.conversations (id, owner_id, title)
  VALUES ('20000000-0000-4000-8000-000000000002', nexus.current_owner_id(), 'Second personal conversation');
  INSERT INTO nexus.conversation_assistants (owner_id, conversation_id, assistant_id)
  VALUES (nexus.current_owner_id(), '20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'),
         (nexus.current_owner_id(), '20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'),
         (nexus.current_owner_id(), '20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003');
  INSERT INTO nexus.messages (id, owner_id, conversation_id, sequence, role, status, content, format_version)
  VALUES ('30000000-0000-4000-8000-000000000001', nexus.current_owner_id(), '20000000-0000-4000-8000-000000000001', 1, 'user', 'complete', '[{"type":"text","text":"Hello"}]', 1),
         ('30000000-0000-4000-8000-000000000002', nexus.current_owner_id(), '20000000-0000-4000-8000-000000000002', 1, 'user', 'complete', '[{"type":"text","text":"Other conversation"}]', 1);
  INSERT INTO nexus.core_runs (
    id, owner_id, conversation_id, request_id, idempotency_key, status, input_message_id, format_version
  ) VALUES
    ('90000000-0000-4000-8000-000000000001', nexus.current_owner_id(), '20000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'run-one', 'succeeded', '30000000-0000-4000-8000-000000000001', 1),
    ('90000000-0000-4000-8000-000000000002', nexus.current_owner_id(), '20000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000002', 'run-two', 'succeeded', '30000000-0000-4000-8000-000000000002', 1);
  INSERT INTO nexus.run_steps (
    id, owner_id, run_id, step_order, assistant_id, assistant_config_version, status, objective
  ) VALUES (
    '92000000-0000-4000-8000-000000000001', nexus.current_owner_id(), '90000000-0000-4000-8000-000000000001', 0,
    '00000000-0000-4000-8000-000000000001', '1.0.0', 'succeeded', 'Initial valid step'
  );
  INSERT INTO nexus.assistant_memories (id, owner_id, visibility, origin, origin_assistant_id, content, format_version)
  VALUES ('40000000-0000-4000-8000-000000000001', nexus.current_owner_id(), 'individual', 'test', '00000000-0000-4000-8000-000000000001', 'YUI private memory', 1),
         ('40000000-0000-4000-8000-000000000002', nexus.current_owner_id(), 'shared', 'test', '00000000-0000-4000-8000-000000000001', 'Shared memory', 1);
END
$$;
COMMIT;
DO $$ BEGIN
  IF nexus.current_owner_id() IS NOT NULL OR nexus.current_actor_type() IS NOT NULL THEN RAISE EXCEPTION 'Owner context leaked after commit'; END IF;
END $$;

-- The same singleton identity is used for all devices; no second owner can be created.
BEGIN;
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);
DO $$
DECLARE
  rejected_constraint text;
BEGIN
  BEGIN
    INSERT INTO nexus.owner_identity (singleton, id) VALUES (true, '00000000-0000-4000-8000-000000000005');
    RAISE EXCEPTION 'Application created a second owner';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF (SELECT count(*) FROM nexus.conversations) <> 2 THEN RAISE EXCEPTION 'Owner history was not readable'; END IF;
  IF (SELECT count(*) FROM nexus.messages WHERE conversation_id='20000000-0000-4000-8000-000000000001') <> 1 THEN RAISE EXCEPTION 'Conversation history missing'; END IF;

  -- A run's message reference must belong to the same conversation.
  BEGIN
    SET CONSTRAINTS core_runs_conversation_id_input_message_id_fkey IMMEDIATE;
    INSERT INTO nexus.core_runs (
      id, owner_id, conversation_id, request_id, idempotency_key, status, input_message_id, format_version
    ) VALUES (
      '90000000-0000-4000-8000-000000000003', nexus.current_owner_id(), '20000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000003', 'invalid-cross-conversation', 'queued', '30000000-0000-4000-8000-000000000002', 1
    );
    RAISE EXCEPTION 'Run accepted a message from another conversation';
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS rejected_constraint = CONSTRAINT_NAME;
    IF rejected_constraint <> 'core_runs_conversation_id_input_message_id_fkey' THEN RAISE; END IF;
  END;

  -- A step cannot reference a run that does not exist.
  BEGIN
    INSERT INTO nexus.run_steps (
      id, owner_id, run_id, step_order, assistant_id, assistant_config_version, status, objective
    ) VALUES (
      '92000000-0000-4000-8000-000000000002', nexus.current_owner_id(), '90000000-0000-4000-8000-000000000099', 0,
      '00000000-0000-4000-8000-000000000001', '1.0.0', 'pending', 'Invalid missing run'
    );
    RAISE EXCEPTION 'Step accepted a nonexistent run';
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS rejected_constraint = CONSTRAINT_NAME;
    IF rejected_constraint <> 'run_steps_run_id_fkey' THEN RAISE; END IF;
  END;

  -- A result's step must be part of the same run as the result.
  BEGIN
    INSERT INTO nexus.run_results (id, owner_id, run_id, step_id, status, content, format_version)
    VALUES ('93000000-0000-4000-8000-000000000001', nexus.current_owner_id(), '90000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000001', 'succeeded', '[]', 1);
    RAISE EXCEPTION 'Result accepted a step from another run';
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS rejected_constraint = CONSTRAINT_NAME;
    IF rejected_constraint <> 'run_results_run_id_step_id_fkey' THEN RAISE; END IF;
  END;

  -- A run step cannot pair a provider with a model owned by another provider.
  BEGIN
    INSERT INTO nexus.run_steps (
      id, owner_id, run_id, step_order, assistant_id, assistant_config_version, status, objective, provider_id, model_id
    ) VALUES (
      '92000000-0000-4000-8000-000000000003', nexus.current_owner_id(), '90000000-0000-4000-8000-000000000001', 1,
      '00000000-0000-4000-8000-000000000001', '1.0.0', 'pending', 'Invalid provider/model pair',
      '50000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000004'
    );
    RAISE EXCEPTION 'Run step accepted a model from a different provider';
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS rejected_constraint = CONSTRAINT_NAME;
    IF rejected_constraint <> 'run_steps_provider_id_model_id_fkey' THEN RAISE; END IF;
  END;
END
$$;
-- Scope and transaction-local settings are removed on rollback too.
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
ROLLBACK;
DO $$ BEGIN
  IF nexus.current_owner_id() IS NOT NULL OR nexus.current_actor_type() IS NOT NULL THEN RAISE EXCEPTION 'Owner context leaked after rollback'; END IF;
END $$;

-- A shared item remains hidden from an assistant until its own grant exists.
BEGIN;
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'assistant', true);
SELECT set_config('nexus.assistant_id', '00000000-0000-4000-8000-000000000003', true);
DO $$ BEGIN
  IF (SELECT count(*) FROM nexus.assistant_memories WHERE id='40000000-0000-4000-8000-000000000002') <> 0 THEN
    RAISE EXCEPTION 'Shared memory was visible without an explicit assistant grant';
  END IF;
END $$;
COMMIT;

-- Owner creates an explicit grant and tests preference scopes and authorization.
BEGIN;
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);
DO $$
BEGIN
  INSERT INTO nexus.provider_authorizations (owner_id, provider_id, authorized, paid_use_authorized, authorized_at)
  VALUES (nexus.current_owner_id(), '50000000-0000-4000-8000-000000000001', true, false, now());
  INSERT INTO nexus.memory_permissions (id, owner_id, memory_id, assistant_id, status, granted_by_owner_id, granted_at)
  VALUES ('41000000-0000-4000-8000-000000000001', nexus.current_owner_id(), '40000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'granted', nexus.current_owner_id(), now());
  INSERT INTO nexus.global_provider_preferences (owner_id, selection_mode, provider_id, model_id)
  VALUES (nexus.current_owner_id(), 'manual', '50000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001');
  INSERT INTO nexus.assistant_provider_preferences (owner_id, assistant_id, selection_mode, provider_id, model_id)
  VALUES (nexus.current_owner_id(), '00000000-0000-4000-8000-000000000001', 'manual', '50000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000002');
  INSERT INTO nexus.conversation_provider_preferences (owner_id, conversation_id, selection_mode, provider_id, model_id)
  VALUES (nexus.current_owner_id(), '20000000-0000-4000-8000-000000000001', 'manual', '50000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000003');
  IF (SELECT COALESCE(conversation.model_id, assistant.model_id, gp.model_id)
      FROM nexus.global_provider_preferences AS gp
      LEFT JOIN nexus.assistant_provider_preferences AS assistant ON assistant.assistant_id='00000000-0000-4000-8000-000000000001'
      LEFT JOIN nexus.conversation_provider_preferences AS conversation ON conversation.conversation_id='20000000-0000-4000-8000-000000000001'
      WHERE gp.owner_id=nexus.current_owner_id()) <> '60000000-0000-4000-8000-000000000003'::uuid
  THEN RAISE EXCEPTION 'Conversation preference did not take precedence'; END IF;
  DELETE FROM nexus.conversation_provider_preferences WHERE conversation_id='20000000-0000-4000-8000-000000000001';
  IF (SELECT COALESCE(conversation.model_id, assistant.model_id, gp.model_id)
      FROM nexus.global_provider_preferences AS gp
      LEFT JOIN nexus.assistant_provider_preferences AS assistant ON assistant.assistant_id='00000000-0000-4000-8000-000000000001'
      LEFT JOIN nexus.conversation_provider_preferences AS conversation ON conversation.conversation_id='20000000-0000-4000-8000-000000000001'
      WHERE gp.owner_id=nexus.current_owner_id()) <> '60000000-0000-4000-8000-000000000002'::uuid
  THEN RAISE EXCEPTION 'Assistant preference did not take precedence'; END IF;
  DELETE FROM nexus.assistant_provider_preferences WHERE assistant_id='00000000-0000-4000-8000-000000000001';
  IF (SELECT COALESCE(conversation.model_id, assistant.model_id, gp.model_id)
      FROM nexus.global_provider_preferences AS gp
      LEFT JOIN nexus.assistant_provider_preferences AS assistant ON assistant.assistant_id='00000000-0000-4000-8000-000000000001'
      LEFT JOIN nexus.conversation_provider_preferences AS conversation ON conversation.conversation_id='20000000-0000-4000-8000-000000000001'
      WHERE gp.owner_id=nexus.current_owner_id()) <> '60000000-0000-4000-8000-000000000001'::uuid
  THEN RAISE EXCEPTION 'Global preference fallback failed'; END IF;
  BEGIN
    INSERT INTO nexus.global_provider_preferences (owner_id, selection_mode, provider_id, model_id)
    VALUES (nexus.current_owner_id(), 'manual', '50000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000004');
    RAISE EXCEPTION 'Unknown paid provider was implicitly authorized';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  INSERT INTO nexus.provider_authorizations (owner_id, provider_id, authorized, paid_use_authorized, authorized_at)
  VALUES (nexus.current_owner_id(), '50000000-0000-4000-8000-000000000002', true, true, now());
  UPDATE nexus.global_provider_preferences
  SET provider_id='50000000-0000-4000-8000-000000000002', model_id='60000000-0000-4000-8000-000000000004'
  WHERE owner_id=nexus.current_owner_id();
  IF (SELECT count(*) FROM nexus.memory_permission_audit WHERE memory_id='40000000-0000-4000-8000-000000000002' AND action='granted') <> 1 THEN
    RAISE EXCEPTION 'Grant audit entry missing';
  END IF;
END
$$;
-- Direct audit/tombstone inserts are blocked by trigger-depth policy.
DO $$
BEGIN
  BEGIN
    INSERT INTO nexus.memory_permission_audit (owner_id, permission_id, memory_id, assistant_id, action, actor_owner_id)
    VALUES (nexus.current_owner_id(), '42000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'granted', nexus.current_owner_id());
    RAISE EXCEPTION 'Direct audit insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO nexus.tombstones (id, owner_id, entity_type, entity_id)
    VALUES ('80000000-0000-4000-8000-000000000001', nexus.current_owner_id(), 'memory', '80000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'Direct tombstone insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
COMMIT;

-- The grant opens the shared item only for ALICE; YUI's individual memory is inaccessible to ALICE.
BEGIN;
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'assistant', true);
SELECT set_config('nexus.assistant_id', '00000000-0000-4000-8000-000000000002', true);
DO $$
BEGIN
  IF (SELECT count(*) FROM nexus.assistant_memories WHERE id='40000000-0000-4000-8000-000000000001') <> 0 THEN RAISE EXCEPTION 'Assistant read another assistant individual memory'; END IF;
  IF (SELECT count(*) FROM nexus.assistant_memories WHERE id='40000000-0000-4000-8000-000000000002') <> 1 THEN RAISE EXCEPTION 'Explicit shared-memory grant did not permit read'; END IF;
END
$$;
COMMIT;

-- Revoke as owner: future assistant reads are denied, audit keeps both events.
BEGIN;
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);
UPDATE nexus.memory_permissions SET status='revoked', revoked_by_owner_id=nexus.current_owner_id(), revoked_at=now()
WHERE id='41000000-0000-4000-8000-000000000001';
DO $$ BEGIN
  IF (SELECT count(*) FROM nexus.memory_permission_audit WHERE memory_id='40000000-0000-4000-8000-000000000002') <> 2 THEN RAISE EXCEPTION 'Grant/revoke audit incomplete'; END IF;
END $$;
COMMIT;
BEGIN;
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'assistant', true);
SELECT set_config('nexus.assistant_id', '00000000-0000-4000-8000-000000000002', true);
DO $$ BEGIN
  IF (SELECT count(*) FROM nexus.assistant_memories WHERE id='40000000-0000-4000-8000-000000000002') <> 0 THEN RAISE EXCEPTION 'Revoked grant still permits access'; END IF;
END $$;
COMMIT;

-- A device cursor and deletion tombstone are retained for incremental sync.
BEGIN;
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);
INSERT INTO nexus.sync_cursors (owner_id, device_id, cursor)
VALUES (nexus.current_owner_id(), '70000000-0000-4000-8000-000000000001', 'opaque-cursor'),
       (nexus.current_owner_id(), '70000000-0000-4000-8000-000000000002', 'second-device-cursor');
DELETE FROM nexus.assistant_memories WHERE id='40000000-0000-4000-8000-000000000002';
DO $$
BEGIN
  IF (SELECT count(*) FROM nexus.tombstones WHERE entity_type='memory' AND entity_id='40000000-0000-4000-8000-000000000002') <> 1 THEN RAISE EXCEPTION 'Memory deletion tombstone missing'; END IF;
  IF (SELECT count(*) FROM nexus.memory_permission_audit WHERE memory_id='40000000-0000-4000-8000-000000000002') <> 2 THEN RAISE EXCEPTION 'Permission audit did not survive memory deletion'; END IF;
  IF (SELECT cursor FROM nexus.sync_cursors WHERE device_id='70000000-0000-4000-8000-000000000001') <> 'opaque-cursor' THEN RAISE EXCEPTION 'Sync cursor missing'; END IF;
  IF (SELECT count(*) FROM nexus.sync_cursors WHERE owner_id=nexus.current_owner_id()) <> 2 THEN RAISE EXCEPTION 'Per-device cursors missing'; END IF;
END
$$;
COMMIT;
