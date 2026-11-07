import { describe, expect, it } from "vitest";
import { createAuthService } from "./auth-service.js";
import { ApiError } from "./api-client.js";
import {
  createRecordingFetch,
  createTestClient,
  errorBody,
  jsonResponse,
  loginPayload,
  mePayload,
  TEST_TOKEN,
} from "../test-support/fakes.js";

describe("auth service", () => {
  it("parses a successful login response", async () => {
    const { fetchImpl, calls } = createRecordingFetch(() => jsonResponse(200, loginPayload()));
    const service = createAuthService(createTestClient(fetchImpl));

    const result = await service.login("segredo");

    expect(result.token).toBe(TEST_TOKEN);
    expect(result.ownerId).toBe("00000000-0000-4000-8000-000000000004");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ password: "segredo" });
  });

  it("rejects a login response that violates the contract", async () => {
    const { fetchImpl } = createRecordingFetch(() =>
      jsonResponse(200, { token: 123, owner: {} }),
    );
    const service = createAuthService(createTestClient(fetchImpl));

    const error = (await service.login("segredo").catch((e: unknown) => e)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.kind).toBe("invalid_response");
    expect(error.meansSessionInvalid).toBe(false);
  });

  it("validates the session against GET /v1/auth/me with a bearer token", async () => {
    const { fetchImpl, calls } = createRecordingFetch(() => jsonResponse(200, mePayload()));
    const service = createAuthService(createTestClient(fetchImpl));

    const info = await service.currentSession(TEST_TOKEN);

    expect(info.ownerId).toBe("00000000-0000-4000-8000-000000000004");
    expect(calls[0]!.url).toMatch(/\/v1\/auth\/me$/);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TEST_TOKEN}`,
    );
  });

  it("propagates a 401 from the session check as a session-invalid error", async () => {
    const { fetchImpl } = createRecordingFetch(() =>
      jsonResponse(401, errorBody("UNAUTHORIZED", "Invalid, expired, or revoked session")),
    );
    const service = createAuthService(createTestClient(fetchImpl));

    const error = (await service.currentSession("stale").catch((e: unknown) => e)) as ApiError;

    expect(error.status).toBe(401);
    expect(error.meansSessionInvalid).toBe(true);
  });

  it("posts the logout with the bearer token and no body", async () => {
    const { fetchImpl, calls } = createRecordingFetch(() => jsonResponse(200, { ok: true }));
    const service = createAuthService(createTestClient(fetchImpl));

    await service.logout(TEST_TOKEN);

    expect(calls[0]!.url).toMatch(/\/v1\/auth\/logout$/);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TEST_TOKEN}`,
    );
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it("rejects a malformed session-check body", async () => {
    const { fetchImpl } = createRecordingFetch(() => jsonResponse(200, { owner: null }));
    const service = createAuthService(createTestClient(fetchImpl));

    const error = (await service.currentSession(TEST_TOKEN).catch((e: unknown) => e)) as ApiError;

    expect(error.kind).toBe("invalid_response");
  });
});
