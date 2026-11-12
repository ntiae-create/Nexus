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
 * `checkConnectivity` is the only thing between "the deploy went green" and "the
 * database actually has a schema". These tests pin the distinction with a fake
 * pool, because an integration test cannot catch the regression: it points at a
 * database that was just migrated, so `SELECT 1` and the real check look
 * identical there.
 *
 * Reproduced in production on 2026-11-12:
 *
 *     GET  /v1/ready      -> 200 {"status":"ready"}
 *     POST /v1/auth/login -> 500 42P01 relation "nexus.auth_login_state" does not exist
 *
 * The probe said ready; the schema was not there.
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

  it("resolves when the nexus schema is present", async () => {
    const { pool, releaseCount } = makePool(async () => ({
      rows: [{ nexus_schema: "nexus.auth_login_state" }],
    }));
    vi.mocked(createPool).mockReturnValue(pool);

    await expect(database().checkConnectivity()).resolves.toBeUndefined();
    expect(releaseCount()).toBe(1);
  });

  it("rejects when PostgreSQL answers but the schema was never migrated", async () => {
    const { pool, releaseCount } = makePool(async () => ({
      rows: [{ nexus_schema: null }],
    }));
    vi.mocked(createPool).mockReturnValue(pool);

    await expect(database().checkConnectivity()).rejects.toThrow(/not migrated/);
    // The client must return to the pool on the failing path too; otherwise a
    // serverless instance leaks a connection on every readiness check.
    expect(releaseCount()).toBe(1);
  });

  it("asks about the schema instead of running a bare SELECT 1", async () => {
    const statements: string[] = [];
    const { pool } = makePool(async (sql) => {
      statements.push(sql);
      return { rows: [{ nexus_schema: "nexus.auth_login_state" }] };
    });
    vi.mocked(createPool).mockReturnValue(pool);

    await database().checkConnectivity();

    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/to_regclass\('nexus\.auth_login_state'\)/);
    expect(statements[0]).not.toMatch(/^SELECT 1$/);
  });
});
