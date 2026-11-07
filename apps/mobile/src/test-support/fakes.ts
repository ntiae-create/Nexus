import { vi } from "vitest";
import type { ApiClient } from "../services/api-client.js";
import { ApiError, createApiClient } from "../services/api-client.js";
import type { SecureStorage } from "../lib/auth/secure-storage.js";

/**
 * Test double for the platform store.
 *
 * `save`/`clear` can be made to fail so the session manager's "never assume the
 * token was written" behaviour is verifiable.
 */
export function createMemoryStorage(options: {
  readonly initial?: string | null;
  readonly failSave?: boolean;
  readonly failClear?: boolean;
  readonly failGet?: boolean;
} = {}): SecureStorage & {
  readonly calls: { save: number; clear: number; get: number };
  readonly peek: () => string | null;
} {
  let value: string | null = options.initial ?? null;
  const calls = { save: 0, clear: 0, get: 0 };

  return {
    backend: "web",
    calls,
    peek: () => value,
    async get() {
      calls.get += 1;
      if (options.failGet) throw new Error("unavailable");
      return value;
    },
    async save(token: string) {
      calls.save += 1;
      if (options.failSave) throw new Error("keystore unavailable");
      value = token;
    },
    async clear() {
      calls.clear += 1;
      if (options.failClear) throw new Error("keystore unavailable");
      value = null;
    },
  };
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const errorBody = (code: string, message: string, retryable = false) => ({
  error: { code, message, retryable },
  timestamp: new Date().toISOString(),
});

export const TEST_OWNER_ID = "00000000-0000-4000-8000-000000000004";
export const TEST_TOKEN = "token-abc.def-ghi";
export const TEST_BASE_URL = "https://api.example.test";

/** Creates a fake `fetch` driven by a route table. Records every call. */
export function createRecordingFetch(
  handler: (request: { url: string; init: RequestInit }) => Response | Promise<Response>,
) {
  const calls: Array<{ url: string; init: RequestInit; body: unknown }> = [];

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, init: init ?? {}, body });
    return handler({ url, init: init ?? {} });
  });

  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

/** Client wired to a recording fetch and a fixed base URL. */
export function createTestClient(
  fetchImpl: typeof fetch,
  baseUrl: string | null = TEST_BASE_URL,
): ApiClient {
  return createApiClient({ getBaseUrl: () => baseUrl, fetchImpl });
}

/** Successful login payload as the backend returns it. */
export function loginPayload(overrides: Record<string, unknown> = {}) {
  return {
    token: TEST_TOKEN,
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    owner: { userId: TEST_OWNER_ID },
    ...overrides,
  };
}

/** Successful `GET /v1/auth/me` payload. */
export function mePayload(overrides: Record<string, unknown> = {}) {
  return {
    owner: { userId: TEST_OWNER_ID },
    session: {
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    ...overrides,
  };
}

export { jsonResponse, errorBody, ApiError };
