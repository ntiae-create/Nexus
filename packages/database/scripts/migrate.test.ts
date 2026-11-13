import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "migrate.sh");

describe("migrate.sh connection guardrails", () => {
  let workdir: string;
  let fakePsql: string;

  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), "nexus-migrate-guard-test-"));
    fakePsql = join(workdir, "psql");
    writeFileSync(
      fakePsql,
      `#!/bin/sh
set -eu
printf 'called\\n' >> "$NEXUS_TEST_PSQL_CALLS"
printf 'META|nexus_exists=f\\nMETA|ledger_exists=f\\n'
`,
    );
    chmodSync(fakePsql, 0o755);
  });

  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  function run(options: {
    host?: string;
    sslmode?: string;
    passfileMode?: number;
  } = {}): { status: number | null; stdout: string; stderr: string; psqlCalled: boolean } {
    const passfile = join(workdir, `pass-${Date.now()}-${Math.random()}`);
    const callsFile = join(workdir, `calls-${Date.now()}-${Math.random()}`);
    writeFileSync(passfile, "local-test-only:never-a-real-password\n", { mode: 0o600 });
    chmodSync(passfile, options.passfileMode ?? 0o600);

    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.PGPASSWORD;
    delete env.NEXUS_MIGRATION_DATABASE_URL;
    Object.assign(env, {
      PGHOST: options.host ?? "127.0.0.1",
      PGPORT: "5432",
      PGDATABASE: "nexus_test",
      PGUSER: "postgres",
      PGSSLMODE: options.sslmode ?? "disable",
      PGPASSFILE: passfile,
      PSQL_BIN: fakePsql,
      NEXUS_TEST_PSQL_CALLS: callsFile,
    });

    const result = spawnSync("sh", [script, "--check-only"], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const psqlCalled = existsSync(callsFile);
    rmSync(passfile, { force: true });
    rmSync(callsFile, { force: true });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      psqlCalled,
    };
  }

  it("rejects group/world-readable password files before invoking psql", () => {
    const result = run({ passfileMode: 0o644 });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("PGPASSFILE must have private permissions");
    expect(result.psqlCalled).toBe(false);
  });

  it("accepts a private read-only password file", () => {
    const result = run({ passfileMode: 0o400 });

    expect(result.status).toBe(0);
    expect(result.psqlCalled).toBe(true);
  });

  it.each(["127.0.0.1.evil.example", "127.000.0.1", "127.256.1.1"])(
    "does not treat a non-canonical 127.* value (%s) as loopback for cleartext",
    (host) => {
      const result = run({ host, sslmode: "disable" });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("TLS is required for non-local migration targets");
      expect(result.psqlCalled).toBe(false);
    },
  );

  it.each(["127.0.0.1", "localhost", "::1", "/tmp/nexus-postgres.sock"])(
    "allows PGSSLMODE=disable for a local test host (%s)",
    (host) => {
      const result = run({ host, sslmode: "disable" });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Preflight OK");
      expect(result.psqlCalled).toBe(true);
    },
  );
});
