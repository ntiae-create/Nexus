import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

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
