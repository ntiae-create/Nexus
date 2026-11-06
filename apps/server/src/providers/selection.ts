import {
  effectiveModelSelectionResponseSchema,
  resolveProviderSelectionWithScope,
  type EffectiveModelSelectionResponse,
  type ModelCapability,
  type ModelParameterName,
  type ProviderPreferenceSet,
  type ProviderSelection,
  type SelectionScope,
} from "@nexus/shared";
import { OWNER_ID } from "../auth/session.js";
import type { ProviderCatalogService } from "./catalog.js";
import {
  ProviderError,
  type ProviderAdapter,
  type ProviderModelDescriptor,
} from "./types.js";

export const DEFAULT_PROVIDER_PREFERENCE_SET: ProviderPreferenceSet = {
  global: {
    id: OWNER_ID,
    userId: OWNER_ID,
    selection: { mode: "automatic" },
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
  byAssistant: [],
  byConversation: [],
};

export interface PersistedModelKeyMapping {
  readonly providerKey: string;
  readonly modelKey: string;
}

export type PersistedModelKeyResolver = (ref: {
  readonly providerId: string;
  readonly modelId: string;
}) => Promise<PersistedModelKeyMapping | undefined>;

export interface ModelSelectionContext {
  readonly assistantId?: string;
  readonly conversationId?: string;
  readonly requiredCapabilities?: readonly ModelCapability[];
  readonly requiredParameters?: readonly ModelParameterName[];
  readonly forceRefresh?: boolean;
  readonly liveVerify?: boolean;
  readonly signal?: AbortSignal;
}

export interface ResolvedModelExecutionTarget {
  readonly resolvedScope: SelectionScope;
  readonly preference: ProviderSelection;
  readonly adapter: ProviderAdapter;
  readonly model: ProviderModelDescriptor;
  readonly response: EffectiveModelSelectionResponse;
}

export interface ModelSelectionServiceOptions {
  readonly catalog: ProviderCatalogService;
  readonly resolvePersistedModelKeys?: PersistedModelKeyResolver;
  readonly now?: () => number;
}

export interface ModelSelectionService {
  resolveEffectiveSelection(
    preferences: ProviderPreferenceSet,
    context?: ModelSelectionContext,
  ): Promise<ResolvedModelExecutionTarget>;
}

function compareAutomaticCandidates(
  left: { adapter: ProviderAdapter; model: ProviderModelDescriptor },
  right: { adapter: ProviderAdapter; model: ProviderModelDescriptor },
): number {
  const leftSystemPrompt = left.model.capabilities.includes("system_prompt") ? 1 : 0;
  const rightSystemPrompt = right.model.capabilities.includes("system_prompt") ? 1 : 0;
  if (leftSystemPrompt !== rightSystemPrompt) {
    return rightSystemPrompt - leftSystemPrompt;
  }

  const leftContext = left.model.contextWindow ?? 0;
  const rightContext = right.model.contextWindow ?? 0;
  if (leftContext !== rightContext) {
    return rightContext - leftContext;
  }

  const leftMaxOutput = left.model.maxOutputTokens ?? 0;
  const rightMaxOutput = right.model.maxOutputTokens ?? 0;
  if (leftMaxOutput !== rightMaxOutput) {
    return rightMaxOutput - leftMaxOutput;
  }

  const providerCompare = left.adapter.key.localeCompare(right.adapter.key);
  if (providerCompare !== 0) {
    return providerCompare;
  }

  return left.model.key.localeCompare(right.model.key);
}

export function createModelSelectionService(
  options: ModelSelectionServiceOptions,
): ModelSelectionService {
  const { catalog, resolvePersistedModelKeys } = options;
  const now = options.now ?? Date.now;

  async function resolveManualTarget(
    selection: Extract<ProviderSelection, { mode: "manual" }>,
    context: ModelSelectionContext,
    requiredCapabilities: readonly ModelCapability[],
    requiredParameters: readonly ModelParameterName[],
  ): Promise<{ adapter: ProviderAdapter; model: ProviderModelDescriptor }> {
    let targetProviderRef = selection.providerId;
    let targetModelRef = selection.modelId;

    // Support both deterministic catalog UUIDs and custom UUIDs stored in nexus.models.
    if (!catalog.findAdapter(targetProviderRef) && resolvePersistedModelKeys) {
      const mapped = await resolvePersistedModelKeys({
        providerId: selection.providerId,
        modelId: selection.modelId,
      });
      if (mapped) {
        targetProviderRef = mapped.providerKey;
        targetModelRef = mapped.modelKey;
      }
    } else if (resolvePersistedModelKeys) {
      const adapter = catalog.findAdapter(targetProviderRef);
      if (adapter && adapter.isConfigured()) {
        const snapshot = await catalog.getProviderSnapshot(adapter.key, {
          forceRefresh: context.forceRefresh || context.liveVerify,
          signal: context.signal,
        });
        if (!snapshot.byId.has(selection.modelId.toLowerCase())) {
          const mapped = await resolvePersistedModelKeys({
            providerId: selection.providerId,
            modelId: selection.modelId,
          });
          if (mapped) {
            targetProviderRef = mapped.providerKey;
            targetModelRef = mapped.modelKey;
          }
        }
      }
    }

    try {
      return await catalog.assertModelEligible(targetProviderRef, targetModelRef, {
        forceRefresh: context.forceRefresh,
        liveVerify: context.liveVerify,
        requiredCapabilities,
        requiredParameters,
        signal: context.signal,
      });
    } catch (err) {
      // Normalize missing-model manual preferences into explicit INVALID_SELECTION
      // while preserving PAID_MODEL_BLOCKED, UNVERIFIED_PRICING_BLOCKED,
      // MODEL_UNAVAILABLE, NOT_CONFIGURED, TIMEOUT, RATE_LIMITED, etc.
      if (err instanceof ProviderError && err.code === "MODEL_NOT_FOUND") {
        throw new ProviderError(
          "INVALID_SELECTION",
          `Manual preference references unknown model '${targetModelRef}' on provider '${err.providerKey}'`,
          {
            providerKey: err.providerKey,
            details: {
              providerId: selection.providerId,
              modelId: selection.modelId,
            },
          },
        );
      }
      throw err;
    }
  }

  async function resolveAutomaticTarget(
    context: ModelSelectionContext,
    requiredCapabilities: readonly ModelCapability[],
    requiredParameters: readonly ModelParameterName[],
  ): Promise<{ adapter: ProviderAdapter; model: ProviderModelDescriptor }> {
    const configuredAdapters = catalog
      .getAdapters()
      .filter((adapter) => adapter.isConfigured());

    if (configuredAdapters.length === 0) {
      const primaryKey = catalog.getAdapters()[0]?.key ?? "openrouter";
      throw new ProviderError(
        "NOT_CONFIGURED",
        "Automatic model selection failed because no model provider is configured",
        { providerKey: primaryKey },
      );
    }

    const snapshots = await Promise.all(
      configuredAdapters.map((adapter) =>
        catalog.getProviderSnapshot(adapter.key, {
          forceRefresh: context.forceRefresh || context.liveVerify,
          signal: context.signal,
        }),
      ),
    );

    const candidates: Array<{
      adapter: ProviderAdapter;
      model: ProviderModelDescriptor;
    }> = [];

    for (const snapshot of snapshots) {
      // Strictly inspect ONLY verified-free, available models; paid and unverified
      // models are never considered or used as fallback under any condition.
      for (const model of snapshot.eligibleModels) {
        if (
          !model.freeEligibility.eligible ||
          model.freeEligibility.costStatus !== "free_confirmed" ||
          model.availability !== "available"
        ) {
          continue;
        }

        const supportsCapabilities = requiredCapabilities.every((cap) =>
          model.capabilities.includes(cap),
        );
        if (!supportsCapabilities) {
          continue;
        }

        const supportsParameters = requiredParameters.every((param) =>
          model.supportedParameters.includes(param),
        );
        if (!supportsParameters) {
          continue;
        }

        candidates.push({ adapter: snapshot.adapter, model });
      }
    }

    if (candidates.length === 0) {
      const primaryKey = configuredAdapters[0]!.key;
      throw new ProviderError(
        "MODEL_UNAVAILABLE",
        "No eligible free and compatible model is currently available (paid fallback is disabled by policy)",
        {
          providerKey: primaryKey,
          details: {
            requiredCapabilities,
            requiredParameters,
            paidFallbackAllowed: false,
          },
        },
      );
    }

    candidates.sort(compareAutomaticCandidates);
    return candidates[0]!;
  }

  async function resolveEffectiveSelection(
    preferences: ProviderPreferenceSet,
    context: ModelSelectionContext = {},
  ): Promise<ResolvedModelExecutionTarget> {
    const requiredCapabilities: readonly ModelCapability[] =
      context.requiredCapabilities && context.requiredCapabilities.length > 0
        ? context.requiredCapabilities
        : ["chat"];
    const requiredParameters: readonly ModelParameterName[] =
      context.requiredParameters ?? [];

    // Reuse canonical precedence from @nexus/shared: conversation -> assistant -> global.
    const { scope, selection } = resolveProviderSelectionWithScope(preferences, {
      assistantId: context.assistantId,
      conversationId: context.conversationId,
    });

    const chosen =
      selection.mode === "manual"
        ? await resolveManualTarget(
            selection,
            context,
            requiredCapabilities,
            requiredParameters,
          )
        : await resolveAutomaticTarget(
            context,
            requiredCapabilities,
            requiredParameters,
          );

    const response = effectiveModelSelectionResponseSchema.parse({
      resolvedScope: scope,
      preference: selection,
      context: {
        ...(context.assistantId ? { assistantId: context.assistantId } : {}),
        ...(context.conversationId ? { conversationId: context.conversationId } : {}),
      },
      selectedProvider: {
        id: chosen.adapter.id,
        key: chosen.adapter.key,
        name: chosen.adapter.name,
        kind: chosen.adapter.kind,
      },
      selectedModel: {
        id: chosen.model.id,
        providerId: chosen.model.providerId,
        providerKey: chosen.model.providerKey,
        key: chosen.model.key,
        name: chosen.model.name,
        availability: "available",
        capabilities: [...chosen.model.capabilities],
        supportedParameters: [...chosen.model.supportedParameters],
        contextWindow: chosen.model.contextWindow,
        maxOutputTokens: chosen.model.maxOutputTokens,
        freeEligibility: chosen.model.freeEligibility,
      },
      policy: {
        freeVerified: true,
        paidFallbackUsed: false,
      },
      evaluatedAt: new Date(now()).toISOString(),
    });

    return {
      resolvedScope: scope,
      preference: selection,
      adapter: chosen.adapter,
      model: chosen.model,
      response,
    };
  }

  return {
    resolveEffectiveSelection,
  };
}
