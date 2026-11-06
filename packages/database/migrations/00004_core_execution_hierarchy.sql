-- Etapa 3B: NEXUS CORE parent-child execution hierarchy and delegation lineage.
-- Additive migration: 00001, 00002, and 00003 remain immutable.
BEGIN;

ALTER TABLE nexus.core_runs
  ADD COLUMN parent_run_id uuid,
  ADD COLUMN parent_step_id uuid,
  ADD COLUMN delegation_depth integer NOT NULL DEFAULT 0 CHECK (delegation_depth >= 0);

ALTER TABLE nexus.core_runs
  ADD CONSTRAINT core_runs_parent_run_same_conversation_fk
    FOREIGN KEY (conversation_id, parent_run_id)
    REFERENCES nexus.core_runs(conversation_id, id)
    ON DELETE CASCADE,
  ADD CONSTRAINT core_runs_parent_step_same_parent_run_fk
    FOREIGN KEY (parent_run_id, parent_step_id)
    REFERENCES nexus.run_steps(run_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT core_runs_delegation_hierarchy_valid
    CHECK (
      (parent_run_id IS NULL AND parent_step_id IS NULL AND delegation_depth = 0)
      OR (
        parent_run_id IS NOT NULL
        AND parent_step_id IS NOT NULL
        AND delegation_depth > 0
        AND parent_run_id <> id
      )
    );

CREATE INDEX core_runs_by_parent_run_idx
  ON nexus.core_runs (owner_id, parent_run_id, created_at)
  WHERE parent_run_id IS NOT NULL;

CREATE FUNCTION nexus.prevent_core_run_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
    OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.input_message_id IS DISTINCT FROM OLD.input_message_id
    OR NEW.parent_run_id IS DISTINCT FROM OLD.parent_run_id
    OR NEW.parent_step_id IS DISTINCT FROM OLD.parent_step_id
    OR NEW.delegation_depth IS DISTINCT FROM OLD.delegation_depth
    OR NEW.format_version IS DISTINCT FROM OLD.format_version
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'CoreRun identity and delegation lineage are immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER core_runs_identity_immutable
BEFORE UPDATE ON nexus.core_runs
FOR EACH ROW EXECUTE FUNCTION nexus.prevent_core_run_identity_mutation();

REVOKE ALL ON FUNCTION nexus.prevent_core_run_identity_mutation() FROM PUBLIC;

COMMIT;
