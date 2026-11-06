import {
  eligibleModelsResponseSchema,
  providersListResponseSchema,
  publicCapabilitiesResponseSchema,
  type EligibleModelsResponse,
  type ModelCapability,
  type ModelParameterName,
  type ProvidersListResponse,
  type PublicCapabilitiesResponse,
  type PublicEligibleModel,
  type PublicUnavailableModel,
} from "@nexus/shared";
import { OPENROUTER_FREE_SUFFIX } from "./openrouter/pricing.js";
import {
  ProviderError,
  type ProviderAdapter,
  type ProviderModelDescriptor,
} from "./types.js";

export const DEFAULT_CATALOG_TTL_MS = 60_000;

const PUBLIC_CAPABILITY_DESCRIPTIONS: ReadonlyArray<{
  readonly key: ModelCapability;
  readonly description: string;
}> = [
  {
    key: "chat",
    description: "Multi-turn text conversation generation",
  },
  {
    key: "system_prompt",
    description: "System-level instruction and persona conditioning",
  },
  {
    key: "streaming",
    description: "Incremental token streaming support",
  },
  {
    key: "structured_output",
    description: "Structured JSON output formatting",
  },
  {
    key: "reasoning",
    description: "Extended deliberative reasoning support",
  },
  {
    key: "vision",
    description: "Multimodal image input comprehension",
  },
  {
    key: "code",
    description: "Source code analysis and synthesis specialization",
  },
];

const PUBLIC_PARAMETER_DESCRIPTIONS: ReadonlyArray<{
  readonly key: ModelParameterName;
  readonly description: string;
}> = [
  {
    key: "temperature",
    description: "Sampling randomness control (0 to 2)",
  },
  {
    key: "topP",
    description: "Nucleus sampling probability mass (0 to 1]",
  },
  {
    key: "maxOutputTokens",
    description: "Upper bound on generated completion tokens",
  },
  {
    key: "stopSequences",
    description: "Custom stop string sequences",
  },
  {
    key: "seed",
    description: "Deterministic sampling seed when supported",
  },
  {
    key: "presencePenalty",
    description: "Penalty discouraging repeated topics (-2 to 2)",
  },
  {
    key: "frequencyPenalty",
    description: "Penalty discouraging repeated token frequency (-2 to 2)",
  },
  {
    key: "responseFormat",
    description: "Output format constraint (text or json_object)",
  },
];

export interface ProviderCatalogSnapshot {
  readonly adapter: ProviderAdapter;
  readonly eligibleModels: readonly ProviderModelDescriptor[];
  readonly unavailableFreeModels: readonly ProviderModelDescriptor[];
  readonly blockedPaidModels: readonly ProviderModelDescriptor[];
  readonly blockedUnverifiedModels: readonly ProviderModelDescriptor[];
  readonly allModels: readonly ProviderModelDescriptor[];
  readonly byId: ReadonlyMap<string, ProviderModelDescriptor>;
  readonly byKey: ReadonlyMap<string, ProviderModelDescriptor>;
  readonly fetchedAtMs: number;
  readonly expiresAtMs: number;
}

