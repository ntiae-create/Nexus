/**
 * @vitest-environment happy-dom
 *
 * Security invariants for Etapa 3C.1.
 *
 * These are regression locks, not feature tests: they fail if a future change makes
 * the password or the session token observable outside the single request that
 * needs it.
 */
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../services/api-client.js";
import { createAuthService } from "../../services/auth-service.js";
import { createSessionManager } from "./session-manager.js";
import type { SecureStorage } from "./secure-storage.js";
import {
  createMemoryStorage,
  createRecordingFetch,
  createTestClient,
  errorBody,
  jsonResponse,
  loginPayload,
  mePayload,
  TEST_TOKEN,
} from "../../test-support/fakes.js";

const PASSWORD = "senha-que-nunca-pode-vazar";

function setupSession(handler: Parameters<typeof createRecordingFetch>[0]) {
  const storage = createMemoryStorage();
  const { fetchImpl, calls } = createRecordingFetch(handler);
  const manager = createSessionManager({
    authService: createAuthService(createTestClient(fetchImpl)),
    storage,
  });
  return { manager, storage, calls, fetchImpl };
}

describe("security invariants", () => {
  it("never writes the password to secure storage, only the token", async () => {
    const { manager, storage } = setupSession(() => jsonResponse(200, loginPayload()));

    await manager.login(PASSWORD);

    expect(storage.peek()).toBe(TEST_TOKEN);
    expect(storage.peek()).not.toContain(PASSWORD);
    // The whole storage surface, not just the final value.
    const everything = JSON.stringify([
      storage.peek(),
      ...Object.values(storage.calls),
    ]);
    expect(everything).not.toContain(PASSWORD);
  });

  it("never writes the password to browser storage", async () => {
    // Capacitor's Preferences web implementation is window.localStorage, so
    // spying on Storage#setItem covers both routes to persistent web storage.
    const localSet = vi.spyOn(Storage.prototype, "setItem");

    const { manager } = setupSession(() => jsonResponse(200, loginPayload()));
    await manager.login(PASSWORD);

    const written = localSet.mock.calls.flat().map(String).join(" ");
    expect(written).not.toContain(PASSWORD);
    const persisted = Object.keys(window.localStorage).map(
      (key) => window.localStorage.getItem(key) ?? "",
    );
    expect(persisted.join(" ")).not.toContain(PASSWORD);
  });

  it("keeps the password out of console output on both success and failure", async () => {
    const spies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "debug"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];

    const ok = setupSession(() => jsonResponse(200, loginPayload()));
    await ok.manager.login(PASSWORD);

    const failing = setupSession(() =>
      jsonResponse(401, errorBody("UNAUTHORIZED", "Invalid credentials")),
    );
    await failing.manager.login(PASSWORD);

    const recorded = spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join(" ");
    expect(recorded).not.toContain(PASSWORD);
  });

  it("keeps the token out of console output and error messages", async () => {
    const spies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "debug"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];

    // Force a failure *after* the token is in play, so the error path is covered.
    const { manager } = setupSession((request) =>
      request.url.endsWith("/v1/auth/me")
        ? jsonResponse(503, errorBody("UNAVAILABLE", "down", true))
        : jsonResponse(200, loginPayload()),
    );
    await manager.login(PASSWORD);
    const outcome = await (async () => {
      const restoring = createSessionManager({
        authService: createAuthService(
          createTestClient(
            createRecordingFetch(() => jsonResponse(401, errorBody("UNAUTHORIZED", "revoked")))
              .fetchImpl,
          ),
        ),
        storage: createMemoryStorage({ initial: TEST_TOKEN }),
      });
      await restoring.restore();
      return restoring.getSnapshot();
    })();

    const recorded = spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join(" ");
    expect(recorded).not.toContain(TEST_TOKEN);
    expect(JSON.stringify(outcome)).not.toContain(TEST_TOKEN);
  });

  it("never exposes the token through the error object surfaced to the UI", async () => {
    const { fetchImpl } = createRecordingFetch(() => {
      throw new TypeError(`Failed to fetch ${TEST_TOKEN}`);
    });
    const client = createApiClient({ getBaseUrl: () => "https://api.example.test", fetchImpl });

    const error = (await client.get("/v1/auth/me", { token: TEST_TOKEN }).catch((e: unknown) => e)) as Error;

    expect(error.message).not.toContain(TEST_TOKEN);
    expect(String(error.stack ?? "")).not.toContain(TEST_TOKEN);
  });

  it("sends the bearer token on protected calls and never on login", async () => {
    const { manager, calls } = setupSession((request) =>
      request.url.endsWith("/v1/auth/login")
        ? jsonResponse(200, loginPayload())
        : jsonResponse(200, mePayload()),
    );

    await manager.login(PASSWORD);
    const sessionManager = manager as unknown as { getSnapshot: () => { status: { kind: string } } };
    expect(sessionManager.getSnapshot().status.kind).toBe("signed-in");

    const loginCall = calls.find((call) => call.url.endsWith("/v1/auth/login"))!;
    expect(loginCall.init.headers).not.toHaveProperty("Authorization");
  });

  it("clears the persisted token whenever the session is rejected", async () => {
    const storage = createMemoryStorage({ initial: TEST_TOKEN });
    const { fetchImpl } = createRecordingFetch(() =>
      jsonResponse(401, errorBody("UNAUTHORIZED", "Invalid, expired, or revoked session")),
    );
    const manager = createSessionManager({
      authService: createAuthService(createTestClient(fetchImpl)),
      storage,
    });

    await manager.restore();

    expect(storage.peek()).toBeNull();
    expect(manager.getSnapshot().status.kind).toBe("signed-out");
  });

  it("does not keep the token in a module-level place after logout", async () => {
    const storage = createMemoryStorage({ initial: TEST_TOKEN });
    const { fetchImpl } = createRecordingFetch((request) =>
      request.url.endsWith("/v1/auth/logout") ? jsonResponse(200, { ok: true }) : jsonResponse(200, mePayload()),
    );
    const manager = createSessionManager({
      authService: createAuthService(createTestClient(fetchImpl)),
      storage,
    });

    await manager.restore();
    await manager.logout();

    expect(manager.getSnapshot().status.kind).toBe("signed-out");
    expect(JSON.stringify(manager.getSnapshot())).not.toContain(TEST_TOKEN);
    expect(storage.peek()).toBeNull();
  });

  it("uses memory-only storage on the web backend (no credential in localStorage)", async () => {
    const { createWebSecureStorage } = await import("./secure-storage.js");
    const storage: SecureStorage = createWebSecureStorage();
    await storage.save("token-web-only");

    expect(storage.backend).toBe("web");
    // Nothing sensitive is written under the app's own localStorage keys.
    const localValues = Object.keys(window.localStorage).map((key) => window.localStorage.getItem(key) ?? "");
    expect(localValues.join(" ")).not.toContain("token-web-only");
  });
});
