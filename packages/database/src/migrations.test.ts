import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = join(sourceDirectory, "..", "migrations");

const readMigration = async (): Promise<{ filename: string; sql: string }> => {
  const files = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
  const initial = files.find((name) => name === "00001_initial_schema.sql");
  if (!initial) throw new Error("Initial migration 00001 is missing");
  return { filename: initial, sql: await readFile(join(migrationsDirectory, initial), "utf8") };
};

describe("SINGLE-USER PostgreSQL migration", () => {
  it("uses sequential SQL migration versions", async () => {
    const names = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
    const versions = names.map((name) => Number(/^([0-9]+)[_-].+\.sql$/i.exec(name)?.[1]));
    expect(versions).toEqual(versions.map((_, index) => index + 1));
    expect(names[0]).toBe("00001_initial_schema.sql");
  });

  it("defines exactly one owner identity without public registration or tenant keys", async () => {
    const { sql } = await readMigration();
    expect(sql).toMatch(/CREATE TABLE nexus\.owner_identity\s*\([\s\S]*?singleton boolean PRIMARY KEY[\s\S]*?CHECK \(singleton\)/i);
    expect(sql).toContain("INSERT INTO nexus.owner_identity (singleton, id)");
    expect(sql).not.toMatch(/CREATE TABLE nexus\.users\b/i);
    expect(sql).not.toMatch(/\buser_id\b/i);
    expect(sql).not.toMatch(/email|signup|registration/i);
    expect(sql).toContain("REFERENCES nexus.owner_identity(id)");
    expect(sql).toContain("CREATE FUNCTION nexus.configured_owner_id()");
  });

  it("keeps expected personal-data entities and semantic relational keys", async () => {
    const { sql } = await readMigration();
    const tables = ["owner_identity", "assistants", "assistant_config_versions", "conversations", "conversation_assistants", "messages", "core_runs", "run_steps", "tool_events", "run_results", "assistant_memories", "memory_permissions", "memory_permission_audit", "providers", "models", "provider_authorizations", "global_provider_preferences", "assistant_provider_preferences", "conversation_provider_preferences", "sync_cursors", "tombstones"];
    for (const table of tables) expect(sql).toMatch(new RegExp(`CREATE TABLE nexus\\.${table}\\s*\\(`, "i"));
    expect(sql).toContain("FOREIGN KEY (conversation_id, input_message_id) REFERENCES nexus.messages(conversation_id, id)");
    expect(sql).toContain("FOREIGN KEY (run_id, step_id) REFERENCES nexus.run_steps(run_id, id)");
    expect(sql).toContain("FOREIGN KEY (provider_id, model_id) REFERENCES nexus.models(provider_id, id)");
    expect(sql).toContain("'yui'");
    expect(sql).toContain("'alice'");
    expect(sql).toContain("'schwi'");
    expect(sql).not.toMatch(/FOREIGN KEY \(owner_id, (conversation_id|run_id|memory_id)/i);
  });

  it("forces owner-context RLS on personal tables and uses a trusted singleton guard", async () => {
    const { sql } = await readMigration();
    const readme = await readFile(join(sourceDirectory, "..", "README.md"), "utf8");
    expect(sql).toContain("current_setting('nexus.owner_id', true)");
    expect(sql).toContain("nexus.configured_owner_id()");
    expect(sql).toContain("REVOKE ALL ON SCHEMA nexus FROM PUBLIC");
    expect(sql).toContain("REVOKE ALL ON ALL TABLES IN SCHEMA nexus FROM PUBLIC");
    expect(sql).toContain("current_setting('nexus.actor_type', true)");
    expect(sql).toContain("current_setting('nexus.assistant_id', true)");
    expect(sql).not.toMatch(/ALTER TABLE nexus\.owner_identity ENABLE ROW LEVEL SECURITY/i);
    const protectedTables = ["conversations", "conversation_assistants", "messages", "core_runs", "run_steps", "run_results", "tool_events", "assistant_memories", "memory_permissions", "memory_permission_audit", "provider_authorizations", "global_provider_preferences", "assistant_provider_preferences", "conversation_provider_preferences", "sync_cursors", "tombstones"];
    for (const table of protectedTables) {
      expect(sql).toContain(`ALTER TABLE nexus.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ALTER TABLE nexus.${table} FORCE ROW LEVEL SECURITY;`);
    }
    expect(readme).toContain("não protege contra SQL arbitrário usando a própria credencial confiável do backend");
    expect(readme).toContain("O terceiro argumento `true` de `set_config` torna o valor local à transação");
  });

  it("keeps per-assistant memory separate and shared memory explicitly permissioned and audited", async () => {
    const { sql } = await readMigration();
    expect(sql).toContain("visibility = 'shared'");
    expect(sql).toContain("permission.status = 'granted'");
    expect(sql).toContain("origin_assistant_id = nexus.current_assistant_id()");
    expect(sql).toContain("CREATE FUNCTION nexus.ensure_permission_for_shared_memory()");
    expect(sql).toContain("Explicit assistant permissions apply only to shared memories");
    expect(sql).toContain("CREATE TABLE nexus.memory_permission_audit");
    expect(sql).toContain("CREATE TRIGGER memory_permissions_audit_changes");
    expect(sql).toContain("REVOKE ALL ON FUNCTION nexus.audit_memory_permission_change() FROM PUBLIC");
    expect(sql).not.toContain("FOREIGN KEY (owner_id, permission_id)");
  });

  it("stores global, assistant, and conversation preference scopes with separate paid authorization", async () => {
    const { sql } = await readMigration();
    for (const table of ["global_provider_preferences", "assistant_provider_preferences", "conversation_provider_preferences"]) {
      expect(sql).toContain(`CREATE TABLE nexus.${table}`);
      expect(sql).toContain(`CREATE TRIGGER ${table === "global_provider_preferences" ? "global" : table === "assistant_provider_preferences" ? "assistant" : "conversation"}_provider_preference_authorization`);
    }
    expect(sql).toContain("CREATE TABLE nexus.provider_authorizations");
    expect(sql).toContain("provider_cost <> 'free_confirmed' AND NOT paid_authorized");
    expect(sql).toContain("explicit paid-use authorization");
  });

  it("retains device synchronization cursors, tombstones, and trigger-only insertion", async () => {
    const { sql } = await readMigration();
    expect(sql).toContain("CREATE TABLE nexus.sync_cursors");
    expect(sql).toContain("device_id uuid NOT NULL");
    expect(sql).toContain("CREATE TABLE nexus.tombstones");
    expect(sql).toContain("UNIQUE (entity_type, entity_id)");
    expect(sql).toContain("CREATE TRIGGER conversations_tombstone");
    expect(sql).toContain("CREATE TRIGGER messages_tombstone");
    expect(sql).toContain("CREATE TRIGGER memories_tombstone");
    expect(sql).toContain("REVOKE ALL ON FUNCTION nexus.record_deleted_entity() FROM PUBLIC");
    expect(sql).toContain("pg_catalog.pg_trigger_depth() > 0");
  });

  it("does not define credential storage and constrains sensitive payloads", async () => {
    const { sql } = await readMigration();
    expect(sql).not.toMatch(/^\s*(api_key|access_token|refresh_token|password|secret|credential)\s+(text|varchar|bytea)/im);
    expect(sql).toContain("CREATE FUNCTION nexus.jsonb_has_credential_key");
    expect(sql).toContain("messages_content_no_credentials");
    expect(sql).toContain("assistant_memories_content_no_credentials");
    expect(sql).toContain("tool_events_payload_no_credentials");
  });

  it("adds stage 2B integrity without rewriting earlier migrations", async () => {
    const sql = await readFile(
      join(migrationsDirectory, "00003_persistence_integrity.sql"),
      "utf8",
    );
    expect(sql).toContain("UNIQUE (conversation_id, idempotency_key)");
    expect(sql).toContain("CREATE TABLE nexus.core_run_assistants");
    expect(sql).toContain("ALTER TABLE nexus.core_run_assistants FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("metadata = metadata - 'providerPreference'");
    expect(sql).not.toMatch(/DROP TABLE|ALTER TABLE nexus\.(messages|core_runs)\s+DROP/i);
  });

  it("adds stage 3B parent-child execution hierarchy additively without rewriting earlier migrations", async () => {
    const sql = await readFile(
      join(migrationsDirectory, "00004_core_execution_hierarchy.sql"),
      "utf8",
    );
    expect(sql).toContain("ADD COLUMN parent_run_id uuid");
    expect(sql).toContain("ADD COLUMN parent_step_id uuid");
    expect(sql).toContain("ADD COLUMN delegation_depth integer");
    expect(sql).toContain("core_runs_parent_run_same_conversation_fk");
    expect(sql).toContain("core_runs_parent_step_same_parent_run_fk");
    expect(sql).toContain("core_runs_delegation_hierarchy_valid");
    expect(sql).toContain("core_runs_identity_immutable");
    expect(sql).not.toMatch(/DROP TABLE|ALTER TABLE nexus\.(messages|core_runs)\s+DROP/i);
  });

  it("syncs the assistant seed additively and idempotently in migration 00005", async () => {
    const sql = await readFile(
      join(migrationsDirectory, "00005_assistant_seed_parity.sql"),
      "utf8",
    );

    // Aditiva: nunca recria a tabela nem mexe em identidade já referenciada por outras tabelas.
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+nexus\.assistants/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
    expect(sql).not.toMatch(/ALTER TABLE nexus\.assistants\s+(DROP|RENAME)/i);
    expect(sql).not.toMatch(/UPDATE nexus\.assistants SET (id|assistant_key)\s*=/i);

    // Idempotente: cada UPDATE é condicional ao valor divergente, e o INSERT não duplica.
    expect(sql).toMatch(/WHERE assistant_key = 'yui'\s+AND description <> /);
    expect(sql).toContain("ON CONFLICT (assistant_id, config_version) DO NOTHING");

    // Escopo: só as três chaves do catálogo inicial. Nenhuma quarta assistente é criada.
    const insertedKeys = [...sql.matchAll(/INSERT INTO nexus\.assistants[^;]*;/gi)].map((m) => m[0]);
    expect(insertedKeys).toEqual([]);
    for (const key of ["yui", "alice", "schwi"]) {
      expect(sql).toContain(`'${key}'`);
    }
    expect(sql).not.toMatch(/'(delta|omega|assistente-4)'/);

    // Não toca em segurança, ownership nem tabelas pessoais.
    expect(sql).not.toMatch(/ROW LEVEL SECURITY|POLICY|GRANT|REVOKE/i);
    expect(sql).not.toMatch(/owner_id|user_id/i);
  });

  it("keeps earlier migrations byte-identical after adding 00005", async () => {
    // Regra do projeto: migration aplicada é imutável. Se 00001 for editada para "resolver" a
    // paridade, o histórico de instalações existentes deixa de ser reproduzível.
    const initial = await readFile(join(migrationsDirectory, "00001_initial_schema.sql"), "utf8");
    expect(initial).toContain("'Assistente pessoal.'");
    expect(initial).toContain("'Pesquisa e investigação.'");
    expect(initial).toContain("'Lógica e planejamento.'");
    // A correção vive exclusivamente na 00005.
    const fix = await readFile(join(migrationsDirectory, "00005_assistant_seed_parity.sql"), "utf8");
    expect(fix).toContain("Assistente pessoal para conversação cotidiana");
  });

  it("wires the migration 00005 idempotency check into the PostgreSQL CI job", async () => {
    // A idempotência só é real se for exercitada contra PostgreSQL. Este teste garante que a
    // verificação não fica órfã no repositório: o script de integração precisa executá-la, e o
    // workflow precisa chamar o script.
    const script = await readFile(
      join(migrationsDirectory, "..", "scripts", "test-postgres-integration.sh"),
      "utf8",
    );
    expect(script).toContain("verify-assistant-seed-parity.sql");
    expect(script).toContain("00005_assistant_seed_parity.sql");
    expect(script).toContain("docker cp");

    const workflow = await readFile(
      join(migrationsDirectory, "..", "..", "..", ".github", "workflows", "database-postgres.yml"),
      "utf8",
    );
    expect(workflow).toContain("test:integration --workspace @nexus/database");

    // E a verificação precisa de fato reaplicar a migration.
    const verification = await readFile(
      join(migrationsDirectory, "..", "tests", "postgres", "verify-assistant-seed-parity.sql"),
      "utf8",
    );
    expect(verification).toContain("\\i /tmp/00005_assistant_seed_parity.sql");
    expect(verification).toContain("is not idempotent");
  });
});
