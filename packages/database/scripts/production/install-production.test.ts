import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = new URL(".", import.meta.url).pathname;
const script = `${here}install-production.sh`;
const migrationDir = `${here}../../migrations`;

describe("install-production.sh — fluxo e falhas explícitas", () => {
  let fakeBin: string;
  let workdir: string;
  let psqlPath: string;

  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), "nexus-install-production-test-"));
    fakeBin = join(workdir, "bin");
    execFileSync("mkdir", ["-p", fakeBin]);
    psqlPath = join(fakeBin, "psql");

    // Modelo mínimo de psql: préflight/GRANTs passam, o scanner devolve um
    // banco vazio antes das migrations e um ledger checksummed depois delas.
    // Nenhuma conexão ou dado de produção é usado por este teste.
    const psql = `#!/bin/sh
set -eu
file=
command_text=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --file) file=$2; shift 2 ;;
    --command|-c) command_text=$2; shift 2 ;;
    *) shift ;;
  esac
done

if [ -n "$file" ]; then
  case "$file" in
    */00_preflight.sql)
      if [ "$NEXUS_TEST_PREFLIGHT_FAIL" = 1 ]; then
        echo "psql:$file: ERROR: PREFLIGHT_SENTINEL" >&2
        exit 3
      fi
      ;;
    */30_verify.sql)
      if [ "$NEXUS_TEST_VERIFY_FAIL" = 1 ]; then
        echo "psql:$file: ERROR: FALHA: ledger tem 7 migrations, esperado 8" >&2
        exit 3
      fi
      echo "VERIFICACAO CONCLUIDA"
      ;;
    */scan.psql)
      applied=0
      if [ -f "$NEXUS_TEST_APPLIED_FILE" ]; then
        applied=$(wc -l < "$NEXUS_TEST_APPLIED_FILE" | tr -d ' ')
      fi
      if [ "$applied" -eq 8 ]; then
        echo 'META|nexus_exists=t'
        echo 'META|ledger_exists=t'
        echo 'META|has_checksum=t'
        for migration in "$NEXUS_TEST_MIGRATION_DIR"/*.sql; do
          name=$(basename "$migration")
          version=$(printf '%s\\n' "$name" | cut -c1-5 | sed 's/^0*//')
          checksum=$(sha256sum "$migration" | awk '{print $1}')
          printf 'ROW|%s|%s|%s\\n' "$version" "$name" "$checksum"
        done
      else
        echo 'META|nexus_exists=f'
        echo 'META|ledger_exists=f'
      fi
      ;;
    *)
      version=$(grep -o 'NEXUS_MIGRATION_APPLY_[0-9]*' "$file" | head -n 1 | cut -d_ -f4 || true)
      if [ -n "$version" ]; then
        printf '%s\\n' "$version" >> "$NEXUS_TEST_APPLIED_FILE"
        printf 'NEXUS_MIGRATION_APPLY_%s\\n' "$version"
      fi
      ;;
  esac
fi

case "$command_text" in
  *"rolname = 'nexus_migrator'"*) echo t ;;
  *"rolname = 'nexus_app'"*) echo t ;;
esac
exit 0
`;
    writeFileSync(psqlPath, psql);
    chmodSync(psqlPath, 0o755);
  });

  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  function run(opts: {
    verifyFails?: boolean;
    preflightFails?: boolean;
    extraEnv?: Record<string, string | undefined>;
  } = {}): {
    status: number | null;
    stdout: string;
    stderr: string;
    applied: string[];
  } {
    const stateFile = join(workdir, `applied-${Date.now()}-${Math.random()}`);
    writeFileSync(stateFile, "");
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.PGPASSWORD;
    delete env.NEXUS_MIGRATION_DATABASE_URL;
    Object.assign(env, {
      PATH: `${fakeBin}:${process.env.PATH}`,
      PGHOST: "127.0.0.1",
      PGPORT: "5432",
      PGDATABASE: "nexus_test",
      PGSSLMODE: "require",
      PSQL_BIN: psqlPath,
      NEXUS_TEST_APPLIED_FILE: stateFile,
      NEXUS_TEST_MIGRATION_DIR: migrationDir,
      NEXUS_TEST_VERIFY_FAIL: opts.verifyFails ? "1" : "0",
      NEXUS_TEST_PREFLIGHT_FAIL: opts.preflightFails ? "1" : "0",
      ...opts.extraEnv,
    });
    const input = "admin-test-secret-do-not-print\nmigrator-test-secret-do-not-print\n";
    const result = spawnSync("sh", [script], { encoding: "utf8", input, env });
    const applied = readFileSync(stateFile, "utf8").trim().split(/\s+/).filter(Boolean);
    rmSync(stateFile, { force: true });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      applied,
    };
  }

  it("sai com código != 0 se a verificação final falhar", () => {
    const result = run({ verifyFails: true });
    expect(result.status).not.toBe(0);
    expect(result.applied).toHaveLength(8);
  });

  it("não imprime CONCLUÍDO quando a verificação falha", () => {
    const result = run({ verifyFails: true });
    expect(result.stdout + result.stderr).not.toContain("CONCLUÍDO");
    expect(result.stderr).toContain("VERIFICAÇÃO FALHOU");
  });

  it("repassa a mensagem do invariante violado", () => {
    const result = run({ verifyFails: true });
    expect(result.stderr).toContain("FALHA: ledger tem 7 migrations, esperado 8");
  });

  it("não vaza credenciais do prompt nos logs", () => {
    const result = run({ verifyFails: true });
    const output = result.stdout + result.stderr;
    for (const secret of [
      "admin-test-secret-do-not-print",
      "migrator-test-secret-do-not-print",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).not.toMatch(/postgresql:\/\/[^ :]+:[^ @]+@/);
  });

  it("para no préflight antes de preparar papéis ou iniciar migrations", () => {
    const result = run({ preflightFails: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("PREFLIGHT FALHOU");
    expect(result.stderr).toContain("PREFLIGHT_SENTINEL");
    expect(result.stderr).not.toContain("Senha atual/nova de nexus_migrator");
    expect(result.applied).toHaveLength(0);
  });

  it("rejeita PGPASSWORD sem revelar seu valor", () => {
    const result = run({ extraEnv: { PGPASSWORD: "environment-secret-do-not-print" } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("PGPASSWORD não é aceito");
    expect(result.stderr).not.toContain("environment-secret-do-not-print");
    expect(result.applied).toHaveLength(0);
  });
});

describe("install-production.sh — contrato estrutural", () => {
  const content = readFileSync(script, "utf8");

  it("usa passfiles privados e rejeita URLs/PGPASSWORD", () => {
    expect(content).toContain("chmod 600 \"$target_file\"");
    expect(content).toContain("PGPASSFILE=\"$admin_passfile\"");
    expect(content).toContain("PGPASSFILE=\"$migrator_passfile\"");
    expect(content).toContain("NEXUS_MIGRATION_DATABASE_URL");
    expect(content).toContain("PGPASSWORD não é aceito");
    const slash = String.fromCharCode(92);
    expect(content).toContain(`--command '${slash}password nexus_migrator'`);
    expect(content).toContain(`--command '${slash}password nexus_app'`);
    expect(content).not.toContain(`--command '${slash}${slash}password`);
  });

  it("confere explicitamente o status da verificação antes do sucesso", () => {
    expect(content).toContain('if ! run_migrator_file "$verify_sql" "$verify_log"; then');
    const failure = content.indexOf("VERIFICAÇÃO FALHOU");
    const success = content.indexOf('echo "CONCLUÍDO');
    expect(failure).toBeGreaterThan(0);
    expect(success).toBeGreaterThan(failure);
    expect(content).toContain("--set ON_ERROR_STOP=1");
  });

  it("não reescreve senhas existentes sem a opção de rotação", () => {
    expect(content).toContain("--rotate-passwords");
    expect(content).toContain('[ "$migrator_existed" -eq 1 ] || set_migrator_password=1');
    expect(content).toContain('[ "$app_existed" -eq 1 ] || set_app_password=1');
  });
});
