import { describe, expect, it } from "vitest";
import { getAssistantProfileByKey } from "@nexus/assistant-profiles";
import {
  apiErrorSchema,
  effectiveModelSelectionResponseSchema,
  eligibleModelsResponseSchema,
  providersListResponseSchema,
  publicCapabilitiesResponseSchema,
  type ProviderPreferenceSet,
} from "@nexus/shared";
import { buildApp } from "../app.js";
import { OWNER_ID, type SessionConfig } from "../auth/session.js";
import type { AuthStore } from "../auth/store.js";
import { createServerlessApp } from "../bootstrap.js";
import type { PostgresNexusDatabase } from "../database.js";
import {
  createDefaultProviderRuntime,
  deriveModelId,
  OPENROUTER_PROVIDER_ID,
} from "../providers/index.js";
import {
  createDatabasePreferenceReader,
  ResourceNotFoundRouteError,
} from "./providers.js";

const ALICE_ID = getAssistantProfileByKey("alice")!.id;
const TEST_OWNER_PASSWORD = "test-owner-password-only-not-secret";
const FAKE_ROUTE_API_KEY = "test-only-fake-openrouter-route-credential-551";
const TEST_SESSION_CONFIG: SessionConfig = {
  secret: "0123456789abcdef0123456789abcdef0123456789abcdef",
  ownerPassword: TEST_OWNER_PASSWORD,
  ttlSeconds: 3600,
};

