/**
 * @vitest-environment happy-dom
 *
 * The repository-wide config runs in `node` so backend/pkg tests stay fast; React
 * screens need a DOM, so each UI test file opts in here.
 */
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * Capacitor is stubbed before importing anything that reaches it. These are the
 * only platform APIs the app touches outside the browser.
 */
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: vi.fn(() => false) },
  registerPlugin: vi.fn(() => ({
    get: vi.fn(async () => ({ value: null })),
    set: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  })),
}));

const preferencesStore = new Map<string, string>();
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: preferencesStore.get(key) ?? null,
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      preferencesStore.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      preferencesStore.delete(key);
    }),
  },
}));

const { default: App } = await import("./App.js");
const { createSessionManager } = await import("./lib/auth/session-manager.js");
const { createAuthService } = await import("./services/auth-service.js");
const { createApiClient } = await import("./services/api-client.js");
const { createCoreService } = await import("./services/core-service.js");
const { createConversationService } = await import("./services/conversation-service.js");
const { createSecureStorage } = await import("./lib/auth/secure-storage.js");
const { createMemoryStorage } = await import("./test-support/fakes.js");
const { TEST_BASE_URL, TEST_TOKEN, TEST_OWNER_ID } = await import("./test-support/fakes.js");

type SecureStorage = Awaited<ReturnType<typeof createSecureStorage>>;

const OWNER_ID = TEST_OWNER_ID;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const loginPayload = {
  token: TEST_TOKEN,
  tokenType: "Bearer",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  owner: { userId: OWNER_ID },
};

const mePayload = {
  owner: { userId: OWNER_ID },
  session: {
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  },
};

type Route = (request: { url: string; init: RequestInit; body: unknown }) => Response | Promise<Response>;

function makeContainer(routes: Record<string, Route>, storage: SecureStorage | null = null) {
  const calls: Array<{ url: string; init: RequestInit; body: unknown }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const entry = { url, init: init ?? {}, body };
    calls.push(entry);
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) return json(404, { error: { code: "NOT_FOUND", message: "no route", retryable: false }, timestamp: new Date().toISOString() });
    return route(entry);
  }) as unknown as typeof fetch;

  // The real platform factory is used by default (so its wiring is covered);
  // session-persistence cases inject a controllable store because the browser
  // backend is deliberately memory-only.
  const activeStorage = storage ?? createSecureStorage();
  const client = createApiClient({ getBaseUrl: () => TEST_BASE_URL, fetchImpl });
  const sessionManager = createSessionManager({
    authService: createAuthService(client),
    storage: activeStorage,
  });

  const coreService = createCoreService(client);

  return {
    calls,
    container: {
      sessionManager,
      storage: activeStorage,
      apiBaseUrl: TEST_BASE_URL,
      configureApiBaseUrl: async () => ({ ok: true }),
      apiClient: client,
      createConversationService: (token: string) =>
        createConversationService({ service: coreService, token }),
    },
  };
}

function renderApp(container: Parameters<typeof App>[0]["container"]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(App, { container }));
  });
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (host: HTMLElement) => host.textContent ?? "";
const passwordInput = (host: HTMLElement) => host.querySelector<HTMLInputElement>("#owner-password");

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timeout waiting for UI state");
    await act(async () => {
      await wait(10);
    });
  }
}

