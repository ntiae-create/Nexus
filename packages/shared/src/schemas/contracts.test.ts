import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  assistantMemorySchema,
  assistantProviderPreferenceSchema,
  conversationProviderPreferenceSchema,
  coordinatorDecisionEnvelopeSchema,
  coreContextReportSchema,
  coreExecutionErrorCodeSchema,
  coreExecutionRequestSchema,
  coreExecutionResponseSchema,
  coreExecutionInspectionSchema,
  coreRunSchema,
  delegationOutcomeRecordSchema,
  delegationTaskSpecSchema,
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

describe("NEXUS CORE execution and delegation contracts", () => {
  it("keeps root executions free of delegation lineage and accepts consistent child lineage", () => {
    const root = {
      id: ids.run, userId: ids.user, conversationId: ids.conversation, requestId: ids.run,
      idempotencyKey: "request-1", status: "running", assistantIds: [ids.assistant], trace: [],
      inputMessageId: ids.message, createdAt: now, formatVersion: 1,
    };
    expect(coreRunSchema.safeParse({ ...root, delegationDepth: 0 }).success).toBe(true);
    expect(coreRunSchema.safeParse({ ...root, delegationDepth: 1 }).success).toBe(false);
    expect(coreRunSchema.safeParse({ ...root, parentRunId: ids.run }).success).toBe(false);

    const child = {
      ...root,
      parentRunId: ids.result,
      parentStepId: ids.step,
      delegationDepth: 1,
      metadata: { objective: "analisar" },
    };
    expect(coreRunSchema.safeParse(child).success).toBe(true);
    expect(coreRunSchema.safeParse({ ...child, parentStepId: undefined }).success).toBe(false);
    expect(coreRunSchema.safeParse({ ...child, parentRunId: child.id }).success).toBe(false);
    expect(coreRunSchema.safeParse({ ...child, delegationDepth: 0 }).success).toBe(false);
    expect(
      coreRunSchema.safeParse({ ...child, metadata: { api_key: "leak" } }).success,
    ).toBe(false);
  });

  it("validates the structured coordination envelope and rejects ad-hoc payloads", () => {
    expect(
      coordinatorDecisionEnvelopeSchema.safeParse({
        kind: "nexus.core.coordination.v1",
        action: "delegate",
        delegations: [{ targetAssistant: "alice", objective: "comparar fontes" }],
      }).success,
    ).toBe(true);
    expect(
      coordinatorDecisionEnvelopeSchema.safeParse({
        kind: "nexus.core.coordination.v1",
        action: "respond",
        response: "Resposta direta",
      }).success,
    ).toBe(true);
    expect(
      coordinatorDecisionEnvelopeSchema.safeParse({
        kind: "nexus.core.coordination.v1",
        action: "delegate",
        delegations: [],
      }).success,
    ).toBe(false);
    expect(
      coordinatorDecisionEnvelopeSchema.safeParse({
        kind: "nexus.core.coordination.v1",
        action: "execute",
        command: "/delegate alice",
      }).success,
    ).toBe(false);
    expect(
      delegationTaskSpecSchema.safeParse({ targetAssistant: "yui", objective: "loop" }).success,
    ).toBe(true);
    expect(
      delegationTaskSpecSchema.safeParse({ targetAssistant: "alice", objective: "" }).success,
    ).toBe(false);
    expect(
      delegationTaskSpecSchema.safeParse({
        targetAssistant: "alice",
        objective: "x",
        subDelegations: [{ targetAssistant: "schwi", objective: "y" }],
      }).success,
    ).toBe(true);
  });

  it("enforces the execution request contract boundaries", () => {
    const base = {
      content: [{ type: "text", text: "Olá" }],
      requestId: ids.run,
      idempotencyKey: "client-key-1",
    };
    expect(coreExecutionRequestSchema.safeParse(base).success).toBe(true);
    expect(coreExecutionRequestSchema.safeParse({ ...base, assistantKey: "yui" }).success).toBe(true);
    // Fase 1 (G1): o contrato valida FORMA, não existência. "unknown" é uma chave bem formada;
    // quem decide que ela não existe é o registro no servidor, que responde ASSISTANT_NOT_FOUND
    // (coberto em apps/server/src/routes/core.test.ts). Manter a rejeição aqui exigiria que o
    // pacote compartilhado conhecesse o catálogo — exatamente o acoplamento que a fase remove.
    expect(coreExecutionRequestSchema.safeParse({ ...base, assistantKey: "unknown" }).success).toBe(true);
    // Forma inválida continua rejeitada pelo contrato.
    expect(coreExecutionRequestSchema.safeParse({ ...base, assistantKey: "YUI" }).success).toBe(false);
    expect(coreExecutionRequestSchema.safeParse({ ...base, assistantKey: "-bad" }).success).toBe(false);
    expect(coreExecutionRequestSchema.safeParse({ ...base, assistantKey: "" }).success).toBe(false);
    expect(coreExecutionRequestSchema.safeParse({ ...base, assistantKey: "a" }).success).toBe(false);
    expect(coreExecutionRequestSchema.safeParse({ ...base, idempotencyKey: "x".repeat(141) }).success).toBe(false);
    expect(coreExecutionRequestSchema.safeParse({ ...base, content: [] }).success).toBe(false);
    expect(coreExecutionRequestSchema.safeParse({ ...base, timeoutMs: 99 }).success).toBe(false);
    expect(coreExecutionRequestSchema.safeParse({ ...base, unexpected: true }).success).toBe(false);
    expect(
      coreExecutionRequestSchema.safeParse({ ...base, metadata: { access_token: "nope" } }).success,
    ).toBe(false);
    expect(coreExecutionErrorCodeSchema.safeParse("DELEGATION_CYCLE_DETECTED").success).toBe(true);
    expect(coreExecutionErrorCodeSchema.safeParse("SOMETHING_ELSE").success).toBe(false);
  });

  it("validates the persisted execution response and inspection contracts", () => {
    const reference = { assistantId: ids.assistant, assistantKey: "yui", configVersion: "1.0.0" };
    const run = {
      id: ids.run, userId: ids.user, conversationId: ids.conversation, requestId: ids.run,
      idempotencyKey: "request-1", status: "succeeded" as const, assistantIds: [ids.assistant],
      trace: [reference], inputMessageId: ids.message, finalMessageId: ids.result,
      startedAt: now, finishedAt: now, createdAt: now, formatVersion: 1,
    };
    const message = {
      id: ids.message, userId: ids.user, conversationId: ids.conversation, sequence: 0,
      role: "user" as const, status: "complete" as const,
      content: [{ type: "text" as const, text: "olá" }], formatVersion: 1, createdAt: now,
    };
    const assistantMessage = {
      ...message, id: ids.result, sequence: 1, role: "assistant" as const, assistantId: ids.assistant,
    };
    const contextReport = {
      effectiveContextWindow: 8192, usedFallbackWindow: false, reservedOutputBudget: 1024,
      availableInputBudget: 7168, estimatedInputUnits: 120, includedHistoryCount: 2,
      omittedHistoryCount: 0,
    };
    expect(coreContextReportSchema.safeParse(contextReport).success).toBe(true);
    expect(coreContextReportSchema.safeParse({ ...contextReport, effectiveContextWindow: 0 }).success).toBe(false);
    expect(coreContextReportSchema.safeParse({ ...contextReport, extra: 1 }).success).toBe(false);

    const response = {
      execution: run,
      inputMessage: message,
      assistantMessage,
      steps: [],
      results: [],
      delegations: [],
      childExecutions: [],
      modelSelection: {
        resolvedScope: "global" as const,
        providerId: ids.provider, providerKey: "openrouter", providerName: "OpenRouter",
        modelId: ids.model, modelKey: "meta-llama/llama-3.3-70b-instruct:free",
        modelName: "Llama 3.3 70B Free", contextWindow: 131072,
        freeEligibility: {
          eligible: true, costStatus: "free_confirmed", verifiedAt: now,
          requiresPreCallVerification: true, reason: "verified_free",
          pricingSummary: { promptPerToken: 0, completionPerToken: 0, requestFixed: null },
        },
      },
      contextReport,
      replayed: false,
    };
    expect(coreExecutionResponseSchema.safeParse(response).success).toBe(true);
    expect(
      coreExecutionResponseSchema.safeParse({ ...response, replayed: true, delegationOutcome: "x" }).success,
    ).toBe(false);
    expect(
      coreExecutionInspectionSchema.safeParse({
        execution: run, steps: [], results: [], childExecutions: [],
      }).success,
    ).toBe(true);
  });

  it("requires explicit delegated outcome records to be fully traceable", () => {
    const record = {
      childRunId: ids.run, parentRunId: ids.result, parentStepId: ids.step,
      childStepId: ids.memory, childResultId: ids.result,
      assistant: { assistantId: ids.assistant, assistantKey: "alice", configVersion: "1.0.0" },
      objective: "analisar fontes", status: "succeeded" as const, outputText: "síntese",
      providerKey: "openrouter", modelKey: "qwen/qwen3-coder:free", delegationDepth: 1,
    };
    expect(delegationOutcomeRecordSchema.safeParse(record).success).toBe(true);
    expect(delegationOutcomeRecordSchema.safeParse({ ...record, status: "failed" }).success).toBe(false);
    expect(delegationOutcomeRecordSchema.safeParse({ ...record, delegationDepth: 0 }).success).toBe(false);
    expect(delegationOutcomeRecordSchema.safeParse({ ...record, outputText: "" }).success).toBe(false);
  });
});
