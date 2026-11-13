-- Shared, read-only privilege contract for nexus_app.
-- Included by 00_preflight.sql before passwords/migrations and by 30_verify.sql
-- after grants. It rejects excess effective privileges; it never changes ACLs.
\set ON_ERROR_STOP on
\if :{?NEXUS_REQUIRE_APP_GRANTS}
\else
\set NEXUS_REQUIRE_APP_GRANTS false
\endif
SELECT set_config('nexus.verify.require_app_grants', :'NEXUS_REQUIRE_APP_GRANTS', false) AS app_grants_mode \gset

DO $nexus_app_privilege_contract$
DECLARE
  app_oid oid;
  readiness_function_oid oid;
  require_grants boolean := COALESCE(current_setting('nexus.verify.require_app_grants', true), 'false')::boolean;
  object_row record;
  column_row record;
  allowed_select boolean;
  allowed_insert boolean;
  allowed_update boolean;
  allowed_delete boolean;
  expected_type boolean;
  unexpected text[];
  database_oid oid;
BEGIN
  SELECT d.oid INTO database_oid
    FROM pg_database d
   WHERE d.datname = current_database();

  -- Database allowlist: CONNECT plus PostgreSQL's standard PUBLIC TEMPORARY
  -- (session-local tables only); CREATE and grant options remain forbidden.
  IF has_database_privilege('public', database_oid, 'CREATE') THEN
    RAISE EXCEPTION 'PREFLIGHT: PUBLIC has CREATE on database %', current_database();
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_database d,
           LATERAL aclexplode(d.datacl) acl
     WHERE d.oid = database_oid
       AND acl.grantee = 0
       AND acl.is_grantable
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT: PUBLIC has a grant option on database %', current_database();
  END IF;

  SELECT oid INTO app_oid FROM pg_roles WHERE rolname = 'nexus_app';

  -- Default ACLs are future grants rather than privileges on current objects.
  -- Reject grants to PUBLIC or the runtime role from either object creator so a
  -- later migration cannot silently widen access outside this verified snapshot.
  IF EXISTS (
    SELECT 1
      FROM pg_default_acl d
      JOIN pg_roles creator ON creator.oid = d.defaclrole
      CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
     WHERE creator.rolname IN ('nexus_migrator', 'nexus_audit_writer')
       AND (acl.grantee = 0 OR (app_oid IS NOT NULL AND acl.grantee = app_oid))
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT: default ACL grants privileges to PUBLIC or nexus_app';
  END IF;

  IF app_oid IS NULL THEN
    IF require_grants THEN
      RAISE EXCEPTION 'FALHA: nexus_app não existe';
    END IF;
    -- PUBLIC ACLs remain effective when nexus_app is created, so inspect them
    -- before returning. Otherwise a missing login could hide an unsafe grant
    -- until after phase 1 has created roles and set credentials.
    IF EXISTS (
      SELECT 1
        FROM pg_namespace n
       WHERE n.nspname !~ '^pg_'
         AND n.nspname <> 'information_schema'
         AND (
           (n.nspname = 'nexus' AND n.nspacl IS NOT NULL AND EXISTS (
             SELECT 1 FROM aclexplode(n.nspacl) acl WHERE acl.grantee = 0
           ))
           OR has_schema_privilege('public', n.oid, 'CREATE')
           OR (n.nspname NOT IN ('nexus', 'public')
               AND has_schema_privilege('public', n.oid, 'USAGE'))
           OR (n.nspacl IS NOT NULL AND EXISTS (
             SELECT 1 FROM aclexplode(n.nspacl) acl
              WHERE acl.grantee = 0 AND acl.is_grantable
           ))
         )
    ) THEN
      RAISE EXCEPTION 'PREFLIGHT: PUBLIC tem privilégio de schema fora da allowlist';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname !~ '^pg_'
         AND n.nspname <> 'information_schema'
         AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
         AND c.relacl IS NOT NULL
         AND EXISTS (SELECT 1 FROM aclexplode(c.relacl) acl WHERE acl.grantee = 0)
    ) THEN
      RAISE EXCEPTION 'PREFLIGHT: PUBLIC tem privilégio em tabela/sequência';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname !~ '^pg_'
         AND n.nspname <> 'information_schema'
         AND a.attnum > 0 AND NOT a.attisdropped
         AND a.attacl IS NOT NULL
         AND EXISTS (SELECT 1 FROM aclexplode(a.attacl) acl WHERE acl.grantee = 0)
    ) THEN
      RAISE EXCEPTION 'PREFLIGHT: PUBLIC tem privilégio de coluna';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE t.typtype IN ('e', 'd', 'r', 'm')
         AND n.nspname !~ '^pg_'
         AND n.nspname <> 'information_schema'
         AND (
           (t.typacl IS NOT NULL AND EXISTS (
             SELECT 1 FROM aclexplode(t.typacl) acl
              WHERE acl.grantee = 0 AND acl.is_grantable
           ))
           OR (has_type_privilege('public', t.oid, 'USAGE') AND NOT (
             n.nspname = 'nexus' AND t.typname = ANY (ARRAY[
               'conversation_status', 'message_role', 'message_status', 'core_run_status',
               'run_step_status', 'tool_event_status', 'run_result_status', 'memory_visibility',
               'memory_permission_status', 'memory_permission_action', 'provider_availability',
               'provider_cost_status', 'provider_selection_mode', 'tombstone_entity_type'
             ])
           ))
         )
    ) THEN
      RAISE EXCEPTION 'PREFLIGHT: PUBLIC tem USAGE/grant option em tipo fora da allowlist';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname !~ '^pg_'
         AND n.nspname <> 'information_schema'
         AND p.prosecdef
         AND has_function_privilege('public', p.oid, 'EXECUTE')
    ) THEN
      RAISE EXCEPTION 'PREFLIGHT: PUBLIC pode executar função SECURITY DEFINER';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'nexus'
         AND p.prosecdef
         AND (p.proconfig IS NULL OR NOT (p.proconfig @> ARRAY['search_path=pg_catalog']))
    ) THEN
      RAISE EXCEPTION 'PREFLIGHT: função SECURITY DEFINER de nexus sem search_path fixo';
    END IF;
    RETURN;
  END IF;

  SELECT pg_catalog.to_regprocedure('nexus.migration_ledger_ready()')::oid
    INTO readiness_function_oid;
  IF readiness_function_oid IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = readiness_function_oid
       AND p.prosecdef
       AND p.prorettype = 'boolean'::regtype
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT: nexus.migration_ledger_ready() must be SECURITY DEFINER and return boolean';
  END IF;
  IF require_grants AND readiness_function_oid IS NULL THEN
    RAISE EXCEPTION 'FALHA: SECURITY DEFINER nexus.migration_ledger_ready() boolean is missing';
  END IF;

  -- The application must never query the private migration ledger directly;
  -- it receives only the boolean from migration_ledger_ready().
  IF EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'nexus_migrations'
       AND c.relname = 'schema_migrations'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND has_table_privilege(app_oid, c.oid, 'SELECT')
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT: nexus_app has direct SELECT on the migration ledger';
  END IF;

  -- nexus_app is intentionally a standalone login. Reject both incoming and
  -- outgoing memberships: INHERIT and SET ROLE are both privilege paths.
  SELECT array_agg(format('%s -> %s', child.rolname, parent.rolname)
                   ORDER BY child.rolname, parent.rolname)
    INTO unexpected
    FROM pg_auth_members am
    JOIN pg_roles child ON child.oid = am.member
    JOIN pg_roles parent ON parent.oid = am.roleid
   WHERE am.member = app_oid OR am.roleid = app_oid;
  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: nexus_app has unexpected role memberships: %', unexpected;
  END IF;

  IF (SELECT datdba = app_oid FROM pg_database WHERE oid = database_oid) THEN
    RAISE EXCEPTION 'PREFLIGHT: nexus_app owns database %', current_database();
  END IF;
  IF has_database_privilege(app_oid, database_oid, 'CREATE') THEN
    RAISE EXCEPTION 'PREFLIGHT: nexus_app has CREATE on database %', current_database();
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_database d,
           LATERAL aclexplode(d.datacl) acl
     WHERE d.oid = database_oid
       AND acl.grantee IN (0, app_oid)
       AND acl.is_grantable
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT: nexus_app has a database grant option';
  END IF;
  IF require_grants AND NOT has_database_privilege(app_oid, database_oid, 'CONNECT') THEN
    RAISE EXCEPTION 'FALHA: nexus_app não tem CONNECT no banco %', current_database();
  END IF;
  IF require_grants AND (to_regnamespace('nexus') IS NULL
      OR NOT has_schema_privilege(app_oid, 'nexus', 'USAGE')) THEN
    RAISE EXCEPTION 'FALHA: nexus_app precisa de USAGE no schema nexus';
  END IF;

  -- USAGE in nexus is required and CONNECT is allowed. CREATE in any
  -- application schema is forbidden. PostgreSQL's default USAGE on public is
  -- tolerated, but no other non-system schema is in the app allowlist.
  FOR object_row IN
    SELECT n.oid, n.nspname, n.nspowner, n.nspacl
      FROM pg_namespace n
     WHERE n.nspname !~ '^pg_'
       AND n.nspname <> 'information_schema'
  LOOP
    IF object_row.nspowner = app_oid THEN
      RAISE EXCEPTION 'PREFLIGHT: nexus_app owns schema %', object_row.nspname;
    END IF;
    IF has_schema_privilege(app_oid, object_row.oid, 'CREATE') THEN
      RAISE EXCEPTION 'PREFLIGHT: nexus_app has CREATE on schema %', object_row.nspname;
    END IF;
    IF object_row.nspname NOT IN ('nexus', 'public')
       AND has_schema_privilege(app_oid, object_row.oid, 'USAGE') THEN
      RAISE EXCEPTION 'PREFLIGHT: nexus_app has unexpected USAGE on schema %', object_row.nspname;
    END IF;
    IF object_row.nspacl IS NOT NULL AND EXISTS (
      SELECT 1 FROM aclexplode(object_row.nspacl) acl
       WHERE acl.grantee IN (0, app_oid) AND acl.is_grantable
    ) THEN
      RAISE EXCEPTION 'PREFLIGHT: nexus_app/PUBLIC has a grant option on schema %', object_row.nspname;
    END IF;
  END LOOP;

  -- The nexus schema is private. Unlike public-schema USAGE, even PUBLIC USAGE
  -- here would expose every object granted to nexus_app to all database users.
  IF to_regnamespace('nexus') IS NOT NULL AND EXISTS (
    SELECT 1
      FROM pg_namespace n,
           LATERAL aclexplode(n.nspacl) acl
     WHERE n.nspname = 'nexus'
       AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT: PUBLIC has a direct privilege on schema nexus';
  END IF;

  -- Table allowlist mirrors 20_grant_runtime.sql. The bools describe the only
  -- table-level operations permitted; TRUNCATE, REFERENCES and TRIGGER are
  -- always forbidden. has_table_privilege sees direct, inherited and PUBLIC ACLs.
  FOR object_row IN
    SELECT n.nspname, c.oid, c.relname, c.relkind, c.relowner, c.relacl,
           (e.relname IS NOT NULL) AS expected_relation,
           COALESCE(e.select_ok, false) AS select_ok,
           COALESCE(e.insert_ok, false) AS insert_ok,
           COALESCE(e.update_ok, false) AS update_ok,
           COALESCE(e.delete_ok, false) AS delete_ok
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN (VALUES
        ('auth_login_state', true, true, true, true),
        ('revoked_sessions', true, true, true, true),
        ('owner_identity', true, false, false, false),
        ('assistants', true, false, false, false),
        ('assistant_config_versions', true, false, false, false),
        ('providers', true, false, false, false),
        ('models', true, false, false, false),
        ('conversations', true, true, true, true),
        ('conversation_assistants', true, true, true, true),
        ('messages', true, true, true, true),
        ('core_runs', true, true, true, true),
        ('core_run_assistants', true, true, true, true),
        ('run_steps', true, true, true, true),
        ('run_results', true, true, true, true),
        ('tool_events', true, true, true, true),
        ('assistant_memories', true, true, true, true),
        ('memory_permissions', true, true, true, true),
        ('provider_authorizations', true, true, true, true),
        ('global_provider_preferences', true, true, true, true),
        ('assistant_provider_preferences', true, true, true, true),
        ('conversation_provider_preferences', true, true, true, true),
        ('sync_cursors', true, true, true, true),
        ('tool_grants', true, true, true, true),
        ('user_assistant_preferences', true, true, true, true),
        ('memory_permission_audit', true, true, false, false),
        ('tombstones', true, true, false, false),
        ('tool_grant_audit', true, false, false, false)
      ) AS e(relname, select_ok, insert_ok, update_ok, delete_ok)
        ON n.nspname = 'nexus' AND c.relname = e.relname
     WHERE n.nspname !~ '^pg_'
       AND n.nspname <> 'information_schema'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  LOOP
    IF object_row.relowner = app_oid THEN
      RAISE EXCEPTION 'PREFLIGHT: nexus_app owns relation %.%', object_row.nspname, object_row.relname;
    END IF;

    IF object_row.relkind = 'S' THEN
      IF has_sequence_privilege(app_oid, object_row.oid, 'USAGE')
         AND NOT (object_row.nspname = 'nexus' AND object_row.relname IN
           ('memory_permission_audit_id_seq', 'tombstones_sequence_seq', 'tool_grant_audit_id_seq')) THEN
        RAISE EXCEPTION 'PREFLIGHT: nexus_app has unexpected USAGE on sequence %.%', object_row.nspname, object_row.relname;
      END IF;
      IF has_sequence_privilege(app_oid, object_row.oid, 'SELECT')
         AND NOT (object_row.nspname = 'nexus' AND object_row.relname IN
           ('memory_permission_audit_id_seq', 'tombstones_sequence_seq', 'tool_grant_audit_id_seq')) THEN
        RAISE EXCEPTION 'PREFLIGHT: nexus_app has unexpected SELECT on sequence %.%', object_row.nspname, object_row.relname;
      END IF;
      IF has_sequence_privilege(app_oid, object_row.oid, 'UPDATE') THEN
        RAISE EXCEPTION 'PREFLIGHT: nexus_app has UPDATE on sequence %.%', object_row.nspname, object_row.relname;
      END IF;
      IF object_row.relacl IS NOT NULL AND EXISTS (
        SELECT 1 FROM aclexplode(object_row.relacl) acl
         WHERE acl.grantee = 0
      ) THEN
        RAISE EXCEPTION 'PREFLIGHT: PUBLIC has a privilege on sequence %.%', object_row.nspname, object_row.relname;
      END IF;
      IF object_row.relacl IS NOT NULL AND EXISTS (
        SELECT 1 FROM aclexplode(object_row.relacl) acl
         WHERE acl.grantee IN (0, app_oid) AND acl.is_grantable
      ) THEN
        RAISE EXCEPTION 'PREFLIGHT: nexus_app/PUBLIC has a sequence grant option on %.%', object_row.nspname, object_row.relname;
      END IF;
      IF require_grants AND object_row.nspname = 'nexus' THEN
        IF object_row.relname NOT IN ('memory_permission_audit_id_seq', 'tombstones_sequence_seq', 'tool_grant_audit_id_seq') THEN
          RAISE EXCEPTION 'FALHA: sequência não prevista em nexus: %', object_row.relname;
        END IF;
        IF NOT has_sequence_privilege(app_oid, object_row.oid, 'USAGE')
           OR NOT has_sequence_privilege(app_oid, object_row.oid, 'SELECT') THEN
          RAISE EXCEPTION 'FALHA: nexus_app precisa de USAGE e SELECT na sequência nexus.%', object_row.relname;
        END IF;
      END IF;
    ELSE
      IF has_table_privilege(app_oid, object_row.oid, 'SELECT') AND NOT object_row.select_ok THEN
        RAISE EXCEPTION 'PREFLIGHT: nexus_app has unexpected SELECT on table %.%', object_row.nspname, object_row.relname;
      END IF;
      IF has_table_privilege(app_oid, object_row.oid, 'INSERT') AND NOT object_row.insert_ok THEN
        RAISE EXCEPTION 'PREFLIGHT: nexus_app has unexpected INSERT on table %.%', object_row.nspname, object_row.relname;
      END IF;
      IF has_table_privilege(app_oid, object_row.oid, 'UPDATE') AND NOT object_row.update_ok THEN
        RAISE EXCEPTION 'PREFLIGHT: nexus_app has unexpected UPDATE on table %.%', object_row.nspname, object_row.relname;
      END IF;
      IF has_table_privilege(app_oid, object_row.oid, 'DELETE') AND NOT object_row.delete_ok THEN
        RAISE EXCEPTION 'PREFLIGHT: nexus_app has unexpected DELETE on table %.%', object_row.nspname, object_row.relname;
      END IF;
      IF has_table_privilege(app_oid, object_row.oid, 'TRUNCATE') THEN
        RAISE EXCEPTION 'PREFLIGHT: nexus_app has TRUNCATE on table %.%', object_row.nspname, object_row.relname;
      END IF;
      IF has_table_privilege(app_oid, object_row.oid, 'REFERENCES') THEN
        RAISE EXCEPTION 'PREFLIGHT: nexus_app has REFERENCES on table %.%', object_row.nspname, object_row.relname;
      END IF;
      IF has_table_privilege(app_oid, object_row.oid, 'TRIGGER') THEN
        RAISE EXCEPTION 'PREFLIGHT: nexus_app has TRIGGER on table %.%', object_row.nspname, object_row.relname;
      END IF;

      -- Column ACLs are separate from relation ACLs; a column-only INSERT or
      -- UPDATE must not bypass the table-level allowlist above.
      FOR column_row IN
        SELECT a.attname, a.attacl
          FROM pg_attribute a
         WHERE a.attrelid = object_row.oid
           AND a.attnum > 0
           AND NOT a.attisdropped
      LOOP
        IF has_column_privilege(app_oid, object_row.oid, column_row.attname, 'SELECT')
           AND NOT object_row.select_ok THEN
          RAISE EXCEPTION 'PREFLIGHT: nexus_app has column SELECT on %.%.%', object_row.nspname, object_row.relname, column_row.attname;
        END IF;
        IF has_column_privilege(app_oid, object_row.oid, column_row.attname, 'INSERT')
           AND NOT object_row.insert_ok THEN
          RAISE EXCEPTION 'PREFLIGHT: nexus_app has column INSERT on %.%.%', object_row.nspname, object_row.relname, column_row.attname;
        END IF;
        IF has_column_privilege(app_oid, object_row.oid, column_row.attname, 'UPDATE')
           AND NOT object_row.update_ok THEN
          RAISE EXCEPTION 'PREFLIGHT: nexus_app has column UPDATE on %.%.%', object_row.nspname, object_row.relname, column_row.attname;
        END IF;
        IF has_column_privilege(app_oid, object_row.oid, column_row.attname, 'REFERENCES') THEN
          RAISE EXCEPTION 'PREFLIGHT: nexus_app has column REFERENCES on %.%.%', object_row.nspname, object_row.relname, column_row.attname;
        END IF;
        IF column_row.attacl IS NOT NULL AND EXISTS (
          SELECT 1 FROM aclexplode(column_row.attacl) acl
           WHERE acl.grantee = 0
        ) THEN
          RAISE EXCEPTION 'PREFLIGHT: PUBLIC has a column privilege on %.%.%', object_row.nspname, object_row.relname, column_row.attname;
        END IF;
        IF column_row.attacl IS NOT NULL AND EXISTS (
          SELECT 1 FROM aclexplode(column_row.attacl) acl
           WHERE acl.grantee IN (0, app_oid) AND acl.is_grantable
        ) THEN
          RAISE EXCEPTION 'PREFLIGHT: nexus_app/PUBLIC has a column grant option on %.%.%', object_row.nspname, object_row.relname, column_row.attname;
        END IF;
      END LOOP;

      IF object_row.relacl IS NOT NULL AND EXISTS (
        SELECT 1 FROM aclexplode(object_row.relacl) acl
         WHERE acl.grantee = 0
      ) THEN
        RAISE EXCEPTION 'PREFLIGHT: PUBLIC has a privilege on table %.%', object_row.nspname, object_row.relname;
      END IF;
      IF object_row.relacl IS NOT NULL AND EXISTS (
        SELECT 1 FROM aclexplode(object_row.relacl) acl
         WHERE acl.grantee IN (0, app_oid) AND acl.is_grantable
      ) THEN
        RAISE EXCEPTION 'PREFLIGHT: nexus_app/PUBLIC has a table grant option on %.%', object_row.nspname, object_row.relname;
      END IF;
      IF require_grants AND object_row.nspname = 'nexus'
         AND object_row.relkind IN ('r', 'p', 'v', 'm', 'f') THEN
        IF NOT object_row.expected_relation THEN
          RAISE EXCEPTION 'FALHA: relação não prevista no allowlist de nexus: %', object_row.relname;
        END IF;
        IF has_table_privilege(app_oid, object_row.oid, 'SELECT') IS DISTINCT FROM object_row.select_ok
           OR has_table_privilege(app_oid, object_row.oid, 'INSERT') IS DISTINCT FROM object_row.insert_ok
           OR has_table_privilege(app_oid, object_row.oid, 'UPDATE') IS DISTINCT FROM object_row.update_ok
           OR has_table_privilege(app_oid, object_row.oid, 'DELETE') IS DISTINCT FROM object_row.delete_ok THEN
          RAISE EXCEPTION 'FALHA: allowlist de nexus_app diverge na tabela nexus.% (SELECT/INSERT/UPDATE/DELETE)', object_row.relname;
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- Only the 16 enum types defined by the migrations are in the type allowlist.
  -- The two tool-grant enums explicitly revoke PUBLIC USAGE in migration 00007;
  -- the original 14 retain PostgreSQL's default PUBLIC USAGE (non-data privilege).
  FOR object_row IN
    SELECT t.oid, t.typname, t.typowner, t.typacl, n.nspname, t.typtype
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE t.typtype IN ('e', 'd', 'r', 'm')
       AND n.nspname !~ '^pg_'
       AND n.nspname <> 'information_schema'
  LOOP
    expected_type := object_row.nspname = 'nexus'
      AND object_row.typname = ANY (ARRAY[
        'conversation_status', 'message_role', 'message_status', 'core_run_status',
        'run_step_status', 'tool_event_status', 'run_result_status', 'memory_visibility',
        'memory_permission_status', 'memory_permission_action', 'provider_availability',
        'provider_cost_status', 'provider_selection_mode', 'tombstone_entity_type',
        'tool_grant_status', 'tool_grant_action'
      ]);
    IF object_row.typowner = app_oid THEN
      RAISE EXCEPTION 'PREFLIGHT: nexus_app owns type %.%', object_row.nspname, object_row.typname;
    END IF;
    IF has_type_privilege(app_oid, object_row.oid, 'USAGE') AND NOT expected_type THEN
      RAISE EXCEPTION 'PREFLIGHT: nexus_app has unexpected USAGE on type %.%', object_row.nspname, object_row.typname;
    END IF;
    IF require_grants AND object_row.nspname = 'nexus' THEN
      IF NOT expected_type THEN
        RAISE EXCEPTION 'FALHA: tipo não previsto no allowlist de nexus: %', object_row.typname;
      END IF;
      IF NOT has_type_privilege(app_oid, object_row.oid, 'USAGE') THEN
        RAISE EXCEPTION 'FALHA: nexus_app precisa de USAGE no tipo nexus.%', object_row.typname;
      END IF;
    END IF;
    IF object_row.typacl IS NOT NULL AND EXISTS (
      SELECT 1 FROM aclexplode(object_row.typacl) acl
       WHERE acl.grantee IN (0, app_oid) AND acl.is_grantable
    ) THEN
      RAISE EXCEPTION 'PREFLIGHT: nexus_app/PUBLIC has a type grant option on %.%', object_row.nspname, object_row.typname;
    END IF;
    IF object_row.nspname = 'nexus'
       AND object_row.typname IN ('tool_grant_status', 'tool_grant_action')
       AND object_row.typacl IS NOT NULL AND EXISTS (
         SELECT 1 FROM aclexplode(object_row.typacl) acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'USAGE'
       ) THEN
      RAISE EXCEPTION 'PREFLIGHT: PUBLIC has USAGE on restricted type nexus.%', object_row.typname;
    END IF;
  END LOOP;
  IF require_grants AND (
    SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'nexus' AND t.typtype = 'e'
  ) <> 16 THEN
    RAISE EXCEPTION 'FALHA: nexus tem número de enums divergente do allowlist (esperado 16)';
  END IF;

  -- SECURITY DEFINER routines are an escalation boundary. Only the specific
  -- zero-argument boolean readiness function is executable by nexus_app; every
  -- other SECURITY DEFINER function and PUBLIC remain denied. Ordinary invoker
  -- functions are not constrained by this check.
  FOR object_row IN
    SELECT p.oid, p.proname, p.proowner, p.prosecdef, p.proconfig, p.proacl,
           n.nspname, pg_get_userbyid(p.proowner) AS owner_name
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname !~ '^pg_'
       AND n.nspname <> 'information_schema'
  LOOP
    IF object_row.proowner = app_oid THEN
      RAISE EXCEPTION 'PREFLIGHT: nexus_app owns function %.%', object_row.nspname, object_row.proname;
    END IF;
    IF object_row.prosecdef THEN
      IF object_row.oid = readiness_function_oid THEN
        IF require_grants AND NOT has_function_privilege(app_oid, object_row.oid, 'EXECUTE') THEN
          RAISE EXCEPTION 'FALHA: nexus_app não pode executar a função autorizada nexus.migration_ledger_ready()';
        END IF;
      ELSIF has_function_privilege(app_oid, object_row.oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'PREFLIGHT: nexus_app can EXECUTE SECURITY DEFINER function %.%', object_row.nspname, object_row.proname;
      END IF;
      IF has_function_privilege('public', object_row.oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'PREFLIGHT: PUBLIC can EXECUTE SECURITY DEFINER function %.%', object_row.nspname, object_row.proname;
      END IF;
      IF object_row.nspname = 'nexus' THEN
        IF object_row.oid = readiness_function_oid THEN
          IF object_row.owner_name <> 'nexus_migrator' THEN
            RAISE EXCEPTION 'PREFLIGHT: SECURITY DEFINER function nexus.migration_ledger_ready() has owner %, expected nexus_migrator', object_row.owner_name;
          END IF;
        ELSIF object_row.proname = 'audit_tool_grant_change' THEN
          IF object_row.owner_name <> 'nexus_audit_writer' THEN
            RAISE EXCEPTION 'PREFLIGHT: SECURITY DEFINER function nexus.% has owner %, expected nexus_audit_writer', object_row.proname, object_row.owner_name;
          END IF;
        ELSIF object_row.owner_name <> 'nexus_migrator' THEN
          RAISE EXCEPTION 'PREFLIGHT: SECURITY DEFINER function nexus.% has owner %, expected nexus_migrator', object_row.proname, object_row.owner_name;
        END IF;
        IF object_row.proconfig IS NULL OR NOT (object_row.proconfig @> ARRAY['search_path=pg_catalog']) THEN
          RAISE EXCEPTION 'PREFLIGHT: SECURITY DEFINER function nexus.% lacks fixed search_path=pg_catalog', object_row.proname;
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- The readiness routine may execute only for its owner and nexus_app. This
  -- also rejects PUBLIC, unrelated roles, and EXECUTE grant options.
  IF readiness_function_oid IS NOT NULL AND EXISTS (
    SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
     WHERE p.oid = readiness_function_oid
       AND (acl.grantee NOT IN (app_oid, p.proowner)
         OR (acl.grantee = app_oid AND acl.is_grantable))
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT: migration readiness function has unexpected EXECUTE ACLs';
  END IF;

  IF require_grants AND (
    SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'nexus' AND p.prosecdef
  ) <> 4 THEN
    RAISE EXCEPTION 'FALHA: conjunto de funções SECURITY DEFINER de nexus diverge do allowlist (esperado 4)';
  END IF;
END
$nexus_app_privilege_contract$;
