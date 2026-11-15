import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const ANDROID_CAPACITOR_ORIGIN = "https://localhost";

function createApp() {
  return buildApp({
    logger: false,
    checkDatabase: async () => undefined,
  });
}

describe("mobile API CORS", () => {
  it("answers the Android WebView preflight with only the methods and headers used by the client", async () => {
    const app = createApp();

    try {
      const response = await app.inject({
        method: "OPTIONS",
        url: "/v1/auth/login",
        headers: {
          origin: ANDROID_CAPACITOR_ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,content-type",
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe(
        ANDROID_CAPACITOR_ORIGIN,
      );
      expect(response.headers["access-control-allow-methods"]).toBe("GET, POST");
      expect(response.headers["access-control-allow-headers"]).toBe(
        "Authorization, Content-Type",
      );
      expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
      expect(response.headers.vary).toContain("Origin");
    } finally {
      await app.close();
    }
  });

  it("includes the allowlisted origin on an actual API response", async () => {
    const app = createApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/ready",
        headers: { origin: ANDROID_CAPACITOR_ORIGIN },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ready" });
      expect(response.headers["access-control-allow-origin"]).toBe(
        ANDROID_CAPACITOR_ORIGIN,
      );
    } finally {
      await app.close();
    }
  });

  it("does not allow or reflect an origin that merely resembles the Android origin", async () => {
    const app = createApp();

    try {
      const response = await app.inject({
        method: "OPTIONS",
        url: "/v1/auth/login",
        headers: {
          origin: "https://localhost.attacker.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(response.headers["access-control-allow-methods"]).toBeUndefined();
      expect(response.headers["access-control-allow-headers"]).toBeUndefined();
      expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("does not advertise unsupported methods or request headers", async () => {
    const app = createApp();

    try {
      const response = await app.inject({
        method: "OPTIONS",
        url: "/v1/auth/login",
        headers: {
          origin: ANDROID_CAPACITOR_ORIGIN,
          "access-control-request-method": "PUT",
          "access-control-request-headers": "x-unapproved-header",
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-methods"]).toBe("GET, POST");
      expect(response.headers["access-control-allow-methods"]).not.toContain("PUT");
      expect(response.headers["access-control-allow-headers"]).toBe(
        "Authorization, Content-Type",
      );
      expect(response.headers["access-control-allow-headers"]).not.toContain(
        "x-unapproved-header",
      );
    } finally {
      await app.close();
    }
  });
});
