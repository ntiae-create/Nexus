import {
  createProviderCatalogService,
  DEFAULT_CATALOG_TTL_MS,
  type ProviderCatalogService,
} from "./catalog.js";
import {
  createOpenRouterAdapter,
  loadOpenRouterConfig,
  type OpenRouterEnv,
} from "./openrouter/adapter.js";
import {
  createModelSelectionService,
  type ModelSelectionService,
  type PersistedModelKeyResolver,
} from "./selection.js";
import { ProviderError, type ProviderAdapter } from "./types.js";

export * from "./ids.js";
export * from "./redaction.js";
export * from "./types.js";
export * from "./openrouter/pricing.js";
export * from "./openrouter/schemas.js";
export * from "./openrouter/adapter.js";
export * from "./catalog.js";
export * from "./selection.js";

export interface ProviderRuntimeEnv extends OpenRouterEnv {
  readonly OPENROUTER_CATALOG_TTL_MS?: string;
}

export interface ProviderRuntimeOptions {
  readonly env?: ProviderRuntimeEnv;
  readonly adapters?: readonly ProviderAdapter[];
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  readonly resolvePersistedModelKeys?: PersistedModelKeyResolver;
}

export interface ProviderRuntime {
  readonly adapters: readonly ProviderAdapter[];
  readonly catalog: ProviderCatalogService;
  readonly selection: ModelSelectionService;
}

export function createDefaultProviderRuntime(
  options: ProviderRuntimeOptions = {},
): ProviderRuntime {
  const env = options.env ?? process.env;
  let ttlMs = DEFAULT_CATALOG_TTL_MS;
  const rawTtl = env.OPENROUTER_CATALOG_TTL_MS?.trim();
  if (rawTtl) {
    const parsedTtl = Number(rawTtl);
    if (!Number.isInteger(parsedTtl) || parsedTtl < 0 || parsedTtl > 300_000) {
      throw new ProviderError(
        "NOT_CONFIGURED",
        "OPENROUTER_CATALOG_TTL_MS must be an integer between 0 and 300000",
        { providerKey: "openrouter" },
      );
    }
    ttlMs = parsedTtl;
  }

  const adapters =
    options.adapters ??
    (() => {
      const openRouterConfig = loadOpenRouterConfig(env);
      return [
        createOpenRouterAdapter({
          apiKey: openRouterConfig.apiKey,
          baseUrl: openRouterConfig.baseUrl,
          timeoutMs: openRouterConfig.timeoutMs,
          fetchFn: options.fetchFn,
          now: options.now,
        }),
      ];
    })();

  const catalog = createProviderCatalogService({
    adapters,
    ttlMs,
    now: options.now,
  });

  const selection = createModelSelectionService({
    catalog,
    resolvePersistedModelKeys: options.resolvePersistedModelKeys,
    now: options.now,
  });

  return {
    adapters,
    catalog,
    selection,
  };
}
