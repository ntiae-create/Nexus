import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYNTHETIC_TEST_CA_PEM } from "./test-fixtures/private-ca.js";
import { buildApp } from "../app.js";
import {
  AUTH_POOL_OPTIONS,
  closePostgresAuthPool,
  createPostgresAuthPool,
  postgresAuthStore,
} from "./postgres-store.js";

const syntheticCa = SYNTHETIC_TEST_CA_PEM;

describe("PostgreSQL auth pool", () => {
  const pools: Array<{ end(): Promise<void> }> = [];
  let originalCa: string | undefined;
  let originalServername: string | undefined;

  beforeEach(() => {
    originalCa = process.env.NEXUS_DATABASE_SSL_CA;
    originalServername = process.env.NEXUS_DATABASE_SSL_SERVERNAME;
    delete process.env.NEXUS_DATABASE_SSL_CA;
    delete process.env.NEXUS_DATABASE_SSL_SERVERNAME;
  });

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
    if (originalCa === undefined) delete process.env.NEXUS_DATABASE_SSL_CA;
    else process.env.NEXUS_DATABASE_SSL_CA = originalCa;
    if (originalServername === undefined) delete process.env.NEXUS_DATABASE_SSL_SERVERNAME;
    else process.env.NEXUS_DATABASE_SSL_SERVERNAME = originalServername;
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

  it("uses the private CA and internal servername for the authentication pool", () => {
    const previousCa = process.env.NEXUS_DATABASE_SSL_CA;
    const previousServername = process.env.NEXUS_DATABASE_SSL_SERVERNAME;
    process.env.NEXUS_DATABASE_SSL_CA = syntheticCa;
    process.env.NEXUS_DATABASE_SSL_SERVERNAME = "postgres.railway.internal";

    try {
      const pool = createPostgresAuthPool(
        "postgresql://nexus_app@crossover.proxy.rlwy.net:20087/nexus?sslmode=require",
      );
      pools.push(pool);
      const options = (pool as unknown as {
        options: {
          connectionString: string;
          ssl?: { ca?: string; servername?: string; rejectUnauthorized?: boolean };
        };
      }).options;
      const target = new URL(options.connectionString);

      expect(target.hostname).toBe("crossover.proxy.rlwy.net");
      expect(target.port).toBe("20087");
      expect(options.ssl).toEqual({
        ca: syntheticCa,
        servername: "postgres.railway.internal",
        rejectUnauthorized: true,
      });
      const client = new pg.Client({
        connectionString: options.connectionString,
        ssl: options.ssl,
      }) as unknown as { connectionParameters: { ssl: unknown } };
      expect(client.connectionParameters.ssl).toMatchObject({
        ca: syntheticCa,
        servername: "postgres.railway.internal",
        rejectUnauthorized: true,
      });
    } finally {
      if (previousCa === undefined) delete process.env.NEXUS_DATABASE_SSL_CA;
      else process.env.NEXUS_DATABASE_SSL_CA = previousCa;
      if (previousServername === undefined) delete process.env.NEXUS_DATABASE_SSL_SERVERNAME;
      else process.env.NEXUS_DATABASE_SSL_SERVERNAME = previousServername;
    }
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