function createMockAuthStore(): AuthStore {
  const revoked = new Set<string>();
  return {
    isRevoked: async (jti) => revoked.has(jti),
    revoke: async (jti) => {
      revoked.add(jti);
    },
    recordFailure: async () => true,
    clearFailures: async () => undefined,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sampleUpstreamModels() {
  return {
    data: [
      {
        id: "meta-llama/llama-3.3-70b-instruct:free",
        name: "Llama 3.3 70B Free",
        context_length: 131072,
        pricing: { prompt: "0", completion: "0" },
        top_provider: { context_length: 131072, max_completion_tokens: 8192 },
        supported_parameters: ["temperature", "top_p", "max_tokens", "stop"],
      },
      {
        id: "qwen/qwen3-coder:free",
        name: "Qwen 3 Coder Free",
        context_length: 65536,
        pricing: { prompt: "0", completion: "0" },
        supported_parameters: [
          "temperature",
          "max_tokens",
          "response_format",
          "reasoning",
        ],
      },
      {
        id: "openai/gpt-4.1",
        name: "GPT-4.1 Paid",
        context_length: 128000,
        pricing: { prompt: "0.000002", completion: "0.000008" },
        supported_parameters: ["temperature"],
      },
    ],
  };
}

async function loginAndGetToken(app: ReturnType<typeof buildApp>): Promise<string> {
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { password: TEST_OWNER_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  return (login.json() as { token: string }).token;
}

describe("Provider Fastify API routes (/v1/providers/*)", () => {
  it("requires valid Bearer session authentication across all provider routes", async () => {
    const runtime = createDefaultProviderRuntime({
      env: { OPENROUTER_API_KEY: FAKE_ROUTE_API_KEY },
      fetchFn: (async () => jsonResponse(sampleUpstreamModels())) as typeof fetch,
    });
    const app = buildApp({
      logger: false,
      auth: { config: TEST_SESSION_CONFIG, store: createMockAuthStore() },
      providers: { runtime },
    });

    try {
      const endpoints = [
        "/v1/providers",
        "/v1/providers/models",
        "/v1/providers/capabilities",
        "/v1/providers/selection",
      ];

      for (const url of endpoints) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode).toBe(401);
        expect(apiErrorSchema.safeParse(res.json()).success).toBe(true);
      }
    } finally {
      await app.close();
    }
  });

  it("serves available providers, eligible free models, public capabilities, and effective selection", async () => {
    const qwenModelId = deriveModelId(
      OPENROUTER_PROVIDER_ID,
      "qwen/qwen3-coder:free",
    );
    const persistedPreferences: ProviderPreferenceSet = {
      global: {
        id: OWNER_ID,
        userId: OWNER_ID,
        selection: { mode: "automatic" },
        updatedAt: "2026-11-05T00:00:00.000Z",
      },
      byAssistant: [
        {
          id: ALICE_ID,
          userId: OWNER_ID,
          assistantId: ALICE_ID,
          selection: {
            mode: "manual",
            providerId: OPENROUTER_PROVIDER_ID,
            modelId: qwenModelId,
          },
          updatedAt: "2026-11-05T00:00:00.000Z",
        },
      ],
      byConversation: [],
    };

    const runtime = createDefaultProviderRuntime({
      env: { OPENROUTER_API_KEY: FAKE_ROUTE_API_KEY },
      fetchFn: (async () => jsonResponse(sampleUpstreamModels())) as typeof fetch,
    });

    const app = buildApp({
      logger: false,
      auth: { config: TEST_SESSION_CONFIG, store: createMockAuthStore() },
      providers: {
        runtime,
        readPreferences: async ({ conversationId }) => {
          if (conversationId === "99999999-9999-4999-8999-999999999999") {
            throw new ResourceNotFoundRouteError(
              "CONVERSATION_NOT_FOUND",
              "Conversation not found",
            );
          }
          return persistedPreferences;
        },
      },
    });

    try {
      const token = await loginAndGetToken(app);
      const headers = { authorization: `Bearer ${token}` };

      // 1. GET /v1/providers
      const providersRes = await app.inject({
        method: "GET",
        url: "/v1/providers",
        headers,
      });
      expect(providersRes.statusCode).toBe(200);
      const providersBody = providersListResponseSchema.parse(providersRes.json());
      expect(providersBody.providers).toHaveLength(1);
      expect(providersBody.providers[0]).toMatchObject({
        id: OPENROUTER_PROVIDER_ID,
        key: "openrouter",
        configured: true,
        availability: "available",
        costPolicy: "free_only",
        eligibleModelCount: 2,
      });

      // 2. GET /v1/providers/models
      const modelsRes = await app.inject({
        method: "GET",
        url: "/v1/providers/models",
        headers,
      });
      expect(modelsRes.statusCode).toBe(200);
      const modelsBody = eligibleModelsResponseSchema.parse(modelsRes.json());
      expect(modelsBody.models.map((m) => m.key)).toEqual([
        "meta-llama/llama-3.3-70b-instruct:free",
        "qwen/qwen3-coder:free",
      ]);
      expect(modelsBody.summary.blockedPaidCount).toBe(1);
      expect(JSON.stringify(modelsBody)).not.toContain(FAKE_ROUTE_API_KEY);

      // 3. GET /v1/providers/capabilities
      const capabilitiesRes = await app.inject({
        method: "GET",
        url: "/v1/providers/capabilities",
        headers,
      });
      expect(capabilitiesRes.statusCode).toBe(200);
      const capabilitiesBody = publicCapabilitiesResponseSchema.parse(
        capabilitiesRes.json(),
      );
      expect(capabilitiesBody.policy).toEqual({
        costMode: "free_only",
        paidModelsAllowed: false,
        paidFallbackAllowed: false,
        preCallPriceVerificationRequired: true,
        openRouterFreeSuffix: ":free",
      });
      expect(JSON.stringify(capabilitiesBody)).not.toContain(FAKE_ROUTE_API_KEY);

      // 4. GET /v1/providers/selection (global automatic vs assistant manual by key 'alice')
      const globalSelectionRes = await app.inject({
        method: "GET",
        url: "/v1/providers/selection",
        headers,
      });
      expect(globalSelectionRes.statusCode).toBe(200);
      const globalSelection = effectiveModelSelectionResponseSchema.parse(
        globalSelectionRes.json(),
      );
      expect(globalSelection.resolvedScope).toBe("global");
      expect(globalSelection.selectedModel.key).toBe(
        "meta-llama/llama-3.3-70b-instruct:free",
      );

      const aliceSelectionRes = await app.inject({
        method: "GET",
        url: "/v1/providers/selection?assistantId=alice",
        headers,
      });
      expect(aliceSelectionRes.statusCode).toBe(200);
      const aliceSelection = effectiveModelSelectionResponseSchema.parse(
        aliceSelectionRes.json(),
      );
      expect(aliceSelection.resolvedScope).toBe("assistant");
      expect(aliceSelection.selectedModel.key).toBe("qwen/qwen3-coder:free");

      const unknownAssistantRes = await app.inject({
        method: "GET",
        url: "/v1/providers/selection?assistantId=unknown",
        headers,
      });
      expect(unknownAssistantRes.statusCode).toBe(404);

      const unknownConvRes = await app.inject({
        method: "GET",
        url: "/v1/providers/selection?conversationId=99999999-9999-4999-8999-999999999999",
        headers,
      });
      expect(unknownConvRes.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("reports unconfigured provider on /v1/providers and returns explicit 503 on /models and /selection when key is absent", async () => {
    const runtime = createDefaultProviderRuntime({ env: {} });
    const app = buildApp({
      logger: false,
      auth: { config: TEST_SESSION_CONFIG, store: createMockAuthStore() },
      providers: { runtime },
    });

    try {
      const token = await loginAndGetToken(app);
      const headers = { authorization: `Bearer ${token}` };

      const providersRes = await app.inject({
        method: "GET",
        url: "/v1/providers",
        headers,
      });
      expect(providersRes.statusCode).toBe(200);
      const body = providersListResponseSchema.parse(providersRes.json());
      expect(body.providers[0]).toMatchObject({
        key: "openrouter",
        configured: false,
        availability: "unavailable",
        eligibleModelCount: 0,
      });

      const modelsRes = await app.inject({
        method: "GET",
        url: "/v1/providers/models",
        headers,
      });
      expect(modelsRes.statusCode).toBe(503);
      expect(modelsRes.json()).toMatchObject({
        error: { code: "PROVIDER_NOT_CONFIGURED", retryable: false },
      });

      const selectionRes = await app.inject({
        method: "GET",
        url: "/v1/providers/selection",
        headers,
      });
      expect(selectionRes.statusCode).toBe(503);
      expect(selectionRes.json()).toMatchObject({
        error: { code: "PROVIDER_NOT_CONFIGURED", retryable: false },
      });
    } finally {
      await app.close();
    }
  });

  it("blocks paid manual preferences via HTTP 403 and scrubs leaked secrets on upstream failures", async () => {
    const paidModelId = deriveModelId(OPENROUTER_PROVIDER_ID, "openai/gpt-4.1");

    const runtimePaidCheck = createDefaultProviderRuntime({
      env: { OPENROUTER_API_KEY: FAKE_ROUTE_API_KEY },
      fetchFn: (async () => jsonResponse(sampleUpstreamModels())) as typeof fetch,
    });
    const appPaidCheck = buildApp({
      logger: false,
      auth: { config: TEST_SESSION_CONFIG, store: createMockAuthStore() },
      providers: {
        runtime: runtimePaidCheck,
        readPreferences: async () => ({
          global: {
            id: OWNER_ID,
            userId: OWNER_ID,
            selection: {
              mode: "manual",
              providerId: OPENROUTER_PROVIDER_ID,
              modelId: paidModelId,
            },
            updatedAt: "2026-11-05T00:00:00.000Z",
          },
          byAssistant: [],
          byConversation: [],
        }),
      },
    });

    try {
      const token = await loginAndGetToken(appPaidCheck);
      const res = await appPaidCheck.inject({
        method: "GET",
        url: "/v1/providers/selection",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        error: { code: "PROVIDER_PAID_MODEL_BLOCKED", retryable: false },
      });
    } finally {
      await appPaidCheck.close();
    }

    const runtimeSecretLeak = createDefaultProviderRuntime({
      env: { OPENROUTER_API_KEY: FAKE_ROUTE_API_KEY },
      fetchFn: (async () =>
        jsonResponse(
          { error: { message: `Rejected key ${FAKE_ROUTE_API_KEY}` } },
          401,
        )) as typeof fetch,
    });
    const appSecretLeak = buildApp({
      logger: false,
      auth: { config: TEST_SESSION_CONFIG, store: createMockAuthStore() },
      providers: { runtime: runtimeSecretLeak },
    });

    try {
      const token = await loginAndGetToken(appSecretLeak);
      const res = await appSecretLeak.inject({
        method: "GET",
        url: "/v1/providers/models",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(502);
      const rawPayload = res.body;
      expect(rawPayload).not.toContain(FAKE_ROUTE_API_KEY);
      expect(rawPayload).toContain("[REDACTED]");
    } finally {
      await appSecretLeak.close();
    }
  });

  it("maps timeout (504), rate-limit (429), malformed payload (502), query validation (400), and persisted DB preferences via createDatabasePreferenceReader", async () => {
    // 1. Timeout -> 504
    const timeoutRuntime = createDefaultProviderRuntime({
      env: {
        OPENROUTER_API_KEY: FAKE_ROUTE_API_KEY,
        OPENROUTER_TIMEOUT_MS: "100",
      },
      fetchFn: ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        })) as typeof fetch,
    });
    const appTimeout = buildApp({
      logger: false,
      auth: { config: TEST_SESSION_CONFIG, store: createMockAuthStore() },
      providers: { runtime: timeoutRuntime },
    });
    try {
      const token = await loginAndGetToken(appTimeout);
      const res = await appTimeout.inject({
        method: "GET",
        url: "/v1/providers/models",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(504);
      expect(res.json()).toMatchObject({
        error: { code: "PROVIDER_TIMEOUT", retryable: true },
      });

      const badQueryRes = await appTimeout.inject({
        method: "GET",
        url: "/v1/providers/models?capability=nonexistent_capability",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(badQueryRes.statusCode).toBe(400);
    } finally {
      await appTimeout.close();
    }

    // 2. Rate-limit -> 429 & Malformed -> 502
    let returnMalformed = false;
    const errorRuntime = createDefaultProviderRuntime({
      env: { OPENROUTER_API_KEY: FAKE_ROUTE_API_KEY },
      fetchFn: (async () =>
        returnMalformed
          ? new Response("{not-json", { status: 200 })
          : jsonResponse({ error: { message: "Free quota exceeded" } }, 429)) as typeof fetch,
    });
    const appErrors = buildApp({
      logger: false,
      auth: { config: TEST_SESSION_CONFIG, store: createMockAuthStore() },
      providers: { runtime: errorRuntime },
    });
    try {
      const token = await loginAndGetToken(appErrors);
      const rateRes = await appErrors.inject({
        method: "GET",
        url: "/v1/providers/models",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(rateRes.statusCode).toBe(429);
      expect(rateRes.json()).toMatchObject({
        error: { code: "PROVIDER_RATE_LIMITED", retryable: true },
      });

      returnMalformed = true;
      const malformedRes = await appErrors.inject({
        method: "GET",
        url: "/v1/providers/models",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(malformedRes.statusCode).toBe(502);
      expect(malformedRes.json()).toMatchObject({
        error: { code: "PROVIDER_INVALID_RESPONSE", retryable: false },
      });
    } finally {
      await appErrors.close();
    }

    // 3. Database preference reader + conversation precedence integration
    const convId = "33333333-3333-4333-8333-333333333333";
    const qwenModelId = deriveModelId(
      OPENROUTER_PROVIDER_ID,
      "qwen/qwen3-coder:free",
    );
    const llamaModelId = deriveModelId(
      OPENROUTER_PROVIDER_ID,
      "meta-llama/llama-3.3-70b-instruct:free",
    );

    const mockDb: PostgresNexusDatabase = {
      checkConnectivity: async () => undefined,
      close: async () => undefined,
      withOwnerTransaction: async (_ctx, op) =>
        op({
          conversations: {
            getById: async (id: string) =>
              id === convId
                ? {
                    id: convId,
                    userId: OWNER_ID,
                    title: "Test Conv",
                    primaryAssistantId: ALICE_ID,
                    activeParticipants: [{ assistantId: ALICE_ID, role: "primary" }],
                    createdAt: "2026-11-05T00:00:00.000Z",
                    updatedAt: "2026-11-05T00:00:00.000Z",
                    archivedAt: null,
                  }
                : null,
          },
          providerPreferences: {
            getAll: async () => ({
              global: {
                id: OWNER_ID,
                userId: OWNER_ID,
                selection: {
                  mode: "manual" as const,
                  providerId: OPENROUTER_PROVIDER_ID,
                  modelId: llamaModelId,
                },
                updatedAt: "2026-11-05T00:00:00.000Z",
              },
              byAssistant: [
                {
                  id: ALICE_ID,
                  userId: OWNER_ID,
                  assistantId: ALICE_ID,
                  selection: { mode: "automatic" as const },
                  updatedAt: "2026-11-05T00:00:00.000Z",
                },
              ],
              byConversation: [
                {
                  userId: OWNER_ID,
                  conversationId: convId,
                  selection: {
                    mode: "manual" as const,
                    providerId: OPENROUTER_PROVIDER_ID,
                    modelId: qwenModelId,
                  },
                  updatedAt: "2026-11-05T00:00:00.000Z",
                },
              ],
            }),
          },
        } as unknown as Parameters<typeof op>[0]),
    };

    const serverlessApp = createServerlessApp(
      { NEXUS_DATABASE_URL: "postgres://localhost/nexus" },
      {
        createDatabase: () => mockDb,
        buildApp: (opts) =>
          buildApp({
            ...opts,
            logger: false,
            auth: { config: TEST_SESSION_CONFIG, store: createMockAuthStore() },
            providers: {
              ...opts?.providers,
              runtime: createDefaultProviderRuntime({
                env: { OPENROUTER_API_KEY: FAKE_ROUTE_API_KEY },
                fetchFn: (async () =>
                  jsonResponse(sampleUpstreamModels())) as typeof fetch,
              }),
              readPreferences: createDatabasePreferenceReader(() => mockDb),
            },
          }),
      },
    );

    try {
      const token = await loginAndGetToken(serverlessApp);
      const res = await serverlessApp.inject({
        method: "GET",
        url: `/v1/providers/selection?assistantId=alice&conversationId=${convId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const parsed = effectiveModelSelectionResponseSchema.parse(res.json());
      expect(parsed.resolvedScope).toBe("conversation");
      expect(parsed.selectedModel.id).toBe(qwenModelId);
    } finally {
      await serverlessApp.close();
    }
  });
});
