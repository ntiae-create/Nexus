import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  assistantMemorySchema,
  assistantProviderPreferenceSchema,
  conversationProviderPreferenceSchema,
  coreRunSchema,
  effectiveModelSelectionResponseSchema,
  eligibleModelsResponseSchema,
  freeEligibilitySchema,
  initialAssistantKeySchema,
  initialAssistantProfileSchema,
  incrementalSyncRequestSchema,
  incrementalSyncResponseSchema,
  memoryAccessDecision,
  memoryAccessRequestSchema,
  memoryPermissionSchema,
  messageSchema,
  modelGenerationRequestSchema,
  modelGenerationResponseSchema,
  modelSchema,
  providerPreferencePolicySchema,
  providerSchema,
  providersListResponseSchema,
  publicCapabilitiesResponseSchema,
  resolveProviderSelection,
  resolveProviderSelectionWithScope,
  runResultSchema,
  runTransitionSchema,
  syncCursorSchema,
  toolEventSchema,
  tombstoneSchema,
  userIdentitySchema,
} from "./index.js";

const ids = {
  user: "d9428888-122b-4c81-8f6d-5f9b1f3b5b21",
  assistant: "d9428888-122b-4c81-8f6d-5f9b1f3b5b22",
  conversation: "d9428888-122b-4c81-8f6d-5f9b1f3b5b23",
  message: "d9428888-122b-4c81-8f6d-5f9b1f3b5b24",
  run: "d9428888-122b-4c81-8f6d-5f9b1f3b5b25",
  step: "d9428888-122b-4c81-8f6d-5f9b1f3b5b26",
  memory: "d9428888-122b-4c81-8f6d-5f9b1f3b5b27",
  permission: "d9428888-122b-4c81-8f6d-5f9b1f3b5b28",
  provider: "d9428888-122b-4c81-8f6d-5f9b1f3b5b29",
  model: "d9428888-122b-4c81-8f6d-5f9b1f3b5b30",
  result: "d9428888-122b-4c81-8f6d-5f9b1f3b5b31",
  otherAssistant: "d9428888-122b-4c81-8f6d-5f9b1f3b5b32",
};
const now = "2026-11-03T12:00:00Z";

describe("identity and assistants", () => {
  it("validates UUID identity and rejects malformed identifiers", () => {
    expect(userIdentitySchema.safeParse({ userId: ids.user }).success).toBe(true);
    expect(userIdentitySchema.safeParse({ userId: "user-1" }).success).toBe(false);
  });

  it("recognizes all initial assistants and remains extensible", () => {
    expect(initialAssistantKeySchema.parse("yui")).toBe("yui");
    expect(initialAssistantKeySchema.parse("alice")).toBe("alice");
    expect(initialAssistantKeySchema.parse("schwi")).toBe("schwi");
    expect(initialAssistantKeySchema.safeParse("new-assistant").success).toBe(false);
    expect(initialAssistantProfileSchema.safeParse({
      id: ids.assistant, key: "new-assistant", name: "New", configVersion: "1", configuration: {},
      status: "active", createdAt: now, updatedAt: now,
    }).success).toBe(false);
  });
});

describe("messages and executions", () => {
  it("validates required and optional message fields and timestamps", () => {
    const message = {
      id: ids.message, userId: ids.user, conversationId: ids.conversation, sequence: 0,
      role: "user", status: "complete", content: [{ type: "text", text: "hello" }],
      formatVersion: 1, createdAt: now,
    };
    expect(messageSchema.safeParse(message).success).toBe(true);
    expect(messageSchema.safeParse({ ...message, assistantId: ids.assistant, updatedAt: now }).success).toBe(false);
    expect(messageSchema.safeParse({ ...message, role: "assistant", assistantId: ids.assistant, updatedAt: now }).success).toBe(true);
    expect(messageSchema.safeParse({ ...message, role: "assistant" }).success).toBe(false);
    expect(messageSchema.safeParse({ ...message, sequence: -1 }).success).toBe(false);
    expect(messageSchema.safeParse({ ...message, createdAt: "yesterday" }).success).toBe(false);
    expect(messageSchema.safeParse({ ...message, role: "provider-message" }).success).toBe(false);
  });

  it("validates run states, transitions, steps, events and consolidated results", () => {
    expect(coreRunSchema.safeParse({
      id: ids.run, userId: ids.user, conversationId: ids.conversation, requestId: ids.run,
      idempotencyKey: "request-1", status: "running", assistantIds: [ids.assistant], trace: [],
      inputMessageId: ids.message, createdAt: now, formatVersion: 1,
    }).success).toBe(true);
    expect(runTransitionSchema.safeParse({ from: "queued", to: "running" }).success).toBe(true);
    expect(runTransitionSchema.safeParse({ from: "succeeded", to: "running" }).success).toBe(false);
    expect(toolEventSchema.safeParse({
      id: ids.step, userId: ids.user, runId: ids.run, tool: "web-search", eventType: "search",
      status: "succeeded", normalizedData: { count: 1 }, references: [], origin: "alice-search",
      occurredAt: now, formatVersion: 1,
    }).success).toBe(true);
    expect(toolEventSchema.safeParse({
      id: ids.step, userId: ids.user, runId: ids.run, tool: "web-search", eventType: "search",
      status: "succeeded", normalizedData: { nested: { api_key: "secret" } }, references: [], origin: "alice-search",
      occurredAt: now, formatVersion: 1,
    }).success).toBe(false);
    expect(runResultSchema.safeParse({
      id: ids.result, userId: ids.user, runId: ids.run, status: "partial", content: [], references: [],
      formatVersion: 1, createdAt: now,
    }).success).toBe(true);
  });
});

