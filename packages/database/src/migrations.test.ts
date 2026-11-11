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

  it("keeps Phase 5 grants isolated by owner_id and audited append-only", async () => {
    const sql = await readFile(
      join(migrationsDirectory, "00007_tool_grants_and_preferences.sql"),
      "utf8",
    );

    // Identidade composta: `owner_id` entra na unicidade. Nenhuma das tabelas novas repete o
    // padrao legado de PK sem owner (`assistant_provider_preferences`), que so funciona porque
    // `owner_identity` e singleton.
    expect(sql).toContain("CONSTRAINT tool_grants_unique_scope UNIQUE (owner_id, assistant_id, tool_id)");
    expect(sql).toContain("PRIMARY KEY (owner_id, assistant_id)");

    // Estados temporalmente coerentes, concedidos sempre pelo proprio owner.
    expect(sql).toContain("tool_grants_state_coherent");
    expect(sql).toContain("CONSTRAINT tool_grants_granted_by_owner CHECK (granted_by_owner_id = owner_id)");
    expect(sql).toContain("CONSTRAINT tool_grants_revoked_by_owner");

    // RLS forçada nas tres tabelas.
    for (const table of ["tool_grants", "tool_grant_audit", "user_assistant_preferences"]) {
      expect(sql).toContain(`ALTER TABLE nexus.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ALTER TABLE nexus.${table} FORCE ROW LEVEL SECURITY;`);
    }

    // Escrita de grant exige actor owner; leitura de grant tambem (variante estrita).
    // As 4 policies de `tool_grants` ficam entre o CREATE TABLE e o bloco da auditoria.
    const grantsPolicies = sql.slice(
      sql.indexOf("CREATE POLICY tool_grants_owner_select"),
      sql.indexOf("-- Append-only: existem apenas policies de SELECT e INSERT"),
    );
    // 4 policies; a de UPDATE aparece duas vezes porque exige `actor_type = 'owner'` tanto no
    // USING (quais linhas pode alterar) quanto no WITH CHECK (como a linha pode ficar).
    expect((grantsPolicies.match(/CREATE POLICY/g) ?? []).length).toBe(4);
    expect(grantsPolicies.match(/nexus\.current_actor_type\(\) = 'owner'/g)?.length).toBe(5);

    // Preferencias: leitura sem exigir actor_type (o CORE le com actor assistant), escrita exigindo.
    const prefSelect = sql.slice(
      sql.indexOf("CREATE POLICY user_assistant_preferences_select"),
      sql.indexOf("CREATE POLICY user_assistant_preferences_owner_insert"),
    );
    expect(prefSelect).not.toContain("current_actor_type");

    // Auditoria append-only: nenhuma policy de UPDATE/DELETE na tabela de audit.
    const auditPolicies = sql.slice(
      sql.indexOf("ALTER TABLE nexus.tool_grant_audit ENABLE ROW LEVEL SECURITY"),
      sql.indexOf("ALTER TABLE nexus.user_assistant_preferences ENABLE ROW LEVEL SECURITY"),
    );
    expect(auditPolicies).toContain("CREATE POLICY tool_grant_audit_owner_select");
    expect(auditPolicies).not.toMatch(/FOR (UPDATE|DELETE)/);
    // INSERT existe, mas escopado ao papel escritor da trilha: NAO para nexus_app nem para o
    // dono do schema. E o que permite a funcao SECURITY DEFINER gravar com FORCE RLS sem
    // SUPERUSER/BYPASSRLS (ver secao 2.1 da migration).
    expect(auditPolicies).toContain("CREATE POLICY tool_grant_audit_writer_insert");
    // A policy deixou de ser `WITH CHECK (true)`: agora exige coerencia com o contexto da
    // transacao. Verificamos o essencial sem acoplar o teste a formatacao. (O texto
    // `WITH CHECK (true)` citado em COMENTARIO e o registro historico da mudanca, nao a policy.)
    expect(auditPolicies).not.toContain("TO nexus_audit_writer WITH CHECK (true)");
    expect(auditPolicies).toContain("FOR INSERT TO nexus_audit_writer WITH CHECK (");
    expect(auditPolicies).toContain("owner_id = nexus.current_owner_id()");
    expect(auditPolicies).toContain("owner_id = nexus.configured_owner_id()");
    expect(auditPolicies).toContain("actor_owner_id = owner_id");
    expect(auditPolicies).toContain("nexus.current_owner_id() IS NOT NULL");

    // O lifecycle rejeita `granted -> granted` (inclusive tocar so `updated_at`).
    expect(sql).toContain(
      "Active tool grant is immutable: the only allowed update is granted -> revoked",
    );

    // Sem conversao implicita entre os dois enums: o mapeamento e explicito por CASE.
    // (A string antiga aparece apenas em comentario explicando a troca.)
    expect(sql).not.toContain("audit_action := NEW.status::text::nexus.tool_grant_action");
    expect(sql).toContain("audit_action := CASE NEW.status");

    // O provisionamento NAO usa `ALTER ROLE` para reafirmar atributos: isso exige privilegios
    // que um provisionador apenas com CREATEROLE nao tem. Em vez disso, verifica e falha.
    // Procura o COMANDO (linha sem `--`), nao a mencao em comentario.
    expect(sql).not.toMatch(/^ALTER ROLE nexus_audit_writer\s+NOLOGIN/m);
    expect(sql).toContain("has unsafe attributes");

    // Funcao privilegiada restrita: SECURITY DEFINER com search_path fixo e sem PUBLIC.
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("SET search_path = pg_catalog");
    expect(sql).toContain("REVOKE ALL ON FUNCTION nexus.audit_tool_grant_change() FROM PUBLIC");

    // Estruturas explicitamente descartadas nao podem reaparecer.
    for (const forbidden of ["user_assistant_settings", "tool_definitions", "tool_confirmations", "assistant_capabilities", "conversation_settings"]) {
      expect(sql).not.toContain(`CREATE TABLE nexus.${forbidden}`);
    }

    // O verificador precisa ser executado pelo script de integracao, senao fica orfao.
    const script = await readFile(
      join(migrationsDirectory, "..", "scripts", "test-postgres-integration.sh"),
      "utf8",
    );
    expect(script).toContain("verify-stage-5-rls.sql");
    // A prova do EFEITO da exclusao do owner vive em arquivo proprio, executado como `postgres`,
    // porque `nexus_app` nao pode apagar `owner_identity`. O nome diz o que o arquivo comprova:
    // NAO que "excluir o owner com dados funciona" — isso falha hoje.
    expect(script).toContain("verify-stage-5-owner-deletion.sql");
    expect(script).not.toContain("verify-stage-5-cascade.sql");
    // E precisa vir ANTES do teste de RLS: o de exclusao do owner exige as tabelas da Fase 5
    // vazias, enquanto o de RLS as deixa populadas. A comparacao usa a LINHA DE EXECUCAO
    // (`-f - < ...`), nao a primeira mencao ao nome: os comentarios citam os dois arquivos e
    // tornariam o teste dependente de ordem de texto, nao de ordem de execucao.
    const ownerDeletionExec = script.indexOf("postgres -d nexus_test -f - < \"$database_package_dir/tests/postgres/verify-stage-5-owner-deletion.sql");
    const rlsExec = script.indexOf("nexus_app -d nexus_test -f - < \"$database_package_dir/tests/postgres/verify-stage-5-rls.sql");
    expect(ownerDeletionExec).toBeGreaterThan(-1);
    expect(rlsExec).toBeGreaterThan(-1);
    expect(ownerDeletionExec).toBeLessThan(rlsExec);

    // A comparacao de `confdeltype` precisa tratar NULL: se a constraint nao existir, o valor e
    // NULL e `NULL <> 'c'` nao dispara o RAISE. Regressao silenciosa no caso mais grave.
    const rlsVerification = await readFile(
      join(migrationsDirectory, "..", "tests", "postgres", "verify-stage-5-rls.sql"),
      "utf8",
    );
    expect(rlsVerification).toContain("delete_rule_grants IS DISTINCT FROM 'c'");
    expect(rlsVerification).not.toMatch(/delete_rule_\w+ <> 'c'/);

    // O verificador de exclusao do owner precisa continuar HONESTO sobre o que cobre: registra a
    // falha atual (23503) em vez de apenas contornar a limitacao dos triggers de tombstone.
    const ownerDeletion = await readFile(
      join(migrationsDirectory, "..", "tests", "postgres", "verify-stage-5-owner-deletion.sql"),
      "utf8",
    );
    // B2: o desfecho com dados presentes e ASSERCAO, nao comentario.
    //
    // HISTORICO. Ate a migration 00008, este bloco exigia que a exclusao FALHASSE e aceitava um
    // conjunto fechado de dois SQLSTATEs (23503 com um runner SUPERUSER, que contorna RLS e chega
    // a FK `tombstones_owner_id_fkey`; 42501 com um runner nao-superuser, que e o caso de
    // producao, onde a policy de INSERT de `tombstones` barra antes da FK). O R42 reconciliou a
    // assercao para 42501.
    //
    // A 00008 CORRIGE o defeito, entao a assercao mudou de sentido: agora e preciso que a exclusao
    // CONCLUA. Ela continua sendo verificacao estrita — exige UM ROW_COUNT, ausencia de SQLSTATE,
    // e o estado pos-exclusao conferido (owner, mensagens, conversas, memorias, tombstones a zero;
    // catalogo global intacto). Se a regressao voltar, o bloco falha dizendo que a 00008 sumiu.
    expect(ownerDeletion).toContain("Owner deletion FAILED with data present");
    expect(ownerDeletion).toContain("Migration 00008 is missing or was reverted");
    expect(ownerDeletion).toContain("GET STACKED DIAGNOSTICS");
    expect(ownerDeletion).toContain("IF removidas <> 1 THEN");
    // A prova de que o teste nao e vacuidade: a restauracao pos-ROLLBACK e verificada em conteudo.
    expect(ownerDeletion).toContain("ROLLBACK did not restore tombstones content");
    expect(ownerDeletion).toContain("§3 OK: deletion works with data present");
    // B1: a limpeza se declara contorno, e nao cenario real.
    expect(ownerDeletion).toContain("bypassed the tombstone limitation");
    // D: a contagem de tombstones e verificada nos tres pontos.
    expect(ownerDeletion).toContain("tombstones_before");
    expect(ownerDeletion).toContain("Cleanup should have added");
    // C: o efeito do trigger BEFORE DELETE de `messages` sobre `source_message_id` e testado.
    expect(ownerDeletion).toContain("BEFORE DELETE trigger did not clear source_message_id");
    // A/5: o ROLLBACK e validado nas oito entidades, inclusive `source_message_id`.
    for (const entity of [
      "owner_identity", "tool_grants", "tool_grant_audit", "user_assistant_preferences",
      "tombstones", "messages", "conversations", "assistant_memories",
    ]) {
      expect(ownerDeletion).toContain(`ROLLBACK did not restore ${entity}`);
    }
    expect(ownerDeletion).toContain("ROLLBACK did not restore assistant_memories.source_message_id");
    // 6: sequences nao sao transacionais — nenhuma assinatura pode incluir esses valores.
    expect(ownerDeletion).toContain("to_jsonb(a) - 'id'");
    expect(ownerDeletion).toContain("to_jsonb(t) - 'sequence'");
    expect(ownerDeletion).not.toMatch(/max\(\s*(sequence|id)\s*\)/i);
    // 7: a prova de que excluir um grant preserva a auditoria continua presente.
    expect(ownerDeletion).toContain("Deleting a grant erased its audit history");

    // --- ciclo de vida estrito (revisao tecnica) -------------------------------------------
    expect(sql).toContain("Revoked tool grant is immutable");
    expect(sql).toContain("Tool grant provenance is immutable");
    expect(sql).toContain("Revocation requires both revoked_by_owner_id and revoked_at");
    expect(sql).toContain("An active tool grant cannot carry revocation markers");
    // A transicao permitida continua sendo uma so.
    expect(sql).toContain("IF OLD.status = 'revoked' THEN");

    // --- papel escritor da trilha ---------------------------------------------------------
    expect(sql).toContain("nexus_audit_writer");
    expect(sql).toContain("ALTER ROLE nexus_audit_writer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE");
    expect(sql).toContain("ALTER FUNCTION nexus.audit_tool_grant_change() OWNER TO nexus_audit_writer");
    // Nunca resolver por privilegio excessivo. A verificacao e por COMANDO efetivo (linha que
    // nao seja comentario), nao por mencao em prosa: os comentarios citam SUPERUSER/BYPASSRLS
    // justamente para explicar por que NAO sao usados.
    const sqlCommands = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(sqlCommands).not.toMatch(/GRANT\s+\w*BYPASSRLS/i);
    expect(sqlCommands).not.toMatch(/ALTER\s+ROLE\s+\w+\s+[^;]*\bSUPERUSER\b(?!\s*,?\s*NO)/i);
    expect(sqlCommands).not.toContain("ALTER ROLE nexus_app");
    // O papel escritor e explicitamente restrito.
    expect(sqlCommands).toMatch(/ALTER ROLE nexus_audit_writer NOLOGIN NOSUPERUSER NOBYPASSRLS/);

    // --- ACL dos enums --------------------------------------------------------------------
    expect(sql).toContain("REVOKE ALL ON TYPE nexus.tool_grant_status FROM PUBLIC");
    expect(sql).toContain("REVOKE ALL ON TYPE nexus.tool_grant_action FROM PUBLIC");
    expect(sql).toContain("GRANT USAGE ON TYPE nexus.tool_grant_status TO nexus_audit_writer");
    expect(sql).toContain("GRANT USAGE ON TYPE nexus.tool_grant_status TO nexus_app");

    // --- display_label: branco apenas e rejeitado (btrim nao cobre TAB) --------------------
    expect(sql).toContain("CONSTRAINT user_assistant_preferences_label_not_blank");
    expect(sql).toContain("display_label ~ '[^[:space:]]'");

    // --- os tres verificadores novos precisam estar no script ------------------------------
    for (const file of [
      "verify-stage-5-grants-lifecycle.sql",
      "verify-stage-5-preferences.sql",
      "verify-stage-5-cascade-without-delete-policy.sql",
    ]) {
      expect(script).toContain(file);
    }
    expect(script).toContain("verify-stage-5-grants-lifecycle.sql");
  });
});

