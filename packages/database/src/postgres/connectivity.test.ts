import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createPostgresDatabase } from "./index.js";
import { createPool } from "./pool.js";

vi.mock("./pool.js", () => ({
  createPool: vi.fn(),
  closePool: vi.fn(async (pool: { end: () => Promise<void> }) => {
    await pool.end();
  }),
}));

/**
 * `checkConnectivity` is the boundary between "the deploy went green" and a
 * database with the complete, checksummed schema. The fake-pool tests pin the
 * SQL boundary and fail-closed behavior; PostgreSQL integration tests cover
 * the function's ledger and privilege semantics.
 *
 * The incident note and original probe transcript are preserved in
 * docs/deploy/PROBE_PRODUCAO_2026-11.md and its Git history.
 */

function makePool(query: (sql: string) => Promise<{ rows: unknown[] }>): {
  pool: Pool;
  releaseCount: () => number;
} {
  let releases = 0;
  const client = {
    query,
    release: () => {
      releases += 1;
    },
  };
  return {
    pool: {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
      on: vi.fn(),
    } as unknown as Pool,
    releaseCount: () => releases,
  };
}

function database(): ReturnType<typeof createPostgresDatabase> {
  return createPostgresDatabase({
    connectionString: "postgresql://test:test@localhost:5432/test",
  });
}

describe("checkConnectivity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves only when the authorized ledger function approves all migrations", async () => {
    const { pool, releaseCount } = makePool(async () => ({
      rows: [{ migrations_ready: true }],
    }));
    vi.mocked(createPool).mockReturnValue(pool);

    await expect(database().checkConnectivity()).resolves.toBeUndefined();
    expect(releaseCount()).toBe(1);
  });

  it("rejects when a required migration is absent or has a divergent checksum", async () => {
    const { pool, releaseCount } = makePool(async () => ({
      rows: [{ migrations_ready: false }],
    }));
    vi.mocked(createPool).mockReturnValue(pool);

    await expect(database().checkConnectivity()).rejects.toThrow(/checksummed migrations are not ready/);
    // The client must return to the pool on the failing path too; otherwise a
    // serverless instance leaks a connection on every readiness check.
    expect(releaseCount()).toBe(1);
  });

  it("rejects when the readiness function or ledger is unavailable", async () => {
    const { pool, releaseCount } = makePool(async () => {
      throw new Error("function nexus.migration_ledger_ready() does not exist");
    });
    vi.mocked(createPool).mockReturnValue(pool);

    await expect(database().checkConnectivity()).rejects.toThrow(/does not exist/);
    expect(releaseCount()).toBe(1);
  });

  it("calls only the authorized function and never queries the ledger directly", async () => {
    const statements: string[] = [];
    const { pool } = makePool(async (sql) => {
      statements.push(sql);
      return { rows: [{ migrations_ready: true }] };
    });
    vi.mocked(createPool).mockReturnValue(pool);

    await database().checkConnectivity();

    expect(statements).toEqual(["SELECT nexus.migration_ledger_ready() AS migrations_ready"]);
    expect(statements[0]).not.toMatch(/nexus_migrations|SELECT 1|auth_login_state/);
  });
});