describe("memory permissions", () => {
  const sharedMemory = {
    id: ids.memory, userId: ids.user, visibility: "shared", source: "user_note", content: "likes tea",
    authorizedAssistantIds: [ids.assistant], formatVersion: 1, status: "active", createdAt: now, updatedAt: now,
  };

  it("requires explicit grants for shared items and a valid grant for access", () => {
    expect(assistantMemorySchema.safeParse({ ...sharedMemory, authorizedAssistantIds: [] }).success).toBe(false);
    const request = memoryAccessRequestSchema.parse({
      userId: ids.user, memory: sharedMemory, requestingAssistantId: ids.assistant, permissions: [],
    });
    expect(memoryAccessDecision(request).allowed).toBe(false);
    const grant = memoryPermissionSchema.parse({
      id: ids.permission, userId: ids.user, memoryId: ids.memory, assistantId: ids.assistant,
      status: "granted", grantedByUserId: ids.user, grantedAt: now,
    });
    expect(memoryAccessDecision({ ...request, permissions: [grant] }).allowed).toBe(true);
    const revoked = memoryPermissionSchema.parse({
      ...grant, status: "revoked", revokedByUserId: ids.user, revokedAt: now,
    });
    expect(memoryAccessDecision({ ...request, permissions: [revoked] }).reason).toBe("revoked_grant");
  });

  it("allows an assistant its individual memory but does not expose it to another assistant", () => {
    const request = memoryAccessRequestSchema.parse({
      userId: ids.user,
      memory: { ...sharedMemory, visibility: "individual", authorizedAssistantIds: [], originAssistantId: ids.assistant },
      requestingAssistantId: ids.assistant,
      permissions: [],
    });
    expect(memoryAccessDecision(request)).toMatchObject({ allowed: true, reason: "owner_assistant" });
    expect(memoryAccessDecision({ ...request, requestingAssistantId: ids.otherAssistant })).toMatchObject({ allowed: false, reason: "not_shared" });
  });
});