export interface ProviderCatalogServiceOptions {
  readonly adapters: readonly ProviderAdapter[];
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export interface ProviderCatalogService {
  readonly ttlMs: number;
  getAdapters(): readonly ProviderAdapter[];
  findAdapter(providerIdOrKey: string): ProviderAdapter | undefined;
  invalidate(providerIdOrKey?: string): void;
  getProviderSnapshot(
    providerIdOrKey: string,
    options?: { forceRefresh?: boolean; signal?: AbortSignal },
  ): Promise<ProviderCatalogSnapshot>;
  listProviders(options?: {
    forceRefresh?: boolean;
    signal?: AbortSignal;
  }): Promise<ProvidersListResponse>;
  listEligibleModels(options?: {
    provider?: string;
    capability?: ModelCapability;
    forceRefresh?: boolean;
    signal?: AbortSignal;
  }): Promise<EligibleModelsResponse>;
  getPublicCapabilities(): PublicCapabilitiesResponse;
  assertModelEligible(
    providerIdOrKey: string,
    modelIdOrKey: string,
    options?: {
      forceRefresh?: boolean;
      liveVerify?: boolean;
      requiredCapabilities?: readonly ModelCapability[];
      requiredParameters?: readonly ModelParameterName[];
      signal?: AbortSignal;
    },
  ): Promise<{
    readonly adapter: ProviderAdapter;
    readonly model: ProviderModelDescriptor;
  }>;
}

function toPublicEligibleModel(model: ProviderModelDescriptor): PublicEligibleModel {
  return {
    id: model.id,
    providerId: model.providerId,
    providerKey: model.providerKey,
    key: model.key,
    name: model.name,
    availability: "available",
    capabilities: [...model.capabilities],
    supportedParameters: [...model.supportedParameters],
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    freeEligibility: model.freeEligibility,
  };
}

function toPublicUnavailableModel(
  model: ProviderModelDescriptor,
): PublicUnavailableModel {
  return {
    id: model.id,
    providerId: model.providerId,
    providerKey: model.providerKey,
    key: model.key,
    name: model.name,
    availability: model.availability === "restricted" ? "restricted" : "unavailable",
    reason: model.freeEligibility.reason,
  };
}

export function createProviderCatalogService(
  options: ProviderCatalogServiceOptions,
): ProviderCatalogService {
  const ttlMs = options.ttlMs ?? DEFAULT_CATALOG_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < 0 || ttlMs > 300_000) {
    throw new Error("Catalog ttlMs must be an integer between 0 and 300000");
  }

  const now = options.now ?? Date.now;
  const adapters = [...options.adapters];
  const snapshots = new Map<string, ProviderCatalogSnapshot>();
  const inFlight = new Map<string, Promise<ProviderCatalogSnapshot>>();

  function findAdapter(providerIdOrKey: string): ProviderAdapter | undefined {
    const normalized = providerIdOrKey.trim().toLowerCase();
    return adapters.find(
      (adapter) =>
        adapter.key.toLowerCase() === normalized ||
        adapter.id.toLowerCase() === normalized,
    );
  }

  function invalidate(providerIdOrKey?: string): void {
    if (!providerIdOrKey) {
      snapshots.clear();
      return;
    }
    const adapter = findAdapter(providerIdOrKey);
    if (adapter) {
      snapshots.delete(adapter.key);
    }
  }

  async function buildSnapshot(
    adapter: ProviderAdapter,
    signal?: AbortSignal,
  ): Promise<ProviderCatalogSnapshot> {
    if (!adapter.isConfigured()) {
      throw new ProviderError(
        "NOT_CONFIGURED",
        `Provider '${adapter.key}' is not configured`,
        { providerKey: adapter.key },
      );
    }

    const models = await adapter.listModels({ signal });
    const fetchedAtMs = now();
    const expiresAtMs = fetchedAtMs + ttlMs;

    const eligibleModels: ProviderModelDescriptor[] = [];
    const unavailableFreeModels: ProviderModelDescriptor[] = [];
    const blockedPaidModels: ProviderModelDescriptor[] = [];
    const blockedUnverifiedModels: ProviderModelDescriptor[] = [];
    const byId = new Map<string, ProviderModelDescriptor>();
    const byKey = new Map<string, ProviderModelDescriptor>();

    for (const model of models) {
      byId.set(model.id.toLowerCase(), model);
      byKey.set(model.key, model);

      if (
        model.freeEligibility.eligible &&
        model.freeEligibility.costStatus === "free_confirmed" &&
        model.availability === "available"
      ) {
        eligibleModels.push(model);
      } else if (model.freeEligibility.costStatus === "paid") {
        blockedPaidModels.push(model);
      } else if (
        model.freeEligibility.costStatus === "free_confirmed" &&
        model.availability !== "available"
      ) {
        unavailableFreeModels.push(model);
      } else {
        blockedUnverifiedModels.push(model);
      }
    }

    eligibleModels.sort((a, b) => a.key.localeCompare(b.key));
    unavailableFreeModels.sort((a, b) => a.key.localeCompare(b.key));

    return {
      adapter,
      eligibleModels,
      unavailableFreeModels,
      blockedPaidModels,
      blockedUnverifiedModels,
      allModels: models,
      byId,
      byKey,
      fetchedAtMs,
      expiresAtMs,
    };
  }

