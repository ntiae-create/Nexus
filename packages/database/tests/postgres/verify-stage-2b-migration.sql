\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM nexus.messages
    WHERE id = '31000000-0000-4000-8000-000000000001'
      AND request_id = id
      AND idempotency_key = 'legacy:' || id::text
      AND content = '[{"type":"text","text":"Legacy message"}]'::jsonb
  ) THEN
    RAISE EXCEPTION 'Legacy message was not preserved and backfilled';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM nexus.conversations
    WHERE id = '21000000-0000-4000-8000-000000000001'
      AND metadata = '{"keep":{"legacy":true}}'::jsonb
  ) OR NOT EXISTS (
    SELECT 1 FROM nexus.conversation_provider_preferences
    WHERE conversation_id = '21000000-0000-4000-8000-000000000001'
      AND selection_mode = 'automatic'
      AND provider_id IS NULL AND model_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Legacy metadata preference was not migrated losslessly';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM nexus.conversations
    WHERE id = '21000000-0000-4000-8000-000000000002'
      AND metadata = '{"keep":"second"}'::jsonb
  ) OR NOT EXISTS (
    SELECT 1 FROM nexus.conversation_provider_preferences
    WHERE conversation_id = '21000000-0000-4000-8000-000000000002'
      AND selection_mode = 'manual'
      AND provider_id = '50100000-0000-4000-8000-000000000001'
      AND model_id = '60100000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'Canonical preference did not win over stale metadata';
  END IF;

  IF (
    SELECT string_agg(assistant_id::text, ',' ORDER BY position)
    FROM nexus.core_run_assistants
    WHERE run_id = '90100000-0000-4000-8000-000000000001'
  ) IS DISTINCT FROM '00000000-0000-4000-8000-000000000001,00000000-0000-4000-8000-000000000002' THEN
    RAISE EXCEPTION 'Legacy run participants were not recovered in order';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM nexus.run_steps
    WHERE id = '92100000-0000-4000-8000-000000000001'
      AND result_id = '93100000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'Legacy step/result link was not recovered';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM nexus.global_provider_preferences
    WHERE owner_id = '00000000-0000-4000-8000-000000000004'
      AND selection_mode = 'automatic'
  ) THEN
    RAISE EXCEPTION 'Concrete global preference default is missing';
  END IF;
END
$$;
