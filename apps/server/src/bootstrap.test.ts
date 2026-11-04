import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { bootstrapServer, BootstrapError } from "./bootstrap.js";
import type { PostgresNexusDatabase } from "./database.js";

function makeMockDb(
  overrides: Partial<PostgresNexusDatabase> = {},
): PostgresNexusDatabase {
  return {
    withOwnerTransaction: vi.fn(),
    checkConnectivity: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  } as PostgresNexusDatabase;
}

describe("bootstrapServer", () => {
  it("fails with MISSING_DATABASE_URL when NEXUS_DATABASE_URL is absent", async () => {
    const createDatabase = vi.fn();
    await expect(
      bootstrapServer({}, { createDatabase }),
    ).rejects.toMatchObject({
      name: "BootstrapError",
      code: "MISSING_DATABASE_URL",
    });
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it("fails with MISSING_DATABASE_URL when NEXUS_DATABASE_URL is blank", async () => {
    await expect(
      bootstrapServer({ NEXUS_DATABASE_URL: "   " }, { createDatabase: vi.fn() }),
    ).rejects.toBeInstanceOf(BootstrapError);
  });

  it("closes the pool and fails when initial connectivity check fails", async () => {
    const close = vi.fn(async () => undefined);
    const checkConnectivity = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const db = makeMockDb({ close, checkConnectivity });
    const createDatabase = vi.fn(() => db);

    await expect(
      bootstrapServer(
        { NEXUS_DATABASE_URL: "postgres://localhost/nexus" },
        { createDatabase },
      ),
    ).rejects.toMatchObject({
      code: "DATABASE_UNAVAILABLE",
    });

    expect(createDatabase).toHaveBeenCalledOnce();
    expect(checkConnectivity).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("succeeds when PostgreSQL is available and wires readiness", async () => {
    const db = makeMockDb();
    const createDatabase = vi.fn(() => db);

    const server = await bootstrapServer(
      { NEXUS_DATABASE_URL: "postgres://localhost/nexus", PORT: "4010" },
      { createDatabase },
    );

    try {
      expect(server.port).toBe(4010);
      expect(server.db).toBe(db);
      expect(db.checkConnectivity).toHaveBeenCalled();

      const ready = await server.app.inject({ method: "GET", url: "/v1/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ status: "ready" });

      const health = await server.app.inject({ method: "GET", url: "/v1/health" });
      expect(health.statusCode).toBe(200);
    } finally {
      await server.close();
    }

    expect(db.close).toHaveBeenCalled();
  });

  it("closes the pool on normal shutdown via app.close", async () => {
    const close = vi.fn(async () => undefined);
    const db = makeMockDb({ close });
    const server = await bootstrapServer(
      { NEXUS_DATABASE_URL: "postgres://localhost/nexus" },
      { createDatabase: () => db },
    );

    await server.close();
    expect(close).toHaveBeenCalledTimes(1);

    // Second close must not call db.close again (idempotent onClose path).
    await server.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the pool when listen fails after successful bootstrap", async () => {
    const close = vi.fn(async () => undefined);
    const db = makeMockDb({ close });
    const app = Fastify({ logger: false });
    app.listen = vi.fn(async () => {
      throw new Error("EADDRINUSE");
    }) as typeof app.listen;

    const server = await bootstrapServer(
      { NEXUS_DATABASE_URL: "postgres://localhost/nexus" },
      {
        createDatabase: () => db,
        buildApp: () => app,
      },
    );

    // Simulate index.ts listen failure handling
    await expect(server.app.listen({ host: "0.0.0.0", port: 1 })).rejects.toThrow(
      "EADDRINUSE",
    );
    await server.close();
    expect(close).toHaveBeenCalled();
  });

  it("/v1/ready returns 503 after connectivity starts failing post-boot", async () => {
    let healthy = true;
    const db = makeMockDb({
      checkConnectivity: vi.fn(async () => {
        if (!healthy) throw new Error("database unavailable");
      }),
    });

    const server = await bootstrapServer(
      { NEXUS_DATABASE_URL: "postgres://localhost/nexus" },
      { createDatabase: () => db },
    );

    try {
      const ok = await server.app.inject({ method: "GET", url: "/v1/ready" });
      expect(ok.statusCode).toBe(200);

      healthy = false;
      const bad = await server.app.inject({ method: "GET", url: "/v1/ready" });
      expect(bad.statusCode).toBe(503);
      expect(bad.json()).toEqual({ status: "not_ready" });

      const health = await server.app.inject({ method: "GET", url: "/v1/health" });
      expect(health.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });
});