  async function getProviderSnapshot(
    providerIdOrKey: string,
    callOptions: { forceRefresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<ProviderCatalogSnapshot> {
    const adapter = findAdapter(providerIdOrKey);
    if (!adapter) {
      throw new ProviderError(
        "INVALID_SELECTION",
        `Provider '${providerIdOrKey}' is not registered`,
        { providerKey: providerIdOrKey },
      );
    }

    const currentTime = now();
    const cached = snapshots.get(adapter.key);

    // Explicit freshness policy: only return cache when strictly unexpired and
    // forceRefresh was not requested. Never fall back to expired cache on error.
    if (!callOptions.forceRefresh && ttlMs > 0 && cached && currentTime < cached.expiresAtMs) {
      return cached;
    }

    snapshots.delete(adapter.key);

    const existingPromise = !callOptions.signal
      ? inFlight.get(adapter.key)
      : undefined;
    if (existingPromise) {
      return existingPromise;
    }

    const refreshPromise = buildSnapshot(adapter, callOptions.signal).then(
      (snapshot) => {
        if (ttlMs > 0) {
          snapshots.set(adapter.key, snapshot);
        }
        inFlight.delete(adapter.key);
        return snapshot;
      },
      (err) => {
        inFlight.delete(adapter.key);
        snapshots.delete(adapter.key);
        throw err;
      },
    );

    if (!callOptions.signal) {
      inFlight.set(adapter.key, refreshPromise);
    }

    return refreshPromise;
  }

  async function listProviders(
    callOptions: { forceRefresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<ProvidersListResponse> {
    const summaries = await Promise.all(
      adapters.map(async (adapter) => {
        const status = adapter.getStatus();
        if (!status.configured) {
          return {
            id: adapter.id,
            key: adapter.key,
            name: adapter.name,
            kind: adapter.kind,
            configured: false,
            availability: "unavailable" as const,
            costPolicy: "free_only" as const,
            costStatus: "unknown" as const,
            capabilities: [...status.capabilities],
            supportedParameters: [...status.supportedParameters],
            eligibleModelCount: 0,
            unavailableReason: status.unavailableReason ?? "provider_not_configured",
          };
        }

        try {
          const snapshot = await getProviderSnapshot(adapter.key, callOptions);
          const hasEligible = snapshot.eligibleModels.length > 0;
          return {
            id: adapter.id,
            key: adapter.key,
            name: adapter.name,
            kind: adapter.kind,
            configured: true,
            availability: hasEligible
              ? ("available" as const)
              : ("unavailable" as const),
            costPolicy: "free_only" as const,
            costStatus: "free_confirmed" as const,
            capabilities: [...status.capabilities],
            supportedParameters: [...status.supportedParameters],
            eligibleModelCount: snapshot.eligibleModels.length,
            ...(!hasEligible ? { unavailableReason: "no_eligible_free_models" } : {}),
            verifiedAt: new Date(snapshot.fetchedAtMs).toISOString(),
          };
        } catch (err) {
          const code =
            err instanceof ProviderError ? err.code.toLowerCase() : "provider_unavailable";
          return {
            id: adapter.id,
            key: adapter.key,
            name: adapter.name,
            kind: adapter.kind,
            configured: true,
            availability: "unavailable" as const,
            costPolicy: "free_only" as const,
            costStatus: "unknown" as const,
            capabilities: [...status.capabilities],
            supportedParameters: [...status.supportedParameters],
            eligibleModelCount: 0,
            unavailableReason: code,
          };
        }
      }),
    );

    return providersListResponseSchema.parse({
      providers: summaries,
      generatedAt: new Date(now()).toISOString(),
    });
  }

  async function listEligibleModels(
    callOptions: {
      provider?: string;
      capability?: ModelCapability;
      forceRefresh?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<EligibleModelsResponse> {
    let targetAdapters: ProviderAdapter[];

    if (callOptions.provider) {
      const target = findAdapter(callOptions.provider);
      if (!target) {
        throw new ProviderError(
          "INVALID_SELECTION",
          `Provider '${callOptions.provider}' is not registered`,
          { providerKey: callOptions.provider },
        );
      }
      if (!target.isConfigured()) {
        throw new ProviderError(
          "NOT_CONFIGURED",
          `Provider '${target.key}' is not configured`,
          { providerKey: target.key },
        );
      }
      targetAdapters = [target];
    } else {
      targetAdapters = adapters.filter((adapter) => adapter.isConfigured());
      if (targetAdapters.length === 0) {
        const primaryKey = adapters[0]?.key ?? "openrouter";
        throw new ProviderError(
          "NOT_CONFIGURED",
          "No model provider is currently configured",
          { providerKey: primaryKey },
        );
      }
    }

    const resolvedSnapshots = await Promise.all(
      targetAdapters.map((adapter) =>
        getProviderSnapshot(adapter.key, {
          forceRefresh: callOptions.forceRefresh,
          signal: callOptions.signal,
        }),
      ),
    );

    const eligibleModels: PublicEligibleModel[] = [];
    const unavailableModels: PublicUnavailableModel[] = [];
    let totalEvaluated = 0;
    let blockedPaidCount = 0;
    let blockedUnverifiedCount = 0;
    let earliestFetchedAt = Number.POSITIVE_INFINITY;
    let earliestExpiresAt = Number.POSITIVE_INFINITY;

    for (const snapshot of resolvedSnapshots) {
      totalEvaluated += snapshot.allModels.length;
      blockedPaidCount += snapshot.blockedPaidModels.length;
      blockedUnverifiedCount += snapshot.blockedUnverifiedModels.length;
      earliestFetchedAt = Math.min(earliestFetchedAt, snapshot.fetchedAtMs);
      earliestExpiresAt = Math.min(earliestExpiresAt, snapshot.expiresAtMs);

      for (const model of snapshot.eligibleModels) {
        if (
          callOptions.capability &&
          !model.capabilities.includes(callOptions.capability)
        ) {
          continue;
        }
        eligibleModels.push(toPublicEligibleModel(model));
      }

      for (const model of snapshot.unavailableFreeModels) {
        if (
          callOptions.capability &&
          !model.capabilities.includes(callOptions.capability)
        ) {
          continue;
        }
        unavailableModels.push(toPublicUnavailableModel(model));
      }
    }

    const fallbackTimestamp = now();
    return eligibleModelsResponseSchema.parse({
      models: eligibleModels,
      unavailableModels,
      summary: {
        totalEvaluated,
        eligibleCount: eligibleModels.length,
        unavailableFreeCount: unavailableModels.length,
        blockedPaidCount,
        blockedUnverifiedCount,
      },
      fetchedAt: new Date(
        Number.isFinite(earliestFetchedAt) ? earliestFetchedAt : fallbackTimestamp,
      ).toISOString(),
      expiresAt: new Date(
        Number.isFinite(earliestExpiresAt) ? earliestExpiresAt : fallbackTimestamp,
      ).toISOString(),
    });
  }

  function getPublicCapabilities(): PublicCapabilitiesResponse {
    return publicCapabilitiesResponseSchema.parse({
      policy: {
        costMode: "free_only",
        paidModelsAllowed: false,
        paidFallbackAllowed: false,
        preCallPriceVerificationRequired: true,
        openRouterFreeSuffix: OPENROUTER_FREE_SUFFIX,
      },
      capabilities: PUBLIC_CAPABILITY_DESCRIPTIONS.map((item) => ({ ...item })),
      parameters: PUBLIC_PARAMETER_DESCRIPTIONS.map((item) => ({ ...item })),
      selectionScopes: ["conversation", "assistant", "global"],
      selectionModes: ["manual", "automatic"],
      providers: adapters.map((adapter) => {
        const status = adapter.getStatus();
        return {
          id: adapter.id,
          key: adapter.key,
          name: adapter.name,
          kind: adapter.kind,
          configured: status.configured,
          availability: status.availability,
          capabilities: [...status.capabilities],
          supportedParameters: [...status.supportedParameters],
        };
      }),
      generatedAt: new Date(now()).toISOString(),
    });
  }

  async function assertModelEligible(
    providerIdOrKey: string,
    modelIdOrKey: string,
    callOptions: {
      forceRefresh?: boolean;
      liveVerify?: boolean;
      requiredCapabilities?: readonly ModelCapability[];
      requiredParameters?: readonly ModelParameterName[];
      signal?: AbortSignal;
    } = {},
  ): Promise<{
    readonly adapter: ProviderAdapter;
    readonly model: ProviderModelDescriptor;
  }> {
    const adapter = findAdapter(providerIdOrKey);
    if (!adapter) {
      throw new ProviderError(
        "INVALID_SELECTION",
        `Provider '${providerIdOrKey}' does not exist in the catalog`,
        { providerKey: providerIdOrKey },
      );
    }

    if (!adapter.isConfigured()) {
      throw new ProviderError(
        "NOT_CONFIGURED",
        `Provider '${adapter.key}' is not configured`,
        { providerKey: adapter.key },
      );
    }

    const snapshot = await getProviderSnapshot(adapter.key, {
      forceRefresh: callOptions.forceRefresh || callOptions.liveVerify,
      signal: callOptions.signal,
    });

    const trimmedTarget = modelIdOrKey.trim();
    const candidate =
      snapshot.byId.get(trimmedTarget.toLowerCase()) ??
      snapshot.byKey.get(trimmedTarget);

    if (!candidate) {
      throw new ProviderError(
        "MODEL_NOT_FOUND",
        `Model '${trimmedTarget}' was not found in provider '${adapter.key}'`,
        {
          providerKey: adapter.key,
          details: { model: trimmedTarget },
        },
      );
    }

    if (
      candidate.freeEligibility.costStatus === "paid" ||
      candidate.freeEligibility.reason === "missing_free_suffix"
    ) {
      throw new ProviderError(
        "PAID_MODEL_BLOCKED",
        `Model '${candidate.key}' is blocked by the free-only policy`,
        {
          providerKey: adapter.key,
          details: {
            model: candidate.key,
            reason: candidate.freeEligibility.reason,
          },
        },
      );
    }

    if (candidate.freeEligibility.costStatus === "unknown") {
      throw new ProviderError(
        "UNVERIFIED_PRICING_BLOCKED",
        `Model '${candidate.key}' lacks verifiable zero-cost pricing and is blocked`,
        {
          providerKey: adapter.key,
          details: {
            model: candidate.key,
            reason: candidate.freeEligibility.reason,
          },
        },
      );
    }

    if (candidate.availability !== "available" || !candidate.freeEligibility.eligible) {
      throw new ProviderError(
        "MODEL_UNAVAILABLE",
        `Free model '${candidate.key}' is currently unavailable`,
        {
          providerKey: adapter.key,
          details: {
            model: candidate.key,
            reason: candidate.freeEligibility.reason,
          },
        },
      );
    }

    if (callOptions.requiredCapabilities?.length) {
      const missingCaps = callOptions.requiredCapabilities.filter(
        (cap) => !candidate.capabilities.includes(cap),
      );
      if (missingCaps.length > 0) {
        throw new ProviderError(
          "INVALID_SELECTION",
          `Model '${candidate.key}' does not support required capabilities: ${missingCaps.join(", ")}`,
          {
            providerKey: adapter.key,
            details: {
              model: candidate.key,
              missingCapabilities: missingCaps,
            },
          },
        );
      }
    }

    if (callOptions.requiredParameters?.length) {
      const missingParams = callOptions.requiredParameters.filter(
        (param) => !candidate.supportedParameters.includes(param),
      );
      if (missingParams.length > 0) {
        throw new ProviderError(
          "INCOMPATIBLE_PARAMETERS",
          `Model '${candidate.key}' does not support required parameters: ${missingParams.join(", ")}`,
          {
            providerKey: adapter.key,
            details: {
              model: candidate.key,
              unsupportedParameters: missingParams,
            },
          },
        );
      }
    }

    return { adapter, model: candidate };
  }

  return {
    ttlMs,
    getAdapters: () => [...adapters],
    findAdapter,
    invalidate,
    getProviderSnapshot,
    listProviders,
    listEligibleModels,
    getPublicCapabilities,
    assertModelEligible,
  };
}
