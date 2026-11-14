import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

function readinessFailureLog(records: string[]): Record<string, unknown> | undefined {
  return records
    .map((record) => JSON.parse(record) as Record<string, unknown>)
    .find((record) => record.msg === "Database readiness check failed");
}

describe("GET /v1/health", () => {
  const app = buildApp();

  afterEach(async () => {
    await app.close();
  });

  it("returns the process-alive health status without requiring database", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("still returns 200 when a readiness probe would fail", async () => {
    const failing = buildApp({
      checkDatabase: async () => {
        throw new Error("database down");
      },
    });
    try {
      const response = await failing.inject({ method: "GET", url: "/v1/health" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok" });
    } finally {
      await failing.close();
    }
  });
});

describe("GET /v1/ready", () => {
  afterEach(async () => {
    // individual apps closed in tests
  });

  it("returns 503 when no database probe is configured", async () => {
    const app = buildApp();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "not_ready" });
    } finally {
      await app.close();
    }
  });

  it("returns 200 when the database probe succeeds", async () => {
    const app = buildApp({
      checkDatabase: async () => undefined,
    });
    try {
      const response = await app.inject({ method: "GET", url: "/v1/ready" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ready" });
    } finally {
      await app.close();
    }
  });

  it("returns 503 when the database probe fails", async () => {
    const app = buildApp({
      logger: false,
      checkDatabase: async () => {
        throw new Error("connection refused host=secret.internal user=nexus");
      },
    });
    try {
      const response = await app.inject({ method: "GET", url: "/v1/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "not_ready" });
      // Must not leak driver / connection details
      expect(response.body).not.toMatch(/secret\.internal/);
      expect(response.body).not.toMatch(/connection refused/i);
      expect(response.body).not.toMatch(/user=nexus/);
    } finally {
      await app.close();
    }
  });

  it("logs safe TLS failure metadata without leaking exception details", async () => {
    const records: string[] = [];
    const connectionString =
      "postgresql://readiness-test-user:do-not-log-password@db.invalid:5432/nexus";
    const caContent = "NEXUS_DATABASE_SSL_CA=do-not-log-certificate-content";
    const token = "do-not-log-token-value";
    const sensitiveMessage = `${connectionString} ${caContent} ${token}`;
    const error = Object.assign(new Error(sensitiveMessage), {
      name: token,
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
      password: "do-not-log-password",
      certificate: caContent,
    });
    const app = buildApp({
      loggerStream: {
        write: (record) => {
          records.push(record);
        },
      },
      checkDatabase: async () => {
        throw error;
      },
    });

    try {
      const response = await app.inject({ method: "GET", url: "/v1/ready" });
      const loggedOutput = records.join("");
      const failureLog = readinessFailureLog(records);

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "not_ready" });
      expect(response.body).not.toContain(sensitiveMessage);
      expect(failureLog).toMatchObject({
        errorType: "Error",
        errorCode: "ERR_TLS_CERT_ALTNAME_INVALID",
        category: "tls",
      });
      expect(failureLog).not.toHaveProperty("err");
      for (const sensitiveValue of [
        connectionString,
        "readiness-test-user",
        "do-not-log-password",
        caContent,
        token,
        sensitiveMessage,
      ]) {
        expect(loggedOutput).not.toContain(sensitiveValue);
      }
    } finally {
      await app.close();
    }
  });

  it("preserves PostgreSQL SQLSTATE codes and classifies authentication failures", async () => {
    const records: string[] = [];
    const app = buildApp({
      loggerStream: {
        write: (record) => {
          records.push(record);
        },
      },
      checkDatabase: async () => {
        throw Object.assign(new Error("authentication failed"), { code: "28P01" });
      },
    });

    try {
      const response = await app.inject({ method: "GET", url: "/v1/ready" });
      const failureLog = readinessFailureLog(records);

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "not_ready" });
      expect(failureLog).toMatchObject({
        errorType: "Error",
        errorCode: "28P01",
        category: "database_authentication",
      });
      expect(JSON.stringify(failureLog)).not.toContain("authentication failed");
    } finally {
      await app.close();
    }
  });

  it("omits unrecognized error codes instead of logging arbitrary exception data", async () => {
    const records: string[] = [];
    const unsafeCode = "do-not-log-as-error-code";
    const app = buildApp({
      loggerStream: {
        write: (record) => {
          records.push(record);
        },
      },
      checkDatabase: async () => {
        throw Object.assign(new Error("probe failed"), { code: unsafeCode });
      },
    });

    try {
      const response = await app.inject({ method: "GET", url: "/v1/ready" });
      const failureLog = readinessFailureLog(records);

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "not_ready" });
      expect(failureLog).toMatchObject({ errorType: "Error", category: "unknown" });
      expect(failureLog).not.toHaveProperty("errorCode");
      expect(JSON.stringify(failureLog)).not.toContain(unsafeCode);
      expect(JSON.stringify(failureLog)).not.toContain("probe failed");
    } finally {
      await app.close();
    }
  });

  it("returns 503 without exposing an incomplete migration ledger", async () => {
    const app = buildApp({
      logger: false,
      checkDatabase: async () => {
        throw new Error("migration 8 checksum mismatch in nexus_migrations.schema_migrations");
      },
    });
    try {
      const response = await app.inject({ method: "GET", url: "/v1/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "not_ready" });
      expect(response.body).not.toMatch(/migration|checksum|nexus_migrations/i);
    } finally {
      await app.close();
    }
  });

  it("invokes the probe on each readiness request", async () => {
    const checkDatabase = vi.fn(async () => undefined);
    const app = buildApp({ checkDatabase });
    try {
      await app.inject({ method: "GET", url: "/v1/ready" });
      await app.inject({ method: "GET", url: "/v1/ready" });
      expect(checkDatabase).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});
