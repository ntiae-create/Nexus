-- NEXUS V1 initial relational schema.
-- This migration is immutable after application. Future changes require a new migration.

CREATE SCHEMA nexus;

CREATE TYPE nexus.conversation_status AS ENUM ('active', 'archived', 'deleted');
CREATE TYPE nexus.message_role AS ENUM ('user', 'assistant', 'core');
CREATE TYPE nexus.message_status AS ENUM ('pending', 'complete', 'failed', 'cancelled');
CREATE TYPE nexus.core_run_status AS ENUM ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled');
CREATE TYPE nexus.run_step_status AS ENUM ('pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled');
CREATE TYPE nexus.tool_event_status AS ENUM ('requested', 'running', 'succeeded', 'failed', 'cancelled');
CREATE TYPE nexus.run_result_status AS ENUM ('succeeded', 'partial', 'failed');
CREATE TYPE nexus.memory_visibility AS ENUM ('individual', 'shared');
CREATE TYPE nexus.memory_permission_status AS ENUM ('granted', 'revoked');
CREATE TYPE nexus.memory_permission_action AS ENUM ('granted', 'revoked');
CREATE TYPE nexus.provider_availability AS ENUM ('available', 'unavailable', 'restricted');
CREATE TYPE nexus.provider_cost_status AS ENUM ('free_confirmed', 'paid', 'unknown');
CREATE TYPE nexus.provider_selection_mode AS ENUM ('automatic', 'manual');
CREATE TYPE nexus.tombstone_entity_type AS ENUM ('conversation', 'message', 'memory');

CREATE FUNCTION nexus.current_owner_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(pg_catalog.current_setting('nexus.owner_id', true), '')::uuid
$$;

CREATE FUNCTION nexus.current_actor_type()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(pg_catalog.current_setting('nexus.actor_type', true), '')
$$;

CREATE FUNCTION nexus.current_assistant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(pg_catalog.current_setting('nexus.assistant_id', true), '')::uuid
$$;

CREATE FUNCTION nexus.text_looks_like_credential_material(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT value ~* '(-----BEGIN [A-Z ]*PRIVATE KEY-----|(^|[[:space:]])Bearer[[:space:]]+[A-Za-z0-9._~+/-]{16,}|(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password)[[:space:]]*[:=][[:space:]]*[^[:space:]]{8,}|(sk|pk|rk|ghp|gho|ghu|ghs|ghr|xoxb|xoxa|xoxp|xoxr|xoxs)[-_][A-Za-z0-9_-]{16,})'
$$;

CREATE FUNCTION nexus.jsonb_has_credential_key(document jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT CASE pg_catalog.jsonb_typeof(document)
    WHEN 'object' THEN EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_each(document) AS entry(key, value)
      WHERE entry.key ~* '(secret|credential|password|token|api.?key|authorization|private.?key)'
         OR nexus.jsonb_has_credential_key(entry.value)
    )
    WHEN 'array' THEN EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(document) AS entry(value)
      WHERE nexus.jsonb_has_credential_key(entry.value)
    )
    WHEN 'string' THEN nexus.text_looks_like_credential_material(document #>> '{}')
    ELSE false
  END
$$;

CREATE TABLE nexus.owner_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owner_identity_timestamps_ordered CHECK (updated_at >= created_at)
);
INSERT INTO nexus.owner_identity (singleton, id)
VALUES (true, '00000000-0000-4000-8000-000000000004');

CREATE FUNCTION nexus.configured_owner_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT owner.id FROM nexus.owner_identity AS owner WHERE owner.singleton
$$;

CREATE TABLE nexus.assistants (
  id uuid PRIMARY KEY,
  assistant_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  description text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE nexus.assistant_config_versions (
  assistant_id uuid NOT NULL REFERENCES nexus.assistants(id) ON DELETE RESTRICT,
  config_version text NOT NULL,
  source text NOT NULL CHECK (source IN ('static_code', 'managed_future')),
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (assistant_id, config_version),
  CONSTRAINT assistant_config_metadata_no_credentials CHECK (NOT nexus.jsonb_has_credential_key(metadata))
);

INSERT INTO nexus.assistants (id, assistant_key, display_name, description, status)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'yui', 'YUI', 'Assistente pessoal.', 'active'),
  ('00000000-0000-4000-8000-000000000002', 'alice', 'ALICE', 'Pesquisa e investigação.', 'active'),
  ('00000000-0000-4000-8000-000000000003', 'schwi', 'SCHWI', 'Lógica e planejamento.', 'active');

