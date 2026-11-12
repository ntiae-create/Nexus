import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import {
  bootstrapServer,
  BootstrapError,
  createServerlessApp,
  SERVERLESS_POOL_OPTIONS,
} from "./bootstrap.js";
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

  it("closes the pool when build() fails after connectivity succeeds", async () => {
    const close = vi.fn(async () => undefined);
    const db = makeMockDb({ close });
    const buildError = new Error("build failed");

    await expect(
      bootstrapServer(
        { NEXUS_DATABASE_URL: "postgres://localhost/nexus" },
        {
          createDatabase: () => db,
          buildApp: () => {
            throw buildError;
          },
        },
      ),
    ).rejects.toBe(buildError);

    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the pool when addHook fails after build", async () => {
    const close = vi.fn(async () => undefined);
    const db = makeMockDb({ close });
    const hookError = new Error("addHook failed");
    const app = Fastify({ logger: false });
    app.addHook = vi.fn(() => {
      throw hookError;
    }) as typeof app.addHook;

    await expect(
      bootstrapServer(
        { NEXUS_DATABASE_URL: "postgres://localhost/nexus" },
        {
          createDatabase: () => db,
          buildApp: () => app,
        },
      ),
    ).rejects.toBe(hookError);

    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves the original error when pool close also fails after build failure", async () => {
    const closeError = new Error("close failed");
    const buildError = new Error("build failed");
    const close = vi.fn(async () => {
      throw closeError;
    });
    const db = makeMockDb({ close });
    const logError = vi.fn();

    await expect(
      bootstrapServer(
        { NEXUS_DATABASE_URL: "postgres://localhost/nexus" },
        {
          createDatabase: () => db,
          buildApp: () => {
            throw buildError;
          },
          logError,
        },
      ),
    ).rejects.toBe(buildError);

    expect(close).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalled();
    expect(logError.mock.calls[0][1]).toBe(closeError);
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

  it("closes the pool on normal shutdown via app.close without duplicate close", async () => {
    const close = vi.fn(async () => undefined);
    const db = makeMockDb({ close });
    const server = await bootstrapServer(
      { NEXUS_DATABASE_URL: "postgres://localhost/nexus" },
      { createDatabase: () => db },
    );

    await server.close();
    expect(close).toHaveBeenCalledTimes(1);

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

    await expect(server.app.listen({ host: "0.0.0.0", port: 1 })).rejects.toThrow(
      "EADDRINUSE",
    );
    await server.close();
    expect(close).toHaveBeenCalled();
  });

  it("/v1/ready detects loss and recovery of connectivity", async () => {
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
      expect((await server.app.inject({ method: "GET", url: "/v1/ready" })).statusCode).toBe(
        200,
      );

      healthy = false;
      expect((await server.app.inject({ method: "GET", url: "/v1/ready" })).statusCode).toBe(
        503,
      );

      healthy = true;
      expect((await server.app.inject({ method: "GET", url: "/v1/ready" })).statusCode).toBe(
        200,
      );

      const health = await server.app.inject({ method: "GET", url: "/v1/health" });
      expect(health.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });
});

describe("createServerlessApp", () => {
  it("does not create the pool while building the app or serving /v1/health", async () => {
    const createDatabase = vi.fn();
    const app = createServerlessApp(
      { NEXUS_DATABASE_URL: "postgresql://user:pass@127.0.0.1:1/db" },
      { createDatabase: createDatabase as never },
    );
    try {
      // Neither construction nor the health probe may touch PostgreSQL: the
      // serverless instance must stay usable while the database is down.
      expect(createDatabase).not.toHaveBeenCalled();
      const health = await app.inject({ method: "GET", url: "/v1/health" });
      expect(health.statusCode).toBe(200);
      expect(createDatabase).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("reuses one pool across invocations instead of opening one per request", async () => {
    const checkConnectivity = vi.fn(async () => undefined);
    const createDatabase = vi.fn(() => makeMockDb({ checkConnectivity }));
    const app = createServerlessApp(
      { NEXUS_DATABASE_URL: "postgresql://user:pass@127.0.0.1:1/db" },
      { createDatabase: createDatabase as never },
    );
    try {
      for (let i = 0; i < 3; i += 1) {
        const ready = await app.inject({ method: "GET", url: "/v1/ready" });
        expect(ready.statusCode).toBe(200);
      }
      // Three readiness probes, one pool. Opening a pool per request is what
      // exhausts a managed PostgreSQL's connection limit under serverless.
      expect(createDatabase).toHaveBeenCalledTimes(1);
      expect(checkConnectivity).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });

  it("sizes the serverless pool well below the long-lived server pool", async () => {
    // A long-lived server keeps one pool of 10 for the whole process. On a
    // serverless platform the total is instances x max, so the per-instance
    // ceiling has to be small.
    expect(SERVERLESS_POOL_OPTIONS.max).toBeLessThan(10);
    expect(SERVERLESS_POOL_OPTIONS.idleTimeoutMillis).toBeLessThan(30_000);
    expect(SERVERLESS_POOL_OPTIONS.connectionTimeoutMillis).toBeGreaterThan(0);
  });
});
