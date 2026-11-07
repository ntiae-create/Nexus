import { describe, expect, it, vi } from "vitest";
import { createSessionManager } from "./session-manager.js";
import { createAuthService } from "../../services/auth-service.js";
import { ApiError } from "../../services/api-client.js";
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

const OWNER_ID = "00000000-0000-4000-8000-000000000004";

/** Wires a session manager against a scripted backend and an in-memory store. */
function setup(options: {
  readonly handler: (request: { url: string; init: RequestInit }) => Response | Promise<Response>;
  readonly storage?: ReturnType<typeof createMemoryStorage>;
}) {
  const storage = options.storage ?? createMemoryStorage();
  const { fetchImpl, calls } = createRecordingFetch(options.handler);
  const authService = createAuthService(createTestClient(fetchImpl));
  const manager = createSessionManager({ authService, storage });
  return { manager, storage, calls };
}

describe("session manager", () => {
  describe("login", () => {
    it("stores the token and exposes the authenticated session", async () => {
      const { manager, storage, calls } = setup({
        handler: () => jsonResponse(200, loginPayload()),
      });

      const outcome = await manager.login("senha-correta");

      expect(outcome.ok).toBe(true);
      expect(manager.getSnapshot().status).toMatchObject({
        kind: "signed-in",
        session: { token: TEST_TOKEN, ownerId: OWNER_ID },
      });
      expect(storage.peek()).toBe(TEST_TOKEN);
      expect(calls[0]!.url).toMatch(/\/v1\/auth\/login$/);
      expect(calls[0]!.body).toEqual({ password: "senha-correta" });
    });

    it("never persists the password, only the token", async () => {
      const password = "senha-que-nao-pode-ficar";
      const storage = createMemoryStorage();
      const saveSpy = vi.spyOn(storage, "save");
      const { manager } = setup({
        handler: () => jsonResponse(200, loginPayload()),
        storage,
      });

      await manager.login(password);

      const persisted = [...saveSpy.mock.calls.flat(), storage.peek()].map(String).join(" ");
      expect(persisted).toContain(TEST_TOKEN);
      expect(persisted).not.toContain(password);
    });

    it("returns a comprehensible error and stays signed out on a wrong password", async () => {
      const { manager, storage } = setup({
        handler: () => jsonResponse(401, errorBody("UNAUTHORIZED", "Invalid credentials")),
      });

      const outcome = await manager.login("senha-errada");

      expect(outcome.ok).toBe(false);
      expect(outcome.error?.status).toBe(401);
      expect(manager.getSnapshot().status.kind).toBe("signed-out");
      expect(storage.peek()).toBeNull();
    });

    it("surfaces the 429 lockout and remains signed out", async () => {
      const { manager } = setup({
        handler: () => jsonResponse(429, errorBody("LOGIN_LOCKED", "Login temporarily locked", true)),
      });

      const outcome = await manager.login("senha-errada");

      expect(outcome.ok).toBe(false);
      expect(outcome.error?.status).toBe(429);
      expect(outcome.error?.retryable).toBe(true);
      expect(manager.getSnapshot().status.kind).toBe("signed-out");
    });

    it("handles an unavailable backend as a network failure without a session", async () => {
      const { manager, storage } = setup({
        handler: () => {
          throw new TypeError("Failed to fetch");
        },
      });

      const outcome = await manager.login("senha-correta");

      expect(outcome.ok).toBe(false);
      expect(outcome.error?.kind).toBe("network");
      expect(manager.getSnapshot().status.kind).toBe("signed-out");
      expect(storage.peek()).toBeNull();
    });

    it("does not authenticate when the token cannot be stored", async () => {
      const storage = createMemoryStorage({ failSave: true });
      const { manager } = setup({
        handler: () => jsonResponse(200, loginPayload()),
        storage,
      });

      const outcome = await manager.login("senha-correta");

      expect(outcome.ok).toBe(false);
      expect(manager.getSnapshot().status.kind).toBe("signed-out");
      expect(storage.peek()).toBeNull();
    });

    it("is single-flight: concurrent submissions issue one request", async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { manager, calls } = setup({
        handler: async () => {
          await gate;
          return jsonResponse(200, loginPayload());
        },
      });

      const first = manager.login("senha-correta");
      const second = manager.login("senha-correta");
      expect(manager.getSnapshot().busy).toBe(true);

      release();
      const [a, b] = await Promise.all([first, second]);

      expect(a).toEqual(b);
      expect(calls).toHaveLength(1);
      expect(manager.getSnapshot().status.kind).toBe("signed-in");
    });
  });

  describe("restore", () => {
    it("restores a valid stored session after validating it with GET /v1/auth/me", async () => {
      const storage = createMemoryStorage({ initial: TEST_TOKEN });
      const { manager, calls } = setup({
        handler: (request) =>
          request.url.endsWith("/v1/auth/me")
            ? jsonResponse(200, mePayload())
            : jsonResponse(404, errorBody("NOT_FOUND", "nope")),
        storage,
      });

      await manager.restore();

      const status = manager.getSnapshot().status;
      expect(status.kind).toBe("signed-in");
      if (status.kind === "signed-in") {
        expect(status.session.ownerId).toBe(OWNER_ID);
        expect(status.session.token).toBe(TEST_TOKEN);
      }
      // Validation used the stored token as a bearer credential.
      expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${TEST_TOKEN}`,
      );
    });

    it("clears the session when the token is expired or revoked (401)", async () => {
      const storage = createMemoryStorage({ initial: TEST_TOKEN });
      const { manager } = setup({
        handler: () => jsonResponse(401, errorBody("UNAUTHORIZED", "Invalid, expired, or revoked session")),
        storage,
      });

      await manager.restore();

      expect(manager.getSnapshot().status).toMatchObject({
        kind: "signed-out",
        reason: "session-invalid",
      });
      expect(storage.peek()).toBeNull();
    });

    it("clears the session when the server reports an already-expired session", async () => {
      const storage = createMemoryStorage({ initial: TEST_TOKEN });
      const { manager } = setup({
        handler: () =>
          jsonResponse(
            200,
            mePayload({
              session: {
                issuedAt: new Date(Date.now() - 7_200_000).toISOString(),
                expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
              },
            }),
          ),
        storage,
      });

      await manager.restore();

      expect(manager.getSnapshot().status.kind).toBe("signed-out");
      expect(storage.peek()).toBeNull();
    });

    it("does not enter the app when /v1/auth/me fails for a non-auth reason", async () => {
      const storage = createMemoryStorage({ initial: TEST_TOKEN });
      const { manager } = setup({
        handler: () => jsonResponse(503, errorBody("UNAVAILABLE", "Cannot reach database", true)),
        storage,
      });

      await manager.restore();

      expect(manager.getSnapshot().status).toMatchObject({
        kind: "signed-out",
        reason: "validation-failed",
      });
      // The token is kept: the failure was not proof of invalidity, so a later start
      // can revalidate it. It is never used to enter the app unvalidated.
      expect(storage.peek()).toBe(TEST_TOKEN);
    });

    it("stays signed out when no token is stored", async () => {
      const { manager, calls } = setup({ handler: () => jsonResponse(200, mePayload()) });

      await manager.restore();

      expect(manager.getSnapshot().status).toMatchObject({ kind: "signed-out", reason: "no-session" });
      expect(calls).toHaveLength(0);
    });

    it("treats an unreadable secure store as no session", async () => {
      const storage = createMemoryStorage({ initial: TEST_TOKEN, failGet: true });
      const { manager } = setup({ handler: () => jsonResponse(200, mePayload()), storage });

      await manager.restore();

      expect(manager.getSnapshot().status.kind).toBe("signed-out");
    });

    it("does not downgrade an established session when called again", async () => {
      const storage = createMemoryStorage({ initial: TEST_TOKEN });
      const { manager, calls } = setup({
        handler: () => jsonResponse(200, mePayload()),
        storage,
      });

      await manager.restore();
      await manager.restore();

      expect(manager.getSnapshot().status.kind).toBe("signed-in");
      expect(calls).toHaveLength(1);
    });
  });

  describe("logout", () => {
    it("revokes the session on the server before clearing it locally", async () => {
      const storage = createMemoryStorage({ initial: TEST_TOKEN });
      const order: string[] = [];
      const clearSpy = vi.spyOn(storage, "clear").mockImplementation(async () => {
        order.push("clear");
      });
      const { manager, calls } = setup({
        handler: () => {
          order.push("revoke");
          return jsonResponse(200, mePayload());
        },
        storage,
      });

      await manager.restore();
      order.length = 0;
      const outcome = await manager.logout();

      expect(outcome.revokedRemotely).toBe(true);
      expect(outcome.warning).toBeUndefined();
      expect(order).toEqual(["revoke", "clear"]);
      expect(calls.at(-1)!.url).toMatch(/\/v1\/auth\/logout$/);
      expect((calls.at(-1)!.init.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${TEST_TOKEN}`,
      );
      expect(manager.getSnapshot().status).toMatchObject({ kind: "signed-out", reason: "logged-out" });
      expect(clearSpy).toHaveBeenCalled();
    });

    it("clears the local session even when the backend is unavailable", async () => {
      const storage = createMemoryStorage({ initial: TEST_TOKEN });
      const { manager } = setup({
        handler: (request) => {
          if (request.url.endsWith("/v1/auth/logout")) throw new TypeError("Failed to fetch");
          return jsonResponse(200, mePayload());
        },
        storage,
      });

      await manager.restore();
      const outcome = await manager.logout();

      expect(outcome.ok).toBe(true);
      expect(outcome.revokedRemotely).toBe(false);
      expect(outcome.warning).toBeInstanceOf(ApiError);
      expect(manager.getSnapshot().status.kind).toBe("signed-out");
      expect(storage.peek()).toBeNull();
    });

    it("clears local state even when the store refuses to erase", async () => {
      const storage = createMemoryStorage({ initial: TEST_TOKEN, failClear: true });
      const { manager } = setup({ handler: () => jsonResponse(200, mePayload()), storage });

      await manager.restore();
      const outcome = await manager.logout();

      expect(outcome.ok).toBe(true);
      // The user is signed out regardless: a failing store cannot keep a session alive.
      expect(manager.getSnapshot().status.kind).toBe("signed-out");
    });
  });

  describe("races", () => {
    it("a logout during a slow login prevents the session from being established", async () => {
      let releaseLogin: () => void = () => undefined;
      const loginGate = new Promise<void>((resolve) => {
        releaseLogin = resolve;
      });
      const storage = createMemoryStorage();
      const { manager } = setup({
        handler: async (request) => {
          if (request.url.endsWith("/v1/auth/login")) {
            await loginGate;
            return jsonResponse(200, loginPayload());
          }
          return jsonResponse(200, mePayload());
        },
        storage,
      });

      const loginPromise = manager.login("senha-correta");
      const logout = await manager.logout();
      releaseLogin();
      const outcome = await loginPromise;

      expect(logout.ok).toBe(true);
      expect(outcome.ok).toBe(false);
      expect(manager.getSnapshot().status.kind).toBe("signed-out");
      expect(storage.peek()).toBeNull();
    });

    it("handleUnauthorized clears storage and returns to login", async () => {
      const storage = createMemoryStorage({ initial: TEST_TOKEN });
      const { manager } = setup({ handler: () => jsonResponse(200, mePayload()), storage });

      await manager.restore();
      await manager.handleUnauthorized();

      expect(manager.getSnapshot().status).toMatchObject({
        kind: "signed-out",
        reason: "session-invalid",
      });
      expect(storage.peek()).toBeNull();
    });
  });
});
