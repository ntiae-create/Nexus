-- Etapa 2B: idempotent messages, complete executions, canonical preferences.
-- Additive migration: 00001 and 00002 remain immutable.
BEGIN;

ALTER TABLE nexus.messages
  ADD COLUMN request_id uuid,
  ADD COLUMN idempotency_key text;

UPDATE nexus.messages
SET request_id = id,
    idempotency_key = 'legacy:' || id::text
WHERE request_id IS NULL OR idempotency_key IS NULL;

ALTER TABLE nexus.messages
  ALTER COLUMN request_id SET NOT NULL,
  ALTER COLUMN idempotency_key SET NOT NULL,
  ADD CONSTRAINT messages_idempotency_key_length
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  ADD CONSTRAINT messages_conversation_idempotency_key_key
    UNIQUE (conversation_id, idempotency_key),
  ADD CONSTRAINT messages_conversation_request_id_key
    UNIQUE (conversation_id, request_id);

CREATE INDEX messages_owner_idempotency_idx
  ON nexus.messages (owner_id, conversation_id, idempotency_key);

CREATE TABLE nexus.core_run_assistants (
  owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  assistant_id uuid NOT NULL REFERENCES nexus.assistants(id) ON DELETE RESTRICT,
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (run_id, position),
  FOREIGN KEY (run_id) REFERENCES nexus.core_runs(id) ON DELETE CASCADE
);
CREATE INDEX core_run_assistants_by_assistant_idx
  ON nexus.core_run_assistants (owner_id, assistant_id, run_id);

-- Recover participant data that was available in legacy traces and steps.
WITH sourced AS (
  SELECT
    run.owner_id,
    run.id AS run_id,
    assistant.id AS assistant_id,
    trace_entry.ordinality - 1 AS source_position,
    0 AS source_kind
  FROM nexus.core_runs AS run
  CROSS JOIN LATERAL jsonb_array_elements(run.trace) WITH ORDINALITY AS trace_entry(value, ordinality)
  JOIN nexus.assistants AS assistant
    ON assistant.id = CASE
      WHEN (trace_entry.value->>'assistantId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (trace_entry.value->>'assistantId')::uuid
    END
  WHERE jsonb_typeof(run.trace) = 'array'
    AND jsonb_typeof(trace_entry.value) = 'object'

  UNION ALL

  SELECT step.owner_id, step.run_id, step.assistant_id, step.step_order, 1
  FROM nexus.run_steps AS step
), deduplicated AS (
  SELECT DISTINCT ON (run_id, assistant_id)
    owner_id, run_id, assistant_id, source_position, source_kind
  FROM sourced
  ORDER BY run_id, assistant_id, source_kind, source_position
)
INSERT INTO nexus.core_run_assistants (owner_id, run_id, assistant_id, position)
SELECT
  owner_id,
  run_id,
  assistant_id,
  (row_number() OVER (
    PARTITION BY run_id ORDER BY source_kind, source_position, assistant_id
  ) - 1)::integer AS position
FROM deduplicated;

ALTER TABLE nexus.run_steps
  ADD COLUMN result_id uuid;

UPDATE nexus.run_steps AS step
SET result_id = linked.result_id
FROM (
  SELECT DISTINCT ON (run_id, step_id)
    run_id, step_id, id AS result_id
  FROM nexus.run_results
  WHERE step_id IS NOT NULL
  ORDER BY run_id, step_id, created_at, id
) AS linked
WHERE step.run_id = linked.run_id
  AND step.id = linked.step_id;

ALTER TABLE nexus.run_results
  ADD CONSTRAINT run_results_run_id_id_key UNIQUE (run_id, id);
ALTER TABLE nexus.run_steps
  ADD CONSTRAINT run_steps_run_id_result_id_fkey
    FOREIGN KEY (run_id, result_id)
    REFERENCES nexus.run_results(run_id, id)
    ON DELETE SET NULL (result_id) DEFERRABLE INITIALLY DEFERRED;

-- A concrete global default avoids manufacturing a different updatedAt on reads.
INSERT INTO nexus.global_provider_preferences (owner_id, selection_mode)
SELECT id, 'automatic'
FROM nexus.owner_identity
WHERE singleton = true
ON CONFLICT (owner_id) DO NOTHING;

-- Fail loudly instead of discarding malformed legacy preference metadata.
DO $$
DECLARE
  invalid_preferences integer;
BEGIN
  SELECT count(*)
  INTO invalid_preferences
  FROM nexus.conversations AS conversation
  WHERE conversation.metadata ? 'providerPreference'
    AND NOT (
      jsonb_typeof(conversation.metadata->'providerPreference') = 'object'
      AND (
        conversation.metadata->'providerPreference'->>'mode' = 'automatic'
        OR (
          conversation.metadata->'providerPreference'->>'mode' = 'manual'
          AND (conversation.metadata->'providerPreference'->>'providerId') ~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND (conversation.metadata->'providerPreference'->>'modelId') ~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        )
      )
    );

  IF invalid_preferences > 0 THEN
    RAISE EXCEPTION 'Cannot migrate % malformed conversation provider preference(s)', invalid_preferences;
  END IF;
END
$$;

INSERT INTO nexus.conversation_provider_preferences (
  owner_id, conversation_id, selection_mode, provider_id, model_id
)
SELECT
  conversation.owner_id,
  conversation.id,
  CASE
    WHEN conversation.metadata->'providerPreference'->>'mode' = 'manual'
      THEN 'manual'::nexus.provider_selection_mode
    ELSE 'automatic'::nexus.provider_selection_mode
  END,
  (conversation.metadata->'providerPreference'->>'providerId')::uuid,
  (conversation.metadata->'providerPreference'->>'modelId')::uuid
FROM nexus.conversations AS conversation
WHERE conversation.metadata ? 'providerPreference'
ON CONFLICT (conversation_id) DO NOTHING;

-- Preference tables are the sole canonical store; metadata retains unrelated fields.
UPDATE nexus.conversations
SET metadata = metadata - 'providerPreference'
WHERE metadata ? 'providerPreference';

ALTER TABLE nexus.core_run_assistants ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.core_run_assistants FORCE ROW LEVEL SECURITY;
CREATE POLICY core_run_assistants_owner_access ON nexus.core_run_assistants
  USING (
    owner_id = nexus.current_owner_id()
    AND owner_id = nexus.configured_owner_id()
    AND nexus.current_actor_type() = 'owner'
  )
  WITH CHECK (
    owner_id = nexus.current_owner_id()
    AND owner_id = nexus.configured_owner_id()
    AND nexus.current_actor_type() = 'owner'
  );

REVOKE ALL ON nexus.core_run_assistants FROM PUBLIC;

COMMIT;