INSERT INTO nexus.assistant_config_versions (assistant_id, config_version, source)
VALUES
  ('00000000-0000-4000-8000-000000000001', '1.0.0', 'static_code'),
  ('00000000-0000-4000-8000-000000000002', '1.0.0', 'static_code'),
  ('00000000-0000-4000-8000-000000000003', '1.0.0', 'static_code');

CREATE TABLE nexus.providers (
  id uuid PRIMARY KEY,
  provider_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  availability nexus.provider_availability NOT NULL DEFAULT 'unavailable',
  cost_status nexus.provider_cost_status NOT NULL DEFAULT 'unknown',
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(capabilities) = 'array'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT providers_metadata_no_credentials CHECK (NOT nexus.jsonb_has_credential_key(metadata)),
  CONSTRAINT providers_capabilities_no_credentials CHECK (NOT nexus.jsonb_has_credential_key(capabilities))
);

CREATE TABLE nexus.models (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES nexus.providers(id) ON DELETE RESTRICT,
  model_key text NOT NULL,
  display_name text NOT NULL,
  availability nexus.provider_availability NOT NULL DEFAULT 'unavailable',
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(capabilities) = 'array'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, model_key),
  UNIQUE (provider_id, id),
  CONSTRAINT models_metadata_no_credentials CHECK (NOT nexus.jsonb_has_credential_key(metadata)),
  CONSTRAINT models_capabilities_no_credentials CHECK (NOT nexus.jsonb_has_credential_key(capabilities))
);

CREATE TABLE nexus.conversations (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  title text,
  status nexus.conversation_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT conversations_metadata_no_credentials CHECK (NOT nexus.jsonb_has_credential_key(metadata)),
  CONSTRAINT conversations_title_no_credentials CHECK (title IS NULL OR NOT nexus.text_looks_like_credential_material(title)),
  CONSTRAINT conversations_timestamps_ordered CHECK (updated_at >= created_at)
);
CREATE INDEX conversations_owner_updated_idx ON nexus.conversations (owner_id, updated_at DESC, id);

CREATE TABLE nexus.conversation_assistants (
  owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  assistant_id uuid NOT NULL REFERENCES nexus.assistants(id) ON DELETE RESTRICT,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, assistant_id),
  FOREIGN KEY (conversation_id) REFERENCES nexus.conversations(id) ON DELETE CASCADE
);
CREATE INDEX conversation_assistants_by_assistant_idx ON nexus.conversation_assistants (owner_id, assistant_id, conversation_id);

CREATE TABLE nexus.messages (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  role nexus.message_role NOT NULL,
  assistant_id uuid REFERENCES nexus.assistants(id) ON DELETE RESTRICT,
  core_run_id uuid,
  status nexus.message_status NOT NULL,
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'array'),
  format_version integer NOT NULL CHECK (format_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (conversation_id, sequence),
  UNIQUE (conversation_id, id),
  FOREIGN KEY (conversation_id) REFERENCES nexus.conversations(id) ON DELETE CASCADE,
  CHECK ((role = 'assistant' AND assistant_id IS NOT NULL) OR (role <> 'assistant' AND assistant_id IS NULL)),
  CONSTRAINT messages_content_no_credentials CHECK (NOT nexus.jsonb_has_credential_key(content)),
  CONSTRAINT messages_metadata_no_credentials CHECK (NOT nexus.jsonb_has_credential_key(metadata)),
  CONSTRAINT messages_timestamps_ordered CHECK (updated_at IS NULL OR updated_at >= created_at)
);
CREATE INDEX messages_conversation_sequence_idx ON nexus.messages (owner_id, conversation_id, sequence DESC);
CREATE INDEX messages_owner_created_idx ON nexus.messages (owner_id, created_at DESC);

