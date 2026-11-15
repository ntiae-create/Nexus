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

  it("logs only sanitized connection metadata on readiness failure", async () => {
    const records: string[] = [];
    const connectionString =
      "postgresql://nexus_app:url-password-secret@db.prod.example:6432/nexus_core?sslmode=verify-full&sslpassword=query-password-secret&token=query-token-secret";
    const caContent =
      "-----BEGIN CERTIFICATE-----\\nprivate-ca-content-secret\\n-----END CERTIFICATE-----";
    const sensitiveErrorMessage = `${connectionString} ${caContent} query-token-secret`;
    const readEnvironment = vi.fn(() => ({
      NEXUS_DATABASE_URL: connectionString,
      NEXUS_DATABASE_SSL_CA: caContent,
      NEXUS_DATABASE_SSL_SERVERNAME: "postgres.prod.example",
    }));
    const app = buildApp({
      loggerStream: {
        write: (record) => {
          records.push(record);
        },
      },
      readinessConnectionEnvironment: readEnvironment,
      checkDatabase: async () => {
        throw new Error(sensitiveErrorMessage);
      },
    });

    try {
      const response = await app.inject({ method: "GET", url: "/v1/ready" });
      const loggedOutput = records.join("");
      const failureLog = readinessFailureLog(records);

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "not_ready" });
      expect(response.body).not.toContain("db.prod.example");
      expect(response.body).not.toContain("postgres.prod.example");
      expect(failureLog).toMatchObject({
        errorType: "Error",
        category: "unknown",
        databaseUrlStatus: "parsed",
        databaseHost: "db.prod.example",
        databasePort: 6432,
        databaseName: "nexus_core",
        databaseUser: "nexus_app",
        databaseSni: "postgres.prod.example",
        databaseSslCaPresent: true,
        databaseSslServernamePresent: true,
      });
      expect(failureLog).not.toHaveProperty("err");
      expect(readEnvironment).toHaveBeenCalledOnce();
      for (const forbidden of [
        connectionString,
        "url-password-secret",
        "sslpassword",
        "query-password-secret",
        "query-token-secret",
        caContent,
        "private-ca-content-secret",
        sensitiveErrorMessage,
      ]) {
        expect(loggedOutput).not.toContain(forbidden);
      }
    } finally {
      await app.close();
    }
  });

  it.each([
    { state: "missing" as const, connectionString: undefined },
    {
      state: "invalid" as const,
      connectionString: "not-a-postgres-url?password=url-password-secret&token=url-token-secret",
    },
  ])("logs only the sanitized $state URL state", async ({ state, connectionString }) => {
    const records: string[] = [];
    const caContent = "private-ca-content-secret";
    const sniContent = "private-sni-content-secret.internal";
    const app = buildApp({
      loggerStream: {
        write: (record) => {
          records.push(record);
        },
      },
      readinessConnectionEnvironment: () => ({
        NEXUS_DATABASE_URL: connectionString,
        NEXUS_DATABASE_SSL_CA: caContent,
        NEXUS_DATABASE_SSL_SERVERNAME: sniContent,
      }),
      checkDatabase: async () => {
        throw new Error("readiness failed");
      },
    });

    try {
      const response = await app.inject({ method: "GET", url: "/v1/ready" });
      const failureLog = readinessFailureLog(records);
      const loggedOutput = records.join("");

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "not_ready" });
      expect(failureLog).toMatchObject({ databaseUrlStatus: state });
      expect(failureLog).not.toHaveProperty("databaseHost");
      expect(failureLog).not.toHaveProperty("databasePort");
      expect(failureLog).not.toHaveProperty("databaseName");
      expect(failureLog).not.toHaveProperty("databaseUser");
      expect(failureLog).not.toHaveProperty("databaseSni");
      expect(failureLog).not.toHaveProperty("databaseSslCaPresent");
      expect(failureLog).not.toHaveProperty("databaseSslServernamePresent");
      expect(response.body).not.toContain("databaseUrlStatus");
      for (const forbidden of [
        connectionString,
        "url-password-secret",
        "url-token-secret",
        caContent,
        sniContent,
      ]) {
        if (forbidden) expect(loggedOutput).not.toContain(forbidden);
      }
    } finally {
      await app.close();
    }
  });

  it("does not read readiness metadata when the probe succeeds", async () => {
    const records: string[] = [];
    const readEnvironment = vi.fn(() => ({
      NEXUS_DATABASE_URL: "postgresql://user:password@db.prod.example/nexus_core",
    }));
    const app = buildApp({
      loggerStream: {
        write: (record) => {
          records.push(record);
        },
      },
      readinessConnectionEnvironment: readEnvironment,
      checkDatabase: async () => undefined,
    });

    try {
      const response = await app.inject({ method: "GET", url: "/v1/ready" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ready" });
      expect(readEnvironment).not.toHaveBeenCalled();
      expect(readinessFailureLog(records)).toBeUndefined();
      expect(records.join("")).not.toContain("db.prod.example");
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