describe("App authentication flow", () => {
  it("shows the login screen when no session is stored", async () => {
    const { container } = makeContainer({});
    const { host, unmount } = renderApp(container);

    await waitFor(() => passwordInput(host) !== null);

    expect(text(host)).toContain("Entrar");
    expect(host.querySelector('input[type="email"]')).toBeNull();
    unmount();
  });

  it("logs in, persists the token and shows the authenticated screen", async () => {
    const storage = createMemoryStorage();
    const { container, calls } = makeContainer(
      {
        "/v1/auth/login": () => json(200, loginPayload),
        "/v1/auth/me": () => json(200, mePayload),
      },
      storage,
    );
    const { host, unmount } = renderApp(container);

    await waitFor(() => passwordInput(host) !== null);
    setInput(passwordInput(host)!, "senha-correta");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
      await wait(20);
    });
    await waitFor(() => text(host).includes("Suas conversas"));

    expect(text(host)).toContain(OWNER_ID);
    // The token is what got persisted — never the password.
    expect(storage.peek()).toBe(TEST_TOKEN);
    expect(storage.peek()).not.toContain("senha-correta");
    expect(calls.some((call) => call.url.endsWith("/v1/auth/login"))).toBe(true);
    unmount();
  });

  it("explains a wrong password without leaving the login screen", async () => {
    const { container } = makeContainer(
      {
        "/v1/auth/login": () =>
          json(401, {
            error: { code: "UNAUTHORIZED", message: "Invalid credentials", retryable: false },
            timestamp: new Date().toISOString(),
          }),
      },
      createMemoryStorage(),
    );
    const { host, unmount } = renderApp(container);

    await waitFor(() => passwordInput(host) !== null);
    setInput(passwordInput(host)!, "errada");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
      await wait(20);
    });
    await waitFor(() => text(host).includes("Invalid credentials"));

    expect(passwordInput(host)).not.toBeNull();
    expect(text(host)).not.toContain("Suas conversas");
    unmount();
  });

  it("explains the 429 lockout", async () => {
    const { container } = makeContainer(
      {
        "/v1/auth/login": () =>
          json(429, {
            error: { code: "LOGIN_LOCKED", message: "Login temporarily locked", retryable: true },
            timestamp: new Date().toISOString(),
          }),
      },
      createMemoryStorage(),
    );
    const { host, unmount } = renderApp(container);

    await waitFor(() => passwordInput(host) !== null);
    setInput(passwordInput(host)!, "errada");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
      await wait(20);
    });
    await waitFor(() => text(host).includes("Login temporarily locked"));
    unmount();
  });

  it("reports an unreachable backend", async () => {
    const { container } = makeContainer(
      {
        "/v1/auth/login": () => {
          throw new TypeError("Failed to fetch");
        },
      },
      createMemoryStorage(),
    );
    const { host, unmount } = renderApp(container);

    await waitFor(() => passwordInput(host) !== null);
    setInput(passwordInput(host)!, "senha");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
      await wait(20);
    });
    await waitFor(() => text(host).includes("Não foi possível conectar"));
    unmount();
  });

  it("restores a valid session on startup after validating it", async () => {
    const { container, calls } = makeContainer(
      { "/v1/auth/me": () => json(200, mePayload) },
      createMemoryStorage({ initial: TEST_TOKEN }),
    );
    const { host, unmount } = renderApp(container);

    await waitFor(() => text(host).includes("Suas conversas"));

    expect(calls[0]!.url).toMatch(/\/v1\/auth\/me$/);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TEST_TOKEN}`,
    );
    unmount();
  });

  it("discards a revoked session and returns to login", async () => {
    const storage = createMemoryStorage({ initial: TEST_TOKEN });
    const { container } = makeContainer(
      {
        "/v1/auth/me": () =>
          json(401, {
            error: { code: "UNAUTHORIZED", message: "revoked", retryable: false },
            timestamp: new Date().toISOString(),
          }),
      },
      storage,
    );
    const { host, unmount } = renderApp(container);

    await waitFor(() => passwordInput(host) !== null);
    await waitFor(() => text(host).includes("expirou ou foi revogada"));

    // The token must have been removed from storage.
    expect(storage.peek()).toBeNull();
    unmount();
  });

  it("logs out through the API and returns to login", async () => {
    const storage = createMemoryStorage({ initial: TEST_TOKEN });
    const { container, calls } = makeContainer(
      {
        "/v1/auth/me": () => json(200, mePayload),
        "/v1/auth/logout": () => json(200, { ok: true }),
      },
      storage,
    );
    const { host, unmount } = renderApp(container);

    await waitFor(() => text(host).includes("Suas conversas"));
    // Scoped to the footer: the screen also has a "new conversation" primary button.
    await act(async () => {
      host.querySelector<HTMLButtonElement>(".home-footer .button-secondary")!.click();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>(".home-footer .button-primary")!.click();
      await wait(20);
    });
    await waitFor(() => passwordInput(host) !== null);

    expect(calls.some((call) => call.url.endsWith("/v1/auth/logout"))).toBe(true);
    expect(storage.peek()).toBeNull();
    unmount();
  });

  it("clears the session locally when logout cannot reach the backend", async () => {
    const storage = createMemoryStorage({ initial: TEST_TOKEN });
    const { container } = makeContainer(
      {
        "/v1/auth/me": () => json(200, mePayload),
        "/v1/auth/logout": () => {
          throw new TypeError("Failed to fetch");
        },
      },
      storage,
    );
    const { host, unmount } = renderApp(container);

    await waitFor(() => text(host).includes("Suas conversas"));
    await act(async () => {
      host.querySelector<HTMLButtonElement>(".home-footer .button-secondary")!.click();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>(".home-footer .button-primary")!.click();
      await wait(20);
    });
    await waitFor(() => passwordInput(host) !== null);

    // Signed out regardless of the network failure, and the UI says so.
    expect(storage.peek()).toBeNull();
    await waitFor(() => text(host).includes("revogação"));
    unmount();
  });
});