CREATE FUNCTION nexus.prevent_message_content_edit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content
    OR NEW.role IS DISTINCT FROM OLD.role
    OR NEW.sequence IS DISTINCT FROM OLD.sequence
    OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
    OR NEW.assistant_id IS DISTINCT FROM OLD.assistant_id
    OR NEW.core_run_id IS DISTINCT FROM OLD.core_run_id
  THEN
    RAISE EXCEPTION 'Message content and identity are immutable in V1';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER messages_content_immutable
BEFORE UPDATE ON nexus.messages
FOR EACH ROW EXECUTE FUNCTION nexus.prevent_message_content_edit();

CREATE TABLE nexus.core_runs (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  request_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  status nexus.core_run_status NOT NULL DEFAULT 'queued',
  input_message_id uuid NOT NULL,
  final_message_id uuid,
  trace jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(trace) = 'array'),
  format_version integer NOT NULL CHECK (format_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (idempotency_key),
  UNIQUE (request_id),
  UNIQUE (conversation_id, id),
  FOREIGN KEY (conversation_id) REFERENCES nexus.conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, input_message_id) REFERENCES nexus.messages(conversation_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (conversation_id, final_message_id) REFERENCES nexus.messages(conversation_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT core_runs_metadata_no_credentials CHECK (NOT nexus.jsonb_has_credential_key(metadata)),
  CONSTRAINT core_runs_trace_no_credentials CHECK (NOT nexus.jsonb_has_credential_key(trace)),
  CONSTRAINT core_runs_timestamps_ordered CHECK (finished_at IS NULL OR (started_at IS NOT NULL AND finished_at >= started_at))
);
CREATE INDEX core_runs_conversation_created_idx ON nexus.core_runs (owner_id, conversation_id, created_at DESC);
CREATE INDEX core_runs_owner_status_created_idx ON nexus.core_runs (owner_id, status, created_at DESC);

ALTER TABLE nexus.messages
  ADD CONSTRAINT messages_core_run_same_conversation_fk
  FOREIGN KEY (conversation_id, core_run_id) REFERENCES nexus.core_runs(conversation_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE nexus.run_steps (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  step_order integer NOT NULL CHECK (step_order >= 0),
  assistant_id uuid NOT NULL,
  assistant_config_version text NOT NULL,
  status nexus.run_step_status NOT NULL DEFAULT 'pending',
  objective text NOT NULL,
  input_reference_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(input_reference_ids) = 'array'),
  provider_id uuid,
  model_id uuid,
  started_at timestamptz,
  finished_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (run_id, id),
  UNIQUE (run_id, step_order),
  FOREIGN KEY (run_id) REFERENCES nexus.core_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (assistant_id, assistant_config_version) REFERENCES nexus.assistant_config_versions(assistant_id, config_version) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, model_id) REFERENCES nexus.models(provider_id, id) ON DELETE RESTRICT,
  CHECK ((provider_id IS NULL AND model_id IS NULL) OR (provider_id IS NOT NULL AND model_id IS NOT NULL)),
  CONSTRAINT run_steps_metadata_no_credentials CHECK (NOT nexus.jsonb_has_credential_key(metadata)),
  CONSTRAINT run_steps_refs_no_credentials CHECK (NOT nexus.jsonb_has_credential_key(input_reference_ids)),
  CONSTRAINT run_steps_timestamps_ordered CHECK (finished_at IS NULL OR (started_at IS NOT NULL AND finished_at >= started_at))
);
CREATE INDEX run_steps_by_run_order_idx ON nexus.run_steps (owner_id, run_id, step_order);

CREATE TABLE nexus.run_results (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  step_id uuid,
  status nexus.run_result_status NOT NULL,
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'array'),
  references_data jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(references_data) = 'array'),
  format_version integer NOT NULL CHECK (format_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (run_id) REFERENCES nexus.core_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, step_id) REFERENCES nexus.run_steps(run_id, id) ON DELETE CASCADE,
  CONSTRAINT run_results_content_no_credentials CHECK (NOT nexus.jsonb_has_credential_key(content)),
  CONSTRAINT run_results_references_no_credentials CHECK (NOT nexus.jsonb_has_credential_key(references_data)),
  CONSTRAINT run_results_metadata_no_credentials CHECK (NOT nexus.jsonb_has_credential_key(metadata))
);
CREATE INDEX run_results_by_run_created_idx ON nexus.run_results (owner_id, run_id, created_at);
CREATE INDEX run_results_by_step_idx ON nexus.run_results (owner_id, step_id) WHERE step_id IS NOT NULL;