describe("providers and preferences", () => {
  it("validates provider/model catalog fields", () => {
    const provider = {
      id: ids.provider, key: "provider-a", name: "Provider A", availability: "available",
      costStatus: "free_confirmed", capabilities: ["chat"], metadata: {}, createdAt: now, updatedAt: now,
    };
    expect(providerSchema.safeParse(provider).success).toBe(true);
    expect(modelSchema.safeParse({
      id: ids.model, providerId: ids.provider, key: "model-a", name: "Model A", availability: "available",
      capabilities: ["chat"], metadata: {}, createdAt: now, updatedAt: now,
    }).success).toBe(true);
  });

  it("supports global, assistant and conversation preference levels while enforcing authorization", () => {
    const preferences = {
      global: { id: ids.provider, userId: ids.user, selection: { mode: "automatic" }, updatedAt: now },
      byAssistant: [{ id: ids.model, userId: ids.user, assistantId: ids.assistant, selection: { mode: "automatic" }, updatedAt: now }],
      byConversation: [{ userId: ids.user, conversationId: ids.conversation, selection: { mode: "automatic" }, updatedAt: now }],
    };
    expect(assistantProviderPreferenceSchema.safeParse(preferences.byAssistant[0]).success).toBe(true);
    expect(conversationProviderPreferenceSchema.safeParse(preferences.byConversation[0]).success).toBe(true);
    expect(providerPreferencePolicySchema.safeParse({
      preferences: { ...preferences, byConversation: [{ ...preferences.byConversation[0], selection: { mode: "manual", providerId: ids.provider, modelId: ids.model } }] },
      authorizations: [{ userId: ids.user, providerId: ids.provider, authorized: true, paidUseAuthorized: false }],
      catalog: [{ provider: { id: ids.provider, key: "provider", name: "Provider", availability: "available", costStatus: "free_confirmed", capabilities: [], metadata: {}, createdAt: now, updatedAt: now }, models: [{ id: ids.model, providerId: ids.provider, key: "model", name: "Model", availability: "available", capabilities: [], metadata: {}, createdAt: now, updatedAt: now }] }],
    }).success).toBe(true);
    expect(providerPreferencePolicySchema.safeParse({
      preferences: { ...preferences, byConversation: [{ ...preferences.byConversation[0], selection: { mode: "manual", providerId: ids.provider, modelId: ids.model } }] },
      authorizations: [{ userId: ids.user, providerId: ids.provider, authorized: true, paidUseAuthorized: false }],
      catalog: [{ provider: { id: ids.provider, key: "provider", name: "Provider", availability: "available", costStatus: "paid", capabilities: [], metadata: {}, createdAt: now, updatedAt: now }, models: [{ id: ids.model, providerId: ids.provider, key: "model", name: "Model", availability: "available", capabilities: [], metadata: {}, createdAt: now, updatedAt: now }] }],
    }).success).toBe(false);
    expect(providerPreferencePolicySchema.safeParse({
      preferences: { ...preferences, byConversation: [{ ...preferences.byConversation[0], selection: { mode: "manual", providerId: ids.provider, modelId: ids.model } }] },
      authorizations: [],
      catalog: [],
    }).success).toBe(false);
    expect(resolveProviderSelection({
      ...preferences,
      global: { ...preferences.global, selection: { mode: "manual", providerId: ids.provider, modelId: ids.model } },
      byAssistant: [{ ...preferences.byAssistant[0], selection: { mode: "manual", providerId: ids.provider, modelId: ids.model } }],
      byConversation: [{ ...preferences.byConversation[0], selection: { mode: "automatic" } }],
    }, { assistantId: ids.assistant, conversationId: ids.conversation })).toEqual({ mode: "automatic" });
  });
});