// =============================================================================================
// Correcao do DEFEITO DO OWNER (migration 00008)
// =============================================================================================
// O defeito: `DELETE FROM nexus.owner_identity` falhava com SQLSTATE 42501 por causa da policy
// de INSERT de `tombstones`, tornando a instalacao permanentemente nao-excluivel. Estes testes
// travam a correcao e, tao importante quanto, travam o que a correcao NAO pode ter feito:
// ampliar privilegio, afrouxar policy ou desligar RLS.
describe("owner deletion fix (migration 00008)", () => {
  const readFix = async (): Promise<string> =>
    readFile(join(migrationsDirectory, "00008_owner_deletion_tombstone_guard.sql"), "utf8");

  it("is a sequential migration that only replaces the tombstone trigger function", async () => {
    const names = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
    expect(names).toContain("00008_owner_deletion_tombstone_guard.sql");
    // Sequencial e sem lacuna: a lista de teste da versao ja garante isso para toda a pasta.
    const versions = names.map((name) => Number(/^([0-9]+)[_-].+\.sql$/i.exec(name)?.[1]));
    expect(versions).toEqual(versions.map((_, index) => index + 1));

    const sql = await readFix();
    // Uma unica instrucao efetiva. A correcao nao pode "trazer junto" estrutura nova.
    expect(sql).toContain("CREATE OR REPLACE FUNCTION nexus.record_deleted_entity()");

    const commands = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    // Nada de DDL estrutural: nenhuma tabela, coluna, policy, papel ou ACL.
    expect(commands).not.toMatch(/CREATE\s+TABLE/i);
    expect(commands).not.toMatch(/CREATE\s+POLICY/i);
    expect(commands).not.toMatch(/DROP\s+POLICY/i);
    expect(commands).not.toMatch(/CREATE\s+ROLE/i);
    expect(commands).not.toMatch(/ALTER\s+ROLE/i);
    expect(commands).not.toMatch(/\bGRANT\b/i);
    expect(commands).not.toMatch(/\bREVOKE\b/i);
    expect(commands).not.toMatch(/DISABLE\s+TRIGGER/i);
    expect(commands).not.toMatch(/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    expect(commands).not.toMatch(/ALTER\s+TABLE/i);
    // E nenhum privilegio amplo em COMANDO efetivo. A verificacao e sobre `commands`, nao sobre
    // `sql`: os comentarios citam BYPASSRLS/SUPERUSER justamente para explicar por que NAO sao
    // usados, e uma assercao sobre o texto integral proibiria explicar a decisao.
    expect(commands).not.toMatch(/\bBYPASSRLS\b(?!\s*=\s*false)/i);
    expect(commands).not.toMatch(/\bSUPERUSER\b(?!\s*=\s*false)/i);
  });

  it("keeps the function SECURITY DEFINER and adds only an owner-existence guard", async () => {
    const sql = await readFix();
    // Preserva as propriedades da funcao original: se perdesse SECURITY DEFINER, o INSERT em
    // `tombstones` passaria a rodar como o chamador e a policy de INSERT (que exige o papel
    // escritor) recusaria tombstones legitimos.
    expect(sql).toMatch(/SECURITY\s+DEFINER/i);
    expect(sql).toContain("SET search_path = pg_catalog");
    // O guard e a unica condicao acrescentada.
    expect(sql).toContain("IF NOT EXISTS (SELECT 1 FROM nexus.owner_identity WHERE id = OLD.owner_id) THEN");
    // O INSERT original continua intacto, inclusive o ON CONFLICT.
    expect(sql).toContain("INSERT INTO nexus.tombstones (id, owner_id, entity_type, entity_id)");
    expect(sql).toContain("ON CONFLICT (entity_type, entity_id) DO NOTHING");
    // A funcao continua devolvendo OLD no caminho do guard: um trigger AFTER DELETE nao pode
    // devolver NULL.
    expect(sql).toMatch(/THEN\s+RETURN\s+OLD;\s+END\s+IF;/i);
  });

  it("documents the measured cause (42501) instead of the previously documented 23503", async () => {
    const sql = await readFix();
    // A documentacao anterior dizia 23503 (violacao da FK `tombstones_owner_id_fkey`). A causa
    // medida e a policy de INSERT; a FK nunca chega a ser avaliada.
    expect(sql).toContain("42501");
    expect(sql).toContain("configured_owner_id()");
    // E precisa dizer POR QUE o 23503 e inalcancavel, nao apenas trocar o numero.
    expect(sql).toMatch(/23503[\s\S]{0,200}INALCANCAVEL/i);
  });

  it("ships a verifier that is wired into the integration runner as the last step", async () => {
    const script = await readFile(
      join(migrationsDirectory, "..", "scripts", "test-postgres-integration.sh"),
      "utf8",
    );
    expect(script).toContain("00001 through 00008");
    expect(script).toContain("verify-owner-deletion.sql");

    // O verificador COMINTA a exclusao do owner: depois dele nao existe mais owner. Se qualquer
    // verificador rodasse depois, falharia por ausencia de dados e nao por defeito real.
    const execLine = 'psql -X -w -v ON_ERROR_STOP=1 -U nexus_migrator -d nexus_test -f - < "$database_package_dir/tests/postgres/verify-owner-deletion.sql"';
    const execIndex = script.indexOf(execLine);
    expect(execIndex).toBeGreaterThan(-1);
    // E a ultima LINHA DE EXECUCAO do arquivo (comentarios depois nao contam como execucao).
    const after = script.slice(execIndex + execLine.length);
    const remainingExecs = after
      .split("\n")
      .filter((line) => line.trimStart().startsWith("docker exec"));
    expect(remainingExecs).toEqual([]);

    // Roda como o DONO do schema (nao-superuser), nunca como `postgres`: e o papel real de
    // operacao, e um runner superusuario contornaria RLS e mascararia regressao.
    expect(execLine).toContain("-U nexus_migrator");
    expect(execLine).not.toContain("-U postgres");
  });

  it("proves the deletion outcome, not merely that the DELETE statement succeeded", async () => {
    const verifier = await readFile(
      join(migrationsDirectory, "..", "tests", "postgres", "verify-owner-deletion.sql"),
      "utf8",
    );

    // 1. Pre-condicao: recusa rodar como superusuario ou com BYPASSRLS.
    expect(verifier).toContain("is SUPERUSER");
    expect(verifier).toContain("has it");
    // 2. Recusa rodar se a 00008 nao estiver aplicada — senao testaria a versao defeituosa.
    expect(verifier).toContain("does not carry the owner-existence guard");

    // 3. Popula TODAS as tabelas de owner antes de excluir. Uma exclusao que funciona com o
    //    banco vazio nao prova nada.
    for (const table of [
      "conversations", "conversation_assistants", "messages", "core_runs", "run_steps",
      "run_results", "tool_events", "assistant_memories", "memory_permissions",
      "memory_permission_audit", "conversation_provider_preferences",
      "assistant_provider_preferences", "global_provider_preferences",
      "provider_authorizations", "sync_cursors", "tombstones", "tool_grants",
      "tool_grant_audit", "user_assistant_preferences",
    ]) {
      expect(verifier).toContain(`('${table}')`);
    }

    // 4. Os cenarios obrigatorios existem e sao assertados, um a um.
    expect(verifier).toContain("§2 OK: invalid context removes nothing and preserves the owner");
    expect(verifier).toContain("§3 OK: nexus_app denied with SQLSTATE 42501");
    expect(verifier).toContain("§4 OK: owner without data deleted cleanly");
    expect(verifier).toContain("§5 OK: owner deleted with all 19 owner tables populated");
    expect(verifier).toContain("§6 OK: induced failures rolled back completely");
    expect(verifier).toContain("§7 OK: personal data erased, global catalog preserved");
    expect(verifier).toContain("§8 OK: no role holds SUPERUSER/BYPASSRLS");

    // 5. Atomicidade e verificada por CONTEUDO (jsonb), nao por contagem: contagem igual com
    //    conteudo diferente esconderia corrupcao silenciosa.
    expect(verifier).toContain("jsonb_agg");
    expect(verifier).toContain("IS DISTINCT FROM b.convs");

    // 6. A retencao de `tool_grant_audit` esta declarada como decisao pendente, e o verificador
    //    falha se ela mudar sem que o arquivo mude.
    expect(verifier).toContain("tool_grant_audit retention changed");
    expect(verifier).toMatch(/RETENCAO PENDENTE DE DECISAO DE PRODUTO/i);

    // 7. O catalogo GLOBAL e assertado como preservado, e o provider de prova como sobrevivente.
    expect(verifier).toContain("Owner deletion changed the GLOBAL assistant catalog");
    expect(verifier).toContain("does not belong to the owner");
  });
});
