import type {
  FreeEligibility,
  GenerationMessage,
  ModelCapability,
  ModelGenerationResponse,
} from "@nexus/shared";
import {
  createProviderCatalogService,
  createModelSelectionService,
  deriveModelId,
  OPENROUTER_PROVIDER_ID,
  OPENROUTER_PROVIDER_KEY,
  ProviderError,
  type ProviderAdapter,
  type ProviderGenerationCall,
  type ProviderModelDescriptor,
  type ProviderRuntime,
  type ProviderRuntimeStatus,
} from "../providers/index.js";
import { OWNER_ID } from "../auth/session.js";

/**
 * Deterministic provider adapter used by automated tests.
 *
 * Every model in this adapter is `:free` with confirmed zero pricing, mirroring
 * the Etapa 3A policy. Nothing here performs network I/O, so no real or paid
 * OpenRouter call can ever occur during tests.
 */
export const AssistantKeys = {
  yui: "00000000-0000-4000-8000-000000000001",
  alice: "00000000-0000-4000-8000-000000000002",
  schwi: "00000000-0000-4000-8000-000000000003",
} as const;

export const MOCK_FREE_MODEL_KEY = "nexus/mock-advisor:free";

function freeEligibility(
  verifiedAt: string,
  costStatus: "free_confirmed" | "paid" | "unknown" = "free_confirmed",
): FreeEligibility {
  if (costStatus === "paid") {
    return {
      eligible: false,
      costStatus: "paid",
      verifiedAt,
      requiresPreCallVerification: true,
      reason: "paid_model",
      pricingSummary: { promptPerToken: 0.000002, completionPerToken: 0.000008, requestFixed: null },
    };
  }
  if (costStatus === "unknown") {
    return {
      eligible: false,
      costStatus: "unknown",
      verifiedAt,
      requiresPreCallVerification: true,
      reason: "unverifiable_pricing",
      pricingSummary: { promptPerToken: null, completionPerToken: null, requestFixed: null },
    };
  }
  return {
    eligible: true,
    costStatus: "free_confirmed",
    verifiedAt,
    requiresPreCallVerification: true,
    reason: "verified_free",
    pricingSummary: { promptPerToken: 0, completionPerToken: 0, requestFixed: null },
  };
}

export interface MockProviderAdapterOptions {
  readonly modelKey?: string;
  readonly contextWindow?: number | null;
  readonly maxOutputTokens?: number | null;
  /**
   * Simulates a catalog entry that is not verified as free: `paid` reproduces a
   * non-zero price, `unknown` reproduces unverifiable pricing.
   */
  readonly costStatus?: "free_confirmed" | "paid" | "unknown";
  /**
   * Sobrescreve as capabilities do modelo simulado. Existe para o teste negativo da Fase 4:
   * provar que um modelo `:free` **sem** `code` é recusado para a VIVY em vez de ser usado em
   * silêncio. O padrão continua sendo o modelo completo.
   */
  readonly capabilities?: readonly ModelCapability[];
  /**
   * Modelos concorrentes, todos `:free` e disponíveis, para provar que a seleção **escolhe** por
   * capability em vez de pegar o único modelo disponível.
   *
   * Motivo de existir: com um modelo só, um teste positivo de "exigiu `code`" passa mesmo que a
   * exigência não seja aplicada — não há alternativa para a seleção pegar. Sabotar
   * `resolveModelCapabilitiesFor` comprovou exatamente isso: o teste de ponta a ponta continuava
   * verde. Um concorrente que ganha a ordenação automática (contexto maior) e **não** tem a
   * capability exigida transforma a exigência em algo observável.
   */
  readonly competitorModels?: readonly {
    readonly key: string;
    readonly capabilities: readonly ModelCapability[];
    readonly contextWindow?: number | null;
    readonly maxOutputTokens?: number | null;
  }[];
  /**
   * Handler invoked for every generate() call. Return a string for the
   * assistant text, or throw a ProviderError to simulate a failure.
   */
  readonly respond?: (input: {
    readonly call: ProviderGenerationCall;
    readonly invocation: number;
    readonly systemContent: string;
    readonly userContents: readonly string[];
  }) => string | Promise<string>;
}

export interface MockProviderAdapter extends ProviderAdapter {
  readonly calls: ProviderGenerationCall[];
  readonly models: readonly ProviderModelDescriptor[];
}