CREATE TABLE nexus.tool_events (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  step_id uuid,
  tool_id text NOT NULL,
  tool_version text NOT NULL,
  event_type text NOT NULL,
  status nexus.tool_event_status NOT NULL,
  normalized_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(normalized_data) = 'object'),
  references_data jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(references_data) = 'array'),
  origin text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  format_version integer NOT NULL CHECK (format_version > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  contains_untrusted_external_data boolean NOT NULL DEFAULT true,
  FOREIGN KEY (run_id) REFERENCES nexus.core_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, step_id) REFERENCES nexus.run_steps(run_id, id) ON DELETE CASCADE,
  CONSTRAINT tool_events_payload_no_credentials CHECK (NOT nexus.jsonb_has_credential_key(normalized_data)),
  CONSTRAINT tool_events_references_no_credentials CHECK (NOT nexus.jsonb_has_credential_key(references_data)),
  CONSTRAINT tool_events_metadata_no_credentials CHECK (NOT nexus.jsonb_has_credential_key(metadata))
);
CREATE INDEX tool_events_by_run_time_idx ON nexus.tool_events (owner_id, run_id, occurred_at);
CREATE INDEX tool_events_by_step_time_idx ON nexus.tool_events (owner_id, step_id, occurred_at) WHERE step_id IS NOT NULL;