describe("sync and API errors", () => {
  it("validates opaque cursors, incremental responses, and tombstones", () => {
    expect(syncCursorSchema.safeParse({ userId: ids.user, cursor: "opaque:v1:abc" }).success).toBe(true);
    expect(incrementalSyncRequestSchema.safeParse({ cursor: null, limit: 50 }).success).toBe(true);
    expect(incrementalSyncRequestSchema.safeParse({ cursor: "x", limit: 0 }).success).toBe(false);
    const tombstone = { id: ids.result, userId: ids.user, entityType: "conversation", entityId: ids.conversation, deletedAt: now, sequence: 9 };
    expect(tombstoneSchema.safeParse(tombstone).success).toBe(true);
    expect(incrementalSyncResponseSchema.safeParse({
      changes: [{ kind: "tombstone", tombstone }], nextCursor: "opaque:next", hasMore: false, generatedAt: now,
    }).success).toBe(true);
  });

  it("validates the standard API error envelope", () => {
    expect(apiErrorSchema.safeParse({
      error: { code: "NOT_FOUND", message: "Resource not found", requestId: ids.run, retryable: false },
      timestamp: now,
    }).success).toBe(true);
    expect(apiErrorSchema.safeParse({ error: { message: "missing fields" }, timestamp: now }).success).toBe(false);
  });

  it("enforces vendor-independent provider, free-eligibility, generation, and selection contracts", () => {
    const validFree = {
      eligible: true,
      costStatus: "free_confirmed" as const,
      verifiedAt: now,
      requiresPreCallVerification: true as const,
      reason: "verified_free" as const,
      pricingSummary: {
        promptPerToken: 0,
        completionPerToken: 0,
        requestFixed: 0,
      },
    };
    expect(freeEligibilitySchema.safeParse(validFree).success).toBe(true);
    expect(
      freeEligibilitySchema.safeParse({
        ...validFree,
        costStatus: "paid",
      }).success,
    ).toBe(false);
    expect(
      freeEligibilitySchema.safeParse({
        ...validFree,
        reason: "paid_model",
      }).success,
    ).toBe(false);

    expect(
      modelGenerationRequestSchema.safeParse({
        model: "meta-llama/llama-3.3-70b-instruct:free",
        messages: [{ role: "user", content: "Hello" }],
        parameters: { temperature: 0.4, maxOutputTokens: 256 },
      }).success,
    ).toBe(true);

    expect(
      modelGenerationResponseSchema.safeParse({
        id: "gen-123",
        providerId: ids.provider,
        providerKey: "openrouter",
        modelId: ids.model,
        modelKey: "meta-llama/llama-3.3-70b-instruct:free",
        content: "Normalized answer",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        createdAt: now,
        freeEligibility: validFree,
      }).success,
    ).toBe(true);

    expect(
      providersListResponseSchema.safeParse({
        providers: [
          {
            id: ids.provider,
            key: "openrouter",
            name: "OpenRouter",
            kind: "cloud",
            configured: true,
            availability: "available",
            costPolicy: "free_only",
            costStatus: "free_confirmed",
            capabilities: ["chat", "system_prompt"],
            supportedParameters: ["temperature", "maxOutputTokens"],
            eligibleModelCount: 1,
            verifiedAt: now,
          },
        ],
        generatedAt: now,
      }).success,
    ).toBe(true);

    const eligibleModel = {
      id: ids.model,
      providerId: ids.provider,
      providerKey: "openrouter",
      key: "meta-llama/llama-3.3-70b-instruct:free",
      name: "Llama 3.3 70B Free",
      availability: "available" as const,
      capabilities: ["chat" as const, "system_prompt" as const],
      supportedParameters: ["temperature" as const, "maxOutputTokens" as const],
      contextWindow: 131072,
      maxOutputTokens: 8192,
      freeEligibility: validFree,
    };

    expect(
      eligibleModelsResponseSchema.safeParse({
        models: [eligibleModel],
        unavailableModels: [],
        summary: {
          totalEvaluated: 3,
          eligibleCount: 1,
          unavailableFreeCount: 0,
          blockedPaidCount: 1,
          blockedUnverifiedCount: 1,
        },
        fetchedAt: now,
        expiresAt: now,
      }).success,
    ).toBe(true);

    expect(
      publicCapabilitiesResponseSchema.safeParse({
        policy: {
          costMode: "free_only",
          paidModelsAllowed: false,
          paidFallbackAllowed: false,
          preCallPriceVerificationRequired: true,
          openRouterFreeSuffix: ":free",
        },
        capabilities: [{ key: "chat", description: "Chat generation" }],
        parameters: [{ key: "temperature", description: "Sampling temperature" }],
        selectionScopes: ["conversation", "assistant", "global"],
        selectionModes: ["manual", "automatic"],
        providers: [
          {
            id: ids.provider,
            key: "openrouter",
            name: "OpenRouter",
            kind: "cloud",
            configured: true,
            availability: "available",
            capabilities: ["chat"],
            supportedParameters: ["temperature"],
          },
        ],
        generatedAt: now,
      }).success,
    ).toBe(true);

    expect(
      effectiveModelSelectionResponseSchema.safeParse({
        resolvedScope: "assistant",
        preference: { mode: "automatic" },
        context: { assistantId: ids.assistant },
        selectedProvider: {
          id: ids.provider,
          key: "openrouter",
          name: "OpenRouter",
          kind: "cloud",
        },
        selectedModel: eligibleModel,
        policy: {
          freeVerified: true,
          paidFallbackUsed: false,
        },
        evaluatedAt: now,
      }).success,
    ).toBe(true);

    const prefs = {
      global: {
        id: ids.provider,
        userId: ids.user,
        selection: { mode: "automatic" as const },
        updatedAt: now,
      },
      byAssistant: [
        {
          id: ids.model,
          userId: ids.user,
          assistantId: ids.assistant,
          selection: {
            mode: "manual" as const,
            providerId: ids.provider,
            modelId: ids.model,
          },
          updatedAt: now,
        },
      ],
      byConversation: [],
    };
    expect(
      resolveProviderSelectionWithScope(prefs, { assistantId: ids.assistant }),
    ).toEqual({
      scope: "assistant",
      selection: {
        mode: "manual",
        providerId: ids.provider,
        modelId: ids.model,
      },
    });
    expect(resolveProviderSelectionWithScope(prefs, {})).toEqual({
      scope: "global",
      selection: { mode: "automatic" },
    });
  });
});
