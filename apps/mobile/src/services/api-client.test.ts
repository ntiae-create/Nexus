import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "./api-client.js";
import {
  createRecordingFetch,
  errorBody,
  jsonResponse,
  TEST_BASE_URL,
  TEST_TOKEN,
} from "../test-support/fakes.js";

describe("api client", () => {
  it("sends the bearer token only on protected requests", async () => {
    const { fetchImpl, calls } = createRecordingFetch(() => jsonResponse(200, { ok: true }));
    const client = createApiClient({ getBaseUrl: () => TEST_BASE_URL, fetchImpl });

    await client.post("/v1/auth/login", { password: "segredo" });
    await client.get("/v1/auth/me", { token: TEST_TOKEN });

    expect(calls).toHaveLength(2);
    const [login, me] = calls;
    // The login request must not carry an Authorization header at all.
    expect((login!.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect((me!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(login!.url).toBe(`${TEST_BASE_URL}/v1/auth/login`);
    expect(login!.body).toEqual({ password: "segredo" });
  });

  it("never logs the password or the token", async () => {
    const logSpies = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "debug"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const { fetchImpl } = createRecordingFetch(() => jsonResponse(200, { ok: true }));
    const client = createApiClient({ getBaseUrl: () => TEST_BASE_URL, fetchImpl });

    const password = "senha-super-secreta";
    await client.post("/v1/auth/login", { password });
    await client.get("/v1/auth/me", { token: TEST_TOKEN });

    const recorded = logSpies.flatMap((spy) => spy.mock.calls.flat().map(String)).join(" ");
    expect(recorded).not.toContain(password);
    expect(recorded).not.toContain(TEST_TOKEN);
  });

  it("maps a rejected credential to a 401 ApiError without leaking the body", async () => {
    const { fetchImpl } = createRecordingFetch(() =>
      jsonResponse(401, errorBody("UNAUTHORIZED", "Invalid credentials")),
    );
    const client = createApiClient({ getBaseUrl: () => TEST_BASE_URL, fetchImpl });

    const error = await client.post("/v1/auth/login", { password: "x" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.kind).toBe("http");
    expect(apiError.status).toBe(401);
    expect(apiError.code).toBe("UNAUTHORIZED");
    expect(apiError.meansSessionInvalid).toBe(true);
  });

  it("reports 429 as retryable so the UI can explain the lockout", async () => {
    const { fetchImpl } = createRecordingFetch(() =>
      jsonResponse(429, errorBody("LOGIN_LOCKED", "Login temporarily locked", true)),
    );
    const client = createApiClient({ getBaseUrl: () => TEST_BASE_URL, fetchImpl });

    const error = (await client
      .post("/v1/auth/login", { password: "x" })
      .catch((e: unknown) => e)) as ApiError;

    expect(error.status).toBe(429);
    expect(error.code).toBe("LOGIN_LOCKED");
    expect(error.retryable).toBe(true);
    // A 429 means "locked", never "session invalid".
    expect(error.meansSessionInvalid).toBe(false);
  });

  it("reports 503 as an unavailable backend", async () => {
    const { fetchImpl } = createRecordingFetch(() =>
      jsonResponse(503, errorBody("AUTH_NOT_CONFIGURED", "Authentication is not configured")),
    );
    const client = createApiClient({ getBaseUrl: () => TEST_BASE_URL, fetchImpl });

    const error = (await client
      .post("/v1/auth/login", { password: "x" })
      .catch((e: unknown) => e)) as ApiError;

    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/Authentication is not configured/);
  });

  it("turns a transport failure into a network ApiError", async () => {
    const failing = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const client = createApiClient({ getBaseUrl: () => TEST_BASE_URL, fetchImpl: failing });

    const error = (await client.get("/v1/auth/me", { token: TEST_TOKEN }).catch((e: unknown) => e)) as ApiError;

    expect(error.kind).toBe("network");
    expect(error.isTransportFailure).toBe(true);
    expect(error.message).toMatch(/Não foi possível conectar/);
    // The original platform error (which can embed the URL) is not surfaced.
    expect(error.message).not.toContain("Failed to fetch");
  });

  it("refuses to issue a request when no base URL is configured", async () => {
    const { fetchImpl, calls } = createRecordingFetch(() => jsonResponse(200, {}));
    const client = createApiClient({ getBaseUrl: () => null, fetchImpl });

    const error = (await client.get("/v1/auth/me").catch((e: unknown) => e)) as ApiError;

    expect(error.kind).toBe("not_configured");
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-JSON success body instead of trusting it", async () => {
    // A captive portal or a misconfigured proxy answers 200 with HTML.
    const { fetchImpl } = createRecordingFetch(
      () => new Response("<html>portal</html>", { status: 200 }),
    );
    const client = createApiClient({ getBaseUrl: () => TEST_BASE_URL, fetchImpl });

    const error = (await client.get("/v1/auth/me").catch((e: unknown) => e)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.kind).toBe("invalid_response");
    // A malformed body is not proof that the session is invalid.
    expect(error.meansSessionInvalid).toBe(false);
  });

  it("returns the parsed payload for a well-formed success body", async () => {
    const { fetchImpl } = createRecordingFetch(() => jsonResponse(200, { owner: { userId: "x" } }));
    const client = createApiClient({ getBaseUrl: () => TEST_BASE_URL, fetchImpl });

    await expect(client.get("/v1/auth/me", { token: TEST_TOKEN })).resolves.toEqual({
      owner: { userId: "x" },
    });
  });

  it("aborts a request that exceeds the timeout", async () => {
    const hanging = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    ) as unknown as typeof fetch;
    const client = createApiClient({ getBaseUrl: () => TEST_BASE_URL, fetchImpl: hanging });

    const error = (await client
      .get("/v1/auth/me", { timeoutMs: 20 })
      .catch((e: unknown) => e)) as ApiError;

    expect(error.kind).toBe("network");
    expect(error.retryable).toBe(true);
  });
});