CREATE TABLE nexus.assistant_memories (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  visibility nexus.memory_visibility NOT NULL,
  origin text NOT NULL,
  source_message_id uuid,
  origin_assistant_id uuid REFERENCES nexus.assistants(id) ON DELETE RESTRICT,
  content text NOT NULL,
  format_version integer NOT NULL CHECK (format_version > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (source_message_id) REFERENCES nexus.messages(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CHECK (length(btrim(content)) > 0),
  CHECK ((visibility = 'individual' AND origin_assistant_id IS NOT NULL) OR visibility = 'shared'),
  CONSTRAINT assistant_memories_metadata_no_credentials CHECK (NOT nexus.jsonb_has_credential_key(metadata)),
  CONSTRAINT assistant_memories_content_no_credentials CHECK (NOT nexus.text_looks_like_credential_material(content)),
  CONSTRAINT assistant_memories_timestamps_ordered CHECK (updated_at >= created_at)
);
CREATE INDEX assistant_memories_owner_assistant_idx ON nexus.assistant_memories (owner_id, origin_assistant_id, updated_at DESC);
CREATE INDEX assistant_memories_owner_visibility_idx ON nexus.assistant_memories (owner_id, visibility, updated_at DESC);

CREATE FUNCTION nexus.clear_memory_source_before_message_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE nexus.assistant_memories
  SET source_message_id = NULL, updated_at = now()
  WHERE source_message_id = OLD.id;
  RETURN OLD;
END
$$;

CREATE TRIGGER messages_clear_memory_source
BEFORE DELETE ON nexus.messages
FOR EACH ROW EXECUTE FUNCTION nexus.clear_memory_source_before_message_delete();

CREATE TABLE nexus.memory_permissions (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  memory_id uuid NOT NULL,
  assistant_id uuid NOT NULL REFERENCES nexus.assistants(id) ON DELETE RESTRICT,
  status nexus.memory_permission_status NOT NULL,
  granted_by_owner_id uuid NOT NULL,
  granted_at timestamptz NOT NULL,
  revoked_by_owner_id uuid,
  revoked_at timestamptz,
  UNIQUE (memory_id, assistant_id),
  FOREIGN KEY (memory_id) REFERENCES nexus.assistant_memories(id) ON DELETE CASCADE,
  CHECK (granted_by_owner_id = owner_id),
  CHECK (revoked_by_owner_id IS NULL OR revoked_by_owner_id = owner_id),
  CHECK (
    (status = 'granted' AND revoked_by_owner_id IS NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_by_owner_id IS NOT NULL AND revoked_at IS NOT NULL AND revoked_at >= granted_at)
  )
);
CREATE INDEX memory_permissions_active_lookup_idx ON nexus.memory_permissions (owner_id, memory_id, assistant_id) WHERE status = 'granted';

CREATE FUNCTION nexus.ensure_permission_for_shared_memory()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  memory_visibility nexus.memory_visibility;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'granted' THEN
    RAISE EXCEPTION 'Memory permission history must begin with an explicit grant';
  END IF;

  IF TG_OP = 'UPDATE' AND (NEW.owner_id <> OLD.owner_id OR NEW.memory_id <> OLD.memory_id OR NEW.assistant_id <> OLD.assistant_id) THEN
    RAISE EXCEPTION 'Memory permission scope is immutable';
  END IF;

  SELECT memory.visibility
  INTO memory_visibility
  FROM nexus.assistant_memories AS memory
  WHERE memory.owner_id = NEW.owner_id AND memory.id = NEW.memory_id;

  IF memory_visibility IS DISTINCT FROM 'shared'::nexus.memory_visibility THEN
    RAISE EXCEPTION 'Explicit assistant permissions apply only to shared memories';
  END IF;

  RETURN NEW;
END
$$;

CREATE TABLE nexus.memory_permission_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  assistant_id uuid NOT NULL REFERENCES nexus.assistants(id) ON DELETE RESTRICT,
  action nexus.memory_permission_action NOT NULL,
  actor_owner_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- UUIDs are retained as historical snapshots so the audit survives item deletion.
  CHECK (actor_owner_id = owner_id)
);
CREATE INDEX memory_permission_audit_item_idx ON nexus.memory_permission_audit (owner_id, memory_id, occurred_at DESC);

CREATE FUNCTION nexus.audit_memory_permission_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  audit_action nexus.memory_permission_action;
BEGIN
  IF TG_OP = 'INSERT' THEN
    audit_action := 'granted';
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    audit_action := NEW.status::text::nexus.memory_permission_action;
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO nexus.memory_permission_audit (
    owner_id, permission_id, memory_id, assistant_id, action, actor_owner_id
  ) VALUES (
    NEW.owner_id,
    NEW.id,
    NEW.memory_id,
    NEW.assistant_id,
    audit_action,
    CASE WHEN audit_action = 'granted' THEN NEW.granted_by_owner_id ELSE NEW.revoked_by_owner_id END
  );
  RETURN NEW;
END
$$;

CREATE TRIGGER memory_permissions_shared_only
BEFORE INSERT OR UPDATE ON nexus.memory_permissions
FOR EACH ROW EXECUTE FUNCTION nexus.ensure_permission_for_shared_memory();
CREATE TRIGGER memory_permissions_audit_changes
AFTER INSERT OR UPDATE ON nexus.memory_permissions
FOR EACH ROW EXECUTE FUNCTION nexus.audit_memory_permission_change();
REVOKE ALL ON FUNCTION nexus.audit_memory_permission_change() FROM PUBLIC;
CREATE TABLE nexus.provider_authorizations (
  owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES nexus.providers(id) ON DELETE RESTRICT,
  authorized boolean NOT NULL DEFAULT false,
  paid_use_authorized boolean NOT NULL DEFAULT false,
  authorized_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id),
  CHECK (NOT paid_use_authorized OR authorized),
  CHECK (
    (authorized AND authorized_at IS NOT NULL AND revoked_at IS NULL)
    OR (NOT authorized AND (authorized_at IS NULL OR revoked_at IS NOT NULL))
  )
);

CREATE FUNCTION nexus.enforce_provider_preference_authorization()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  provider_cost nexus.provider_cost_status;
  provider_availability nexus.provider_availability;
  model_availability nexus.provider_availability;
  allowed boolean;
  paid_authorized boolean;
