-- =============================================================================
-- NEXUS — preflight administrativo, somente-leitura
-- =============================================================================
-- Executar como o administrador/owner antes de criar papéis, definir senhas ou
-- aplicar migrations. O instalador também chama o preflight do ledger local.
-- Nenhum objeto, ACL, senha ou dado é alterado por este arquivo.
-- =============================================================================
\set ON_ERROR_STOP on
\pset footer off

DO $nexus_production_preflight$
DECLARE
  admin_role record;
  role_spec record;
  actual_role record;
  membership_errors text[];
  missing_roles text[];
  expected_owner oid;
  db_owner oid;
  ledger_oid oid;
  ledger_schema_owner oid;
  ledger_table_owner oid;
  checksum_column boolean;
  row_info record;
  expected_version integer := 1;
  expected_filename text;
  ledger_rows integer := 0;
BEGIN
  IF current_setting('server_version_num')::integer < 160000 THEN
    RAISE EXCEPTION 'PREFLIGHT: PostgreSQL 16 ou superior é obrigatório (membership SET/INHERIT options)';
  END IF;

  SELECT * INTO admin_role FROM pg_roles WHERE rolname = current_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PREFLIGHT: papel administrativo efetivo % não existe', current_user;
  END IF;
  IF NOT admin_role.rolsuper AND NOT admin_role.rolcreaterole THEN
    RAISE EXCEPTION 'PREFLIGHT: % precisa ser SUPERUSER ou ter CREATEROLE para provisionar os papéis NEXUS', current_user;
  END IF;

  SELECT datdba INTO db_owner FROM pg_database WHERE datname = current_database();
  IF db_owner <> admin_role.oid AND NOT admin_role.rolsuper THEN
    RAISE EXCEPTION 'PREFLIGHT: % não é owner do banco %; o instalador precisa conceder CREATE/CONNECT no banco', current_user, current_database();
  END IF;

  SELECT array_agg(v.rolname ORDER BY v.rolname) INTO missing_roles
    FROM (VALUES ('nexus_migrator'::text), ('nexus_app'), ('nexus_audit_writer'), ('nexus_anonymous')) v(rolname)
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = v.rolname);
  IF missing_roles IS NOT NULL AND NOT admin_role.rolsuper AND NOT admin_role.rolcreaterole THEN
    RAISE EXCEPTION 'PREFLIGHT: % precisa de CREATEROLE para criar os papéis ausentes: %', current_user, missing_roles;
  END IF;

  -- Existing roles are never silently ALTER ROLE'd. Any mismatch stops before
  -- passwords or migrations; the exact expected attributes are the contract.
  FOR role_spec IN
    SELECT * FROM (VALUES
      ('nexus_migrator'::text, true,  false, false, false, false, false, false),
      ('nexus_app'::text,      true,  false, false, false, false, false, false),
      ('nexus_audit_writer'::text, false, false, false, false, false, false, false),
      ('nexus_anonymous'::text,    false, false, false, false, false, false, false)
    ) AS v(rolname, canlogin, superuser, bypassrls, createdb, createrole, inherit, replication)
  LOOP
    SELECT * INTO actual_role FROM pg_roles WHERE rolname = role_spec.rolname;
    IF FOUND THEN
      IF ROW(actual_role.rolcanlogin, actual_role.rolsuper, actual_role.rolbypassrls,
             actual_role.rolcreatedb, actual_role.rolcreaterole,
             actual_role.rolinherit, actual_role.rolreplication)
          IS DISTINCT FROM
          ROW(role_spec.canlogin, role_spec.superuser, role_spec.bypassrls,
              role_spec.createdb, role_spec.createrole, role_spec.inherit,
              role_spec.replication) THEN
        RAISE EXCEPTION 'PREFLIGHT: papel % tem atributos divergentes; esperado LOGIN=%, SUPERUSER=%, BYPASSRLS=%, CREATEDB=%, CREATEROLE=%, INHERIT=%, REPLICATION=%',
          role_spec.rolname, role_spec.canlogin, role_spec.superuser, role_spec.bypassrls,
          role_spec.createdb, role_spec.createrole, role_spec.inherit, role_spec.replication;
      END IF;
    END IF;
  END LOOP;

  -- Only this edge is part of the role contract. External superusers may have
  -- redundant memberships in managed roles; they already have unrestricted
  -- authority and are excluded from the unexpected-edge list.
  SELECT array_agg(format('%s -> %s [ADMIN=%s, INHERIT=%s, SET=%s]',
                          child.rolname, parent.rolname,
                          am.admin_option, am.inherit_option, am.set_option)
                   ORDER BY child.rolname, parent.rolname)
    INTO membership_errors
    FROM pg_auth_members am
    JOIN pg_roles child ON child.oid = am.member
    JOIN pg_roles parent ON parent.oid = am.roleid
   WHERE (child.rolname = ANY(ARRAY['nexus_migrator','nexus_app','nexus_audit_writer','nexus_anonymous'])
       OR parent.rolname = ANY(ARRAY['nexus_migrator','nexus_app','nexus_audit_writer','nexus_anonymous']))
     AND NOT (child.rolname = 'nexus_migrator'
          AND parent.rolname = 'nexus_audit_writer'
          AND am.set_option AND NOT am.inherit_option AND NOT am.admin_option)
     AND NOT (child.rolsuper AND child.rolname NOT IN
          ('nexus_migrator','nexus_app','nexus_audit_writer','nexus_anonymous'));
  IF membership_errors IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: memberships inesperadas ou opções divergentes: %', membership_errors;
  END IF;

  -- The NOLOGIN anonymous role is deliberately unprivileged. A direct or
  -- inherited schema grant would make the production ACL diverge from the
  -- integration contract, so stop before passwords or migrations.
  IF to_regnamespace('nexus') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_anonymous')
     AND has_schema_privilege('nexus_anonymous', 'nexus', 'USAGE') THEN
    RAISE EXCEPTION 'PREFLIGHT: nexus_anonymous has USAGE on schema nexus';
  END IF;

  -- Re-running GRANT is not needed when the exact edge already exists. If it
  -- must be created, the admin must have ADMIN OPTION on the target role.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_audit_writer')
     AND NOT EXISTS (
       SELECT 1
         FROM pg_auth_members am
         JOIN pg_roles parent ON parent.oid = am.roleid
         JOIN pg_roles child ON child.oid = am.member
        WHERE parent.rolname = 'nexus_audit_writer'
          AND child.rolname = 'nexus_migrator'
          AND am.set_option AND NOT am.inherit_option AND NOT am.admin_option
     )
     AND NOT admin_role.rolsuper
     AND NOT EXISTS (
       SELECT 1 FROM pg_auth_members am
        WHERE am.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'nexus_audit_writer')
          AND am.member = admin_role.oid
          AND am.admin_option
     ) THEN
    RAISE EXCEPTION 'PREFLIGHT: % precisa de ADMIN OPTION em nexus_audit_writer para criar a membership nexus_migrator -> nexus_audit_writer', current_user;
  END IF;

  -- Existing NEXUS objects must already have the ownership required by the
  -- migrations. The installer never REASSIGNs ownership automatically.
  SELECT oid INTO expected_owner FROM pg_roles WHERE rolname = 'nexus_migrator';
  IF to_regnamespace('nexus') IS NOT NULL THEN
    IF expected_owner IS NULL THEN
      RAISE EXCEPTION 'PREFLIGHT: schema nexus existe, mas nexus_migrator não existe';
    END IF;
    IF (SELECT nspowner FROM pg_namespace WHERE nspname = 'nexus') <> expected_owner THEN
      RAISE EXCEPTION 'PREFLIGHT: schema nexus não pertence a nexus_migrator; nenhuma ownership será alterada automaticamente';
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'nexus'
         AND c.relkind IN ('r','p','v','m','f','S')
         AND c.relowner <> expected_owner
    ) THEN
      RAISE EXCEPTION 'PREFLIGHT: uma ou mais tabelas/sequências de nexus não pertencem a nexus_migrator';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'nexus' AND t.typtype IN ('e','d','r','m')
         AND t.typowner <> expected_owner
    ) THEN
      RAISE EXCEPTION 'PREFLIGHT: um ou mais tipos de nexus não pertencem a nexus_migrator';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_roles owner_role ON owner_role.oid = p.proowner
       WHERE n.nspname = 'nexus'
         AND ((p.proname = 'audit_tool_grant_change' AND owner_role.rolname <> 'nexus_audit_writer')
           OR (p.proname <> 'audit_tool_grant_change' AND p.proowner <> expected_owner))
    ) THEN
      RAISE EXCEPTION 'PREFLIGHT: ownership de uma ou mais funções de nexus diverge do contrato';
    END IF;
  END IF;

  -- The ledger is owned by the migration role. Existing rows must be an exact
  -- contiguous prefix with the immutable filenames; checksum verification is
  -- performed by migrate.sh against the checked-out migration files.
  IF to_regnamespace('nexus_migrations') IS NOT NULL THEN
    SELECT nspowner INTO ledger_schema_owner FROM pg_namespace WHERE nspname = 'nexus_migrations';
    IF expected_owner IS NULL THEN
      RAISE EXCEPTION 'PREFLIGHT: schema nexus_migrations existe, mas nexus_migrator não existe';
    END IF;
    IF ledger_schema_owner <> expected_owner THEN
      RAISE EXCEPTION 'PREFLIGHT: schema nexus_migrations não pertence a nexus_migrator';
    END IF;
  END IF;

  ledger_oid := to_regclass('nexus_migrations.schema_migrations');
  IF ledger_oid IS NULL THEN
    IF to_regnamespace('nexus') IS NOT NULL THEN
      RAISE EXCEPTION 'PREFLIGHT: schema nexus existe sem ledger nexus_migrations.schema_migrations; estado divergente, não reaplicar migrations';
    END IF;
  ELSE
    IF (SELECT relkind FROM pg_class WHERE oid = ledger_oid) <> 'r' THEN
      RAISE EXCEPTION 'PREFLIGHT: nexus_migrations.schema_migrations não é tabela';
    END IF;
    SELECT relowner INTO ledger_table_owner FROM pg_class WHERE oid = ledger_oid;
    IF expected_owner IS NULL OR ledger_table_owner <> expected_owner THEN
      RAISE EXCEPTION 'PREFLIGHT: ledger não pertence a nexus_migrator';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = ledger_oid AND attname = 'version' AND attnum > 0 AND NOT attisdropped)
       OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = ledger_oid AND attname = 'filename' AND attnum > 0 AND NOT attisdropped)
       OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = ledger_oid AND attname = 'applied_at' AND attnum > 0 AND NOT attisdropped) THEN
      RAISE EXCEPTION 'PREFLIGHT: formato do ledger divergente (esperados version, filename, applied_at)';
    END IF;
    SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = ledger_oid AND attname = 'checksum' AND attnum > 0 AND NOT attisdropped)
      INTO checksum_column;

    FOR row_info IN EXECUTE 'SELECT version, filename FROM nexus_migrations.schema_migrations ORDER BY version' LOOP
      expected_filename := CASE expected_version
        WHEN 1 THEN '00001_initial_schema.sql'
        WHEN 2 THEN '00002_auth_security.sql'
        WHEN 3 THEN '00003_persistence_integrity.sql'
        WHEN 4 THEN '00004_core_execution_hierarchy.sql'
        WHEN 5 THEN '00005_assistant_seed_parity.sql'
        WHEN 6 THEN '00006_assistant_seed_vivy.sql'
        WHEN 7 THEN '00007_tool_grants_and_preferences.sql'
        WHEN 8 THEN '00008_owner_deletion_tombstone_guard.sql'
        ELSE NULL
      END;
      IF expected_filename IS NULL
         OR row_info.version IS DISTINCT FROM expected_version
         OR row_info.filename IS DISTINCT FROM expected_filename THEN
        RAISE EXCEPTION 'PREFLIGHT: ledger divergente na versão % (filename=%; esperado versão contígua % / %)', row_info.version, row_info.filename, expected_version, expected_filename;
      END IF;
      expected_version := expected_version + 1;
      ledger_rows := ledger_rows + 1;
    END LOOP;

    IF ledger_rows > 0 AND to_regnamespace('nexus') IS NULL THEN
      RAISE EXCEPTION 'PREFLIGHT: ledger tem % registros, mas o schema nexus não existe', ledger_rows;
    END IF;
    IF ledger_rows = 0 AND to_regnamespace('nexus') IS NOT NULL THEN
      RAISE EXCEPTION 'PREFLIGHT: ledger vazio com schema nexus existente; estado possivelmente parcial/ambíguo';
    END IF;
    IF ledger_rows = 8 AND NOT checksum_column THEN
      RAISE NOTICE 'PREFLIGHT: ledger legado completo sem checksums; instalação exigirá --adopt-legacy-ledger após verificação integral';
    ELSIF ledger_rows > 0 AND NOT checksum_column THEN
      RAISE EXCEPTION 'PREFLIGHT: ledger parcial sem checksums; recuperação automática insegura';
    END IF;
  END IF;
END
$nexus_production_preflight$;

\echo '== Preflight: requisitos administrativos, papéis, ownership e ledger OK =='
\ir assert_app_privileges.sql
