import { describe, expect, it } from "vitest";
import { getAssistantProfileByKey } from "@nexus/assistant-profiles";
import type { ProviderPreferenceSet, ProviderSelection } from "@nexus/shared";
import { OWNER_ID } from "../auth/session.js";
import {
  createModelSelectionService,
  createOpenRouterAdapter,
  createProviderCatalogService,
  deriveModelId,
  OPENROUTER_PROVIDER_ID,
} from "./index.js";

const FAKE_TEST_KEY = "test-only-fake-openrouter-credential-catalog-772";
const YUI_ID = getAssistantProfileByKey("yui")!.id;
const SCHWI_ID = getAssistantProfileByKey("schwi")!.id;
const CONVERSATION_ID_1 = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID_2 = "22222222-2222-4222-8222-222222222222";
const UNKNOWN_PROVIDER_ID = "99999999-9999-4999-8999-999999999999";
const UNKNOWN_MODEL_ID = "88888888-8888-4888-8888-888888888888";
const FIXED_NOW = "2026-11-05T00:00:00.000Z";

function makePrefs(options: {
  global?: ProviderSelection;
  byAssistant?: Array<{ assistantId: string; selection: ProviderSelection }>;
  byConversation?: Array<{ conversationId: string; selection: ProviderSelection }>;
} = {}): ProviderPreferenceSet {
  return {
    global: {
      id: OWNER_ID,
      userId: OWNER_ID,
      selection: options.global ?? { mode: "automatic" },
      updatedAt: FIXED_NOW,
    },
    byAssistant: (options.byAssistant ?? []).map((item) => ({
      id: item.assistantId,
      userId: OWNER_ID,
      assistantId: item.assistantId,
      selection: item.selection,
      updatedAt: FIXED_NOW,
    })),
    byConversation: (options.byConversation ?? []).map((item) => ({
      userId: OWNER_ID,
      conversationId: item.conversationId,
      selection: item.selection,
      updatedAt: FIXED_NOW,
    })),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function buildCatalogPayload() {
  return {
    data: [
      {
        id: "meta-llama/llama-3.3-70b-instruct:free",
        name: "Llama 3.3 70B Free",
        context_length: 131072,
        pricing: { prompt: "0", completion: "0", request: "0" },
        top_provider: { context_length: 131072, max_completion_tokens: 8192 },
        supported_parameters: ["temperature", "top_p", "max_tokens", "stop"],
      },
      {
        id: "qwen/qwen3-coder:free",
        name: "Qwen 3 Coder Free",
        context_length: 65536,
        pricing: { prompt: "0", completion: "0" },
        top_provider: { context_length: 65536, max_completion_tokens: 8192 },
        supported_parameters: [
          "temperature",
          "top_p",
          "max_tokens",
          "response_format",
          "reasoning",
        ],
      },
      {
        id: "google/gemma-offline:free",
        name: "Gemma Offline Free",
        context_length: 32768,
        unavailable: true,
        pricing: { prompt: "0", completion: "0" },
        supported_parameters: ["temperature"],
      },
      {
        id: "anthropic/claude-sonnet-4",
        name: "Claude Sonnet 4 (Paid)",
        context_length: 200000,
        pricing: { prompt: "0.000003", completion: "0.000015" },
        supported_parameters: ["temperature", "max_tokens", "response_format"],
      },
      {
        id: "vendor/ambiguous-price:free",
        name: "Ambiguous Price Free",
        context_length: 32768,
        pricing: null,
        supported_parameters: ["temperature"],
      },
    ],
  };
}

describe("ProviderCatalogService", () => {
  it("lists only eligible free models, separates unavailable free models, and blocks paid & unverified models", async () => {
    const adapter = createOpenRouterAdapter({
      apiKey: FAKE_TEST_KEY,
      fetchFn: (async () => jsonResponse(buildCatalogPayload())) as typeof fetch,
      now: () => 1_700_000_000_000,
    });

    const catalog = createProviderCatalogService({
      adapters: [adapter],
      ttlMs: 30_000,
      now: () => 1_700_000_000_000,
    });

    const result = await catalog.listEligibleModels();

    expect(result.models.map((m) => m.key)).toEqual([
      "meta-llama/llama-3.3-70b-instruct:free",
      "qwen/qwen3-coder:free",
    ]);
    expect(result.unavailableModels.map((m) => m.key)).toEqual([
      "google/gemma-offline:free",
    ]);
    expect(result.summary).toEqual({
      totalEvaluated: 5,
      eligibleCount: 2,
      unavailableFreeCount: 1,
      blockedPaidCount: 1,
      blockedUnverifiedCount: 1,
    });

    const reasoningOnly = await catalog.listEligibleModels({
      capability: "reasoning",
    });
    expect(reasoningOnly.models.map((m) => m.key)).toEqual([
      "qwen/qwen3-coder:free",
    ]);
  });

  it("enforces TTL expiration and never serves stale expired cache when upstream refresh fails", async () => {
    let clockMs = 1_000_000;
    let shouldFail = false;
    let fetchCalls = 0;

    const adapter = createOpenRouterAdapter({
      apiKey: FAKE_TEST_KEY,
      fetchFn: (async () => {
        fetchCalls += 1;
        if (shouldFail) {
          return jsonResponse({ error: { message: "Upstream down" } }, 503);
        }
        return jsonResponse(buildCatalogPayload());
      }) as typeof fetch,
      now: () => clockMs,
    });

    const catalog = createProviderCatalogService({
      adapters: [adapter],
      ttlMs: 10_000,
      now: () => clockMs,
    });

    await catalog.listEligibleModels();
    expect(fetchCalls).toBe(1);

    clockMs += 5_000;
    await catalog.listEligibleModels();
    expect(fetchCalls).toBe(1);

    await catalog.listEligibleModels({ forceRefresh: true });
    expect(fetchCalls).toBe(2);

    clockMs += 15_000;
    shouldFail = true;
    await expect(catalog.listEligibleModels()).rejects.toMatchObject({
      code: "UNAVAILABLE",
      statusCode: 503,
    });
    expect(fetchCalls).toBe(3);
  });
});

describe("ModelSelectionService", () => {
  const llamaModelId = deriveModelId(
    OPENROUTER_PROVIDER_ID,
    "meta-llama/llama-3.3-70b-instruct:free",
  );
  const qwenModelId = deriveModelId(
    OPENROUTER_PROVIDER_ID,
    "qwen/qwen3-coder:free",
  );
  const paidClaudeModelId = deriveModelId(
    OPENROUTER_PROVIDER_ID,
    "anthropic/claude-sonnet-4",
  );
  const unverifiedModelId = deriveModelId(
    OPENROUTER_PROVIDER_ID,
    "vendor/ambiguous-price:free",
  );
  const offlineFreeModelId = deriveModelId(
    OPENROUTER_PROVIDER_ID,
    "google/gemma-offline:free",
  );

  function buildSelectionStack(payload = buildCatalogPayload()) {
    const adapter = createOpenRouterAdapter({
      apiKey: FAKE_TEST_KEY,
      fetchFn: (async () => jsonResponse(payload)) as typeof fetch,
      now: () => 1_700_000_000_000,
    });
    const catalog = createProviderCatalogService({
      adapters: [adapter],
      ttlMs: 30_000,
      now: () => 1_700_000_000_000,
    });
    const selection = createModelSelectionService({
      catalog,
      now: () => 1_700_000_000_000,
    });
    return { adapter, catalog, selection };
  }

  it("selects a compatible free model in 'automatic' mode and honors capability/parameter requirements", async () => {
    const { selection } = buildSelectionStack();
    const prefs = makePrefs();

    const defaultAuto = await selection.resolveEffectiveSelection(prefs);
    expect(defaultAuto.resolvedScope).toBe("global");
    expect(defaultAuto.model.key).toBe("meta-llama/llama-3.3-70b-instruct:free");
    expect(defaultAuto.response.policy).toEqual({
      freeVerified: true,
      paidFallbackUsed: false,
    });

    const structuredAuto = await selection.resolveEffectiveSelection(prefs, {
      requiredCapabilities: ["chat", "structured_output"],
      requiredParameters: ["responseFormat"],
    });
    expect(structuredAuto.model.key).toBe("qwen/qwen3-coder:free");
  });

  it("enforces strict conversation -> assistant -> global precedence across manual and automatic modes", async () => {
    const { selection } = buildSelectionStack();

    const prefs = makePrefs({
      global: {
        mode: "manual",
        providerId: OPENROUTER_PROVIDER_ID,
        modelId: llamaModelId,
      },
      byAssistant: [
        {
          assistantId: SCHWI_ID,
          selection: {
            mode: "manual",
            providerId: OPENROUTER_PROVIDER_ID,
            modelId: qwenModelId,
          },
        },
      ],
      byConversation: [
        {
          conversationId: CONVERSATION_ID_1,
          selection: { mode: "automatic" },
        },
        {
          conversationId: CONVERSATION_ID_2,
          selection: {
            mode: "manual",
            providerId: OPENROUTER_PROVIDER_ID,
            modelId: llamaModelId,
          },
        },
      ],
    });

    const forYui = await selection.resolveEffectiveSelection(prefs, {
      assistantId: YUI_ID,
    });
    expect(forYui.resolvedScope).toBe("global");
    expect(forYui.model.id).toBe(llamaModelId);

    const forSchwi = await selection.resolveEffectiveSelection(prefs, {
      assistantId: SCHWI_ID,
    });
    expect(forSchwi.resolvedScope).toBe("assistant");
    expect(forSchwi.model.id).toBe(qwenModelId);

    const forConv1 = await selection.resolveEffectiveSelection(prefs, {
      assistantId: SCHWI_ID,
      conversationId: CONVERSATION_ID_1,
    });
    expect(forConv1.resolvedScope).toBe("conversation");
    expect(forConv1.preference).toEqual({ mode: "automatic" });
    expect(forConv1.model.id).toBe(llamaModelId);

    const forConv2 = await selection.resolveEffectiveSelection(prefs, {
      assistantId: SCHWI_ID,
      conversationId: CONVERSATION_ID_2,
    });
    expect(forConv2.resolvedScope).toBe("conversation");
    expect(forConv2.model.id).toBe(llamaModelId);
  });

  it("rejects invalid, paid, unverified, unavailable, or incompatible manual preferences without falling back", async () => {
    const { selection } = buildSelectionStack();

    await expect(
      selection.resolveEffectiveSelection(
        makePrefs({
          global: {
            mode: "manual",
            providerId: OPENROUTER_PROVIDER_ID,
            modelId: paidClaudeModelId,
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "PAID_MODEL_BLOCKED",
      statusCode: 403,
    });

    await expect(
      selection.resolveEffectiveSelection(
        makePrefs({
          global: {
            mode: "manual",
            providerId: OPENROUTER_PROVIDER_ID,
            modelId: unverifiedModelId,
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "UNVERIFIED_PRICING_BLOCKED",
      statusCode: 403,
    });

    await expect(
      selection.resolveEffectiveSelection(
        makePrefs({
          global: {
            mode: "manual",
            providerId: OPENROUTER_PROVIDER_ID,
            modelId: offlineFreeModelId,
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "MODEL_UNAVAILABLE",
      statusCode: 503,
    });

    await expect(
      selection.resolveEffectiveSelection(
        makePrefs({
          global: {
            mode: "manual",
            providerId: UNKNOWN_PROVIDER_ID,
            modelId: llamaModelId,
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_SELECTION",
      statusCode: 422,
    });

    await expect(
      selection.resolveEffectiveSelection(
        makePrefs({
          global: {
            mode: "manual",
            providerId: OPENROUTER_PROVIDER_ID,
            modelId: UNKNOWN_MODEL_ID,
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_SELECTION",
      statusCode: 422,
    });

    await expect(
      selection.resolveEffectiveSelection(
        makePrefs({
          global: {
            mode: "manual",
            providerId: OPENROUTER_PROVIDER_ID,
            modelId: llamaModelId,
          },
        }),
        { requiredParameters: ["responseFormat"] },
      ),
    ).rejects.toMatchObject({
      code: "INCOMPATIBLE_PARAMETERS",
      statusCode: 422,
    });
  });

  it("never falls back to paid models when all free models are unavailable in automatic mode", async () => {
    const onlyPaidAndOfflineFreePayload = {
      data: [
        {
          id: "openai/gpt-4o",
          name: "GPT-4o Paid",
          context_length: 128000,
          pricing: { prompt: "0.0000025", completion: "0.00001" },
          supported_parameters: ["temperature", "max_tokens"],
        },
        {
          id: "google/gemma-offline:free",
          name: "Gemma Offline Free",
          context_length: 32768,
          unavailable: true,
          pricing: { prompt: "0", completion: "0" },
          supported_parameters: ["temperature"],
        },
      ],
    };

    const { selection } = buildSelectionStack(onlyPaidAndOfflineFreePayload);

    await expect(
      selection.resolveEffectiveSelection(makePrefs()),
    ).rejects.toMatchObject({
      code: "MODEL_UNAVAILABLE",
      statusCode: 503,
    });
  });
});