BEGIN
  IF NEW.selection_mode = 'automatic' THEN
    RETURN NEW;
  END IF;

  SELECT provider.cost_status, provider.availability, model.availability, authorization.authorized, authorization.paid_use_authorized
  INTO provider_cost, provider_availability, model_availability, allowed, paid_authorized
  FROM nexus.providers AS provider
  JOIN nexus.models AS model
    ON model.provider_id = provider.id AND model.id = NEW.model_id
  JOIN nexus.provider_authorizations AS authorization
    ON authorization.provider_id = provider.id AND authorization.owner_id = NEW.owner_id
  WHERE provider.id = NEW.provider_id;

  IF NOT FOUND OR NOT allowed OR provider_availability <> 'available' OR model_availability <> 'available' THEN
    RAISE EXCEPTION 'Manual provider preference requires an available, explicitly authorized provider and model'
      USING ERRCODE = '42501';
  END IF;

  IF provider_cost <> 'free_confirmed' AND NOT paid_authorized THEN
    RAISE EXCEPTION 'Paid or unknown-cost provider preference requires explicit paid-use authorization'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;

CREATE TABLE nexus.global_provider_preferences (
  owner_id uuid PRIMARY KEY REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  selection_mode nexus.provider_selection_mode NOT NULL DEFAULT 'automatic',
  provider_id uuid,
  model_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (provider_id, model_id) REFERENCES nexus.models(provider_id, id) ON DELETE RESTRICT,
  CHECK (
    (selection_mode = 'automatic' AND provider_id IS NULL AND model_id IS NULL)
    OR (selection_mode = 'manual' AND provider_id IS NOT NULL AND model_id IS NOT NULL)
  )
);

CREATE TABLE nexus.assistant_provider_preferences (
  owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES nexus.assistants(id) ON DELETE RESTRICT,
  selection_mode nexus.provider_selection_mode NOT NULL,
  provider_id uuid,
  model_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assistant_id),
  FOREIGN KEY (provider_id, model_id) REFERENCES nexus.models(provider_id, id) ON DELETE RESTRICT,
  CHECK (
    (selection_mode = 'automatic' AND provider_id IS NULL AND model_id IS NULL)
    OR (selection_mode = 'manual' AND provider_id IS NOT NULL AND model_id IS NOT NULL)
  )
);

CREATE TABLE nexus.conversation_provider_preferences (
  owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  selection_mode nexus.provider_selection_mode NOT NULL,
  provider_id uuid,
  model_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id),
  FOREIGN KEY (conversation_id) REFERENCES nexus.conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id, model_id) REFERENCES nexus.models(provider_id, id) ON DELETE RESTRICT,
  CHECK (
    (selection_mode = 'automatic' AND provider_id IS NULL AND model_id IS NULL)
    OR (selection_mode = 'manual' AND provider_id IS NOT NULL AND model_id IS NOT NULL)
  )
);

CREATE TRIGGER global_provider_preference_authorization
BEFORE INSERT OR UPDATE ON nexus.global_provider_preferences
FOR EACH ROW EXECUTE FUNCTION nexus.enforce_provider_preference_authorization();
CREATE TRIGGER assistant_provider_preference_authorization
BEFORE INSERT OR UPDATE ON nexus.assistant_provider_preferences
FOR EACH ROW EXECUTE FUNCTION nexus.enforce_provider_preference_authorization();
CREATE TRIGGER conversation_provider_preference_authorization
BEFORE INSERT OR UPDATE ON nexus.conversation_provider_preferences
FOR EACH ROW EXECUTE FUNCTION nexus.enforce_provider_preference_authorization();

CREATE TABLE nexus.sync_cursors (
  owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  cursor text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id)
);

CREATE TABLE nexus.tombstones (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL,
  owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  entity_type nexus.tombstone_entity_type NOT NULL,
  entity_id uuid NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id)
);
CREATE INDEX tombstones_owner_sequence_idx ON nexus.tombstones (owner_id, sequence);

CREATE FUNCTION nexus.record_deleted_entity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  deleted_type nexus.tombstone_entity_type;
BEGIN
  deleted_type := TG_ARGV[0]::nexus.tombstone_entity_type;
  INSERT INTO nexus.tombstones (id, owner_id, entity_type, entity_id)
  VALUES (OLD.id, OLD.owner_id, deleted_type, OLD.id)
  ON CONFLICT (entity_type, entity_id) DO NOTHING;
  RETURN OLD;
END
$$;