export function createMockProviderAdapter(
  options: MockProviderAdapterOptions = {},
): MockProviderAdapter {
  const modelKey = options.modelKey ?? MOCK_FREE_MODEL_KEY;
  const verifiedAt = "2026-11-05T00:00:00.000Z";
  const model: ProviderModelDescriptor = {
    id: deriveModelId(OPENROUTER_PROVIDER_ID, modelKey),
    providerId: OPENROUTER_PROVIDER_ID,
    providerKey: OPENROUTER_PROVIDER_KEY,
    key: modelKey,
    name: "Nexus Mock Advisor",
    availability: "available",
    capabilities: [
      ...(options.capabilities ?? [
        "chat",
        "system_prompt",
        "structured_output",
        "reasoning",
        "code",
      ]),
    ],
    supportedParameters: [
      "temperature",
      "topP",
      "maxOutputTokens",
      "stopSequences",
      "seed",
      "presencePenalty",
      "frequencyPenalty",
      "responseFormat",
    ],
    contextWindow: options.contextWindow === undefined ? 32_768 : options.contextWindow,
    maxOutputTokens: options.maxOutputTokens === undefined ? 4_096 : options.maxOutputTokens,
    freeEligibility: freeEligibility(verifiedAt, options.costStatus),
  };

  const calls: ProviderGenerationCall[] = [];
  let invocation = 0;

  const status: ProviderRuntimeStatus = {
    provider: {
      id: OPENROUTER_PROVIDER_ID,
      key: OPENROUTER_PROVIDER_KEY,
      name: "OpenRouter",
      kind: "cloud",
    },
    configured: true,
    availability: "available",
    costPolicy: "free_only",
    costStatus: "free_confirmed",
    capabilities: [...model.capabilities],
    supportedParameters: [...model.supportedParameters],
  };

  // Concorrentes: mesmo provedor, mesma elegibilidade `:free`, capabilities escolhidas pelo teste.
  const competitorDescriptors: ProviderModelDescriptor[] = (options.competitorModels ?? []).map(
    (competitor) => ({
      id: deriveModelId(OPENROUTER_PROVIDER_ID, competitor.key),
      providerId: OPENROUTER_PROVIDER_ID,
      providerKey: OPENROUTER_PROVIDER_KEY,
      key: competitor.key,
      name: `Nexus Mock Advisor (${competitor.key})`,
      availability: "available" as const,
      capabilities: [...competitor.capabilities],
      supportedParameters: [...model.supportedParameters],
      contextWindow:
        competitor.contextWindow === undefined ? model.contextWindow : competitor.contextWindow,
      maxOutputTokens:
        competitor.maxOutputTokens === undefined
          ? model.maxOutputTokens
          : competitor.maxOutputTokens,
      freeEligibility: freeEligibility(verifiedAt, options.costStatus),
    }),
  );
  const allModels: readonly ProviderModelDescriptor[] = [model, ...competitorDescriptors];

  const adapter: MockProviderAdapter = {
    id: OPENROUTER_PROVIDER_ID,
    key: OPENROUTER_PROVIDER_KEY,
    name: "OpenRouter",
    kind: "cloud",
    supportedCapabilities: model.capabilities,
    supportedParameters: model.supportedParameters,
    calls,
    models: allModels,
    isConfigured: () => true,
    getStatus: () => status,
    listModels: async () => [...allModels],
    verifyModelEligibility: async (requestedKey) => {
      const found = allModels.find((entry) => entry.key === requestedKey);
      if (!found) {
        throw new ProviderError(
          "MODEL_NOT_FOUND",
          `Model '${requestedKey}' was not found in provider 'openrouter'`,
          { providerKey: OPENROUTER_PROVIDER_KEY, details: { model: requestedKey } },
        );
      }
      return found;
    },
    generate: async (call) => {
      invocation += 1;
      calls.push({
        model: call.model,
        messages: call.messages.map((message) => ({ ...message })),
        ...(call.parameters ? { parameters: call.parameters } : {}),
        ...(call.requestId ? { requestId: call.requestId } : {}),
        ...(call.timeoutMs ? { timeoutMs: call.timeoutMs } : {}),
      });

      if (call.signal?.aborted) {
        throw new ProviderError("CANCELLED", "Provider call was aborted", {
          providerKey: OPENROUTER_PROVIDER_KEY,
        });
      }

      const systemContent =
        call.messages.find((message: GenerationMessage) => message.role === "system")?.content ?? "";
      const userContents = call.messages
        .filter((message: GenerationMessage) => message.role === "user")
        .map((message: GenerationMessage) => message.content);

      const content = options.respond
        ? await options.respond({ call, invocation, systemContent, userContents })
        : `Resposta simulada #${invocation}`;

      if (call.signal?.aborted) {
        throw new ProviderError("CANCELLED", "Provider call was aborted", {
          providerKey: OPENROUTER_PROVIDER_KEY,
        });
      }

      // O modelo efetivamente chamado pode ser um concorrente: reportar sempre o primário faria o
      // teste de seleção medir o rótulo errado.
      const active = allModels.find((entry) => entry.key === call.model) ?? model;

      return {
        id: `mock-completion-${invocation}`,
        providerId: OPENROUTER_PROVIDER_ID,
        providerKey: OPENROUTER_PROVIDER_KEY,
        modelId: active.id,
        modelKey: active.key,
        content,
        finishReason: "stop" as const,
        usage: {
          inputTokens: 12,
          outputTokens: 8,
          totalTokens: 20,
        },
        createdAt: new Date().toISOString(),
        freeEligibility: active.freeEligibility,
      } satisfies ModelGenerationResponse;
    },
    complete: async (call) => adapter.generate(call),
  };

  return adapter;
}

export function createMockProviderRuntime(
  adapter: ProviderAdapter = createMockProviderAdapter(),
): ProviderRuntime {
  const catalog = createProviderCatalogService({ adapters: [adapter], ttlMs: 0 });
  return {
    adapters: [adapter],
    catalog,
    selection: createModelSelectionService({ catalog }),
  };
}

export const MOCK_OWNER_ID = OWNER_ID;
