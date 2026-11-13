import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import {
  AUTH_POOL_OPTIONS,
  closePostgresAuthPool,
  createPostgresAuthPool,
  postgresAuthStore,
} from "./postgres-store.js";

describe("PostgreSQL auth pool", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });

  it("requires verified TLS for remote auth connections and uses bounded timeouts", () => {
    const pool = createPostgresAuthPool(
      "postgresql://nexus_app:test-secret@db.example.com:5432/nexus",
    );
    pools.push(pool);

    const options = (pool as unknown as {
      options: {
        connectionString: string;
        max: number;
        idleTimeoutMillis: number;
        connectionTimeoutMillis: number;
      };
    }).options;

    expect(new URL(options.connectionString).searchParams.get("sslmode")).toBe("verify-full");
    expect(options.max).toBe(AUTH_POOL_OPTIONS.max);
    expect(options.idleTimeoutMillis).toBe(AUTH_POOL_OPTIONS.idleTimeoutMillis);
    expect(options.connectionTimeoutMillis).toBe(AUTH_POOL_OPTIONS.connectionTimeoutMillis);
  });

  it("refuses a remote auth URL that explicitly disables TLS", () => {
    expect(() =>
      createPostgresAuthPool(
        "postgresql://nexus_app:test-secret@db.example.com:5432/nexus?sslmode=disable",
      ),
    ).toThrow(/TLS is required/);
  });

  it("drains the lazy auth pool when the Fastify app closes", async () => {
    const previousUrl = process.env.NEXUS_DATABASE_URL;
    process.env.NEXUS_DATABASE_URL =
      "postgresql://nexus_app:test-secret@db.example.com:5432/nexus";
    const querySpy = vi.spyOn(pg.Pool.prototype, "query").mockResolvedValue({
      rowCount: 0,
      rows: [],
    } as never);
    const endSpy = vi.spyOn(pg.Pool.prototype, "end").mockResolvedValue(undefined);
    const app = buildApp({ auth: { disabled: true } });

    try {
      expect(await postgresAuthStore.isRevoked("test-jti")).toBe(false);
      await app.close();
      expect(querySpy).toHaveBeenCalledOnce();
      expect(endSpy).toHaveBeenCalledOnce();
    } finally {
      await app.close();
      await closePostgresAuthPool();
      vi.restoreAllMocks();
      if (previousUrl === undefined) delete process.env.NEXUS_DATABASE_URL;
      else process.env.NEXUS_DATABASE_URL = previousUrl;
    }
  });
});