CREATE TRIGGER conversations_tombstone
AFTER DELETE ON nexus.conversations
FOR EACH ROW EXECUTE FUNCTION nexus.record_deleted_entity('conversation');
CREATE TRIGGER messages_tombstone
AFTER DELETE ON nexus.messages
FOR EACH ROW EXECUTE FUNCTION nexus.record_deleted_entity('message');
CREATE TRIGGER memories_tombstone
AFTER DELETE ON nexus.assistant_memories
FOR EACH ROW EXECUTE FUNCTION nexus.record_deleted_entity('memory');
REVOKE ALL ON FUNCTION nexus.record_deleted_entity() FROM PUBLIC;

-- owner_id is an ownership anchor to the single seeded owner, not a tenant selector.
-- RLS also checks the singleton row and fails closed when context is absent or invalid.

ALTER TABLE nexus.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY conversations_owner_select ON nexus.conversations
  FOR SELECT USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()));
CREATE POLICY conversations_owner_insert ON nexus.conversations
  FOR INSERT WITH CHECK ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');
CREATE POLICY conversations_owner_update ON nexus.conversations
  FOR UPDATE USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner')
  WITH CHECK ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');
CREATE POLICY conversations_owner_delete ON nexus.conversations
  FOR DELETE USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');

ALTER TABLE nexus.conversation_assistants ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.conversation_assistants FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_assistants_owner_access ON nexus.conversation_assistants
  USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id() AND nexus.current_actor_type() = 'owner')) WITH CHECK ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id() AND nexus.current_actor_type() = 'owner'));

ALTER TABLE nexus.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.messages FORCE ROW LEVEL SECURITY;
CREATE POLICY messages_owner_access ON nexus.messages
  USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id() AND nexus.current_actor_type() = 'owner')) WITH CHECK ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id() AND nexus.current_actor_type() = 'owner'));

ALTER TABLE nexus.core_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.core_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY core_runs_owner_access ON nexus.core_runs
  USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id() AND nexus.current_actor_type() = 'owner')) WITH CHECK ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id() AND nexus.current_actor_type() = 'owner'));

ALTER TABLE nexus.run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.run_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY run_steps_owner_access ON nexus.run_steps
  USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id() AND nexus.current_actor_type() = 'owner')) WITH CHECK ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id() AND nexus.current_actor_type() = 'owner'));

ALTER TABLE nexus.run_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.run_results FORCE ROW LEVEL SECURITY;
CREATE POLICY run_results_owner_access ON nexus.run_results
  USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id() AND nexus.current_actor_type() = 'owner')) WITH CHECK ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id() AND nexus.current_actor_type() = 'owner'));

ALTER TABLE nexus.tool_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.tool_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tool_events_owner_access ON nexus.tool_events
  USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id() AND nexus.current_actor_type() = 'owner')) WITH CHECK ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id() AND nexus.current_actor_type() = 'owner'));

ALTER TABLE nexus.assistant_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.assistant_memories FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_memories_select_policy ON nexus.assistant_memories
  FOR SELECT USING (
    (owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id())
    AND (
      nexus.current_actor_type() = 'owner'
      OR (
        nexus.current_actor_type() = 'assistant'
        AND status = 'active'
        AND (
          (visibility = 'individual' AND origin_assistant_id = nexus.current_assistant_id())
          OR (
            visibility = 'shared'
            AND EXISTS (
              SELECT 1
              FROM nexus.memory_permissions AS permission
              WHERE permission.owner_id = assistant_memories.owner_id
                AND permission.memory_id = assistant_memories.id
                AND permission.assistant_id = nexus.current_assistant_id()
                AND permission.status = 'granted'
            )
          )
        )
      )
    )
  );
CREATE POLICY assistant_memories_owner_insert ON nexus.assistant_memories
  FOR INSERT WITH CHECK ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');
CREATE POLICY assistant_memories_owner_update ON nexus.assistant_memories
  FOR UPDATE USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner')
  WITH CHECK ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');
CREATE POLICY assistant_memories_owner_delete ON nexus.assistant_memories
  FOR DELETE USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');

ALTER TABLE nexus.memory_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.memory_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_permissions_select_policy ON nexus.memory_permissions
  FOR SELECT USING (
    (owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id())
    AND (
      nexus.current_actor_type() = 'owner'
      OR (nexus.current_actor_type() = 'assistant' AND assistant_id = nexus.current_assistant_id())
    )
  );
CREATE POLICY memory_permissions_owner_insert ON nexus.memory_permissions
  FOR INSERT WITH CHECK ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');
CREATE POLICY memory_permissions_owner_update ON nexus.memory_permissions
  FOR UPDATE USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner')
  WITH CHECK ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');

ALTER TABLE nexus.memory_permission_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.memory_permission_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_permission_audit_owner_select ON nexus.memory_permission_audit
  FOR SELECT USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');
CREATE POLICY memory_permission_audit_trigger_insert ON nexus.memory_permission_audit
  FOR INSERT WITH CHECK (
    (owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id())
    AND nexus.current_actor_type() = 'owner'
    AND pg_catalog.pg_trigger_depth() > 0
  );

ALTER TABLE nexus.provider_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.provider_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_authorizations_select ON nexus.provider_authorizations
  FOR SELECT USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()));
CREATE POLICY provider_authorizations_owner_insert ON nexus.provider_authorizations
  FOR INSERT WITH CHECK ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');
CREATE POLICY provider_authorizations_owner_update ON nexus.provider_authorizations
  FOR UPDATE USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner')
  WITH CHECK ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');
CREATE POLICY provider_authorizations_owner_delete ON nexus.provider_authorizations
  FOR DELETE USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');

ALTER TABLE nexus.global_provider_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.global_provider_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY global_provider_preferences_select ON nexus.global_provider_preferences
  FOR SELECT USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()));
CREATE POLICY global_provider_preferences_owner_insert ON nexus.global_provider_preferences
  FOR INSERT WITH CHECK ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');
CREATE POLICY global_provider_preferences_owner_update ON nexus.global_provider_preferences
  FOR UPDATE USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner')
  WITH CHECK ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');
CREATE POLICY global_provider_preferences_owner_delete ON nexus.global_provider_preferences
  FOR DELETE USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');

ALTER TABLE nexus.assistant_provider_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.assistant_provider_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_provider_preferences_select ON nexus.assistant_provider_preferences
  FOR SELECT USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()));
CREATE POLICY assistant_provider_preferences_owner_insert ON nexus.assistant_provider_preferences
  FOR INSERT WITH CHECK ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');
CREATE POLICY assistant_provider_preferences_owner_update ON nexus.assistant_provider_preferences
  FOR UPDATE USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner')
  WITH CHECK ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');
CREATE POLICY assistant_provider_preferences_owner_delete ON nexus.assistant_provider_preferences
  FOR DELETE USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');

ALTER TABLE nexus.conversation_provider_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.conversation_provider_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_provider_preferences_select ON nexus.conversation_provider_preferences
  FOR SELECT USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()));
CREATE POLICY conversation_provider_preferences_owner_insert ON nexus.conversation_provider_preferences
  FOR INSERT WITH CHECK ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');
CREATE POLICY conversation_provider_preferences_owner_update ON nexus.conversation_provider_preferences
  FOR UPDATE USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner')
  WITH CHECK ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');
CREATE POLICY conversation_provider_preferences_owner_delete ON nexus.conversation_provider_preferences
  FOR DELETE USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');

ALTER TABLE nexus.sync_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.sync_cursors FORCE ROW LEVEL SECURITY;
CREATE POLICY sync_cursors_owner_access ON nexus.sync_cursors
  USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner')
  WITH CHECK ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');

ALTER TABLE nexus.tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.tombstones FORCE ROW LEVEL SECURITY;
CREATE POLICY tombstones_owner_select ON nexus.tombstones
  FOR SELECT USING ((owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id()) AND nexus.current_actor_type() = 'owner');
CREATE POLICY tombstones_trigger_insert ON nexus.tombstones
  FOR INSERT WITH CHECK (
    (owner_id = nexus.current_owner_id() AND owner_id = nexus.configured_owner_id())
    AND nexus.current_actor_type() = 'owner'
    AND pg_catalog.pg_trigger_depth() > 0
  );

-- Do not expose the personal-data schema or tables to anonymous/public roles.
REVOKE ALL ON SCHEMA nexus FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA nexus FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA nexus FROM PUBLIC;
