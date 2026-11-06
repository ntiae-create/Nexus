import type {
  FreeEligibility,
  ModelCapability,
  ModelParameterName,
  ProviderAvailability,
} from "@nexus/shared";
import { deriveModelId, OPENROUTER_PROVIDER_ID, OPENROUTER_PROVIDER_KEY } from "../ids.js";
import type { ProviderModelDescriptor } from "../types.js";
import type { OpenRouterRawModel } from "./schemas.js";

export const OPENROUTER_FREE_SUFFIX = ":free" as const;

const DECIMAL_NUMBER_PATTERN = /^\d+(\.\d+)?([eE][+-]?\d+)?$/;

export function isOpenRouterFreeModelKey(modelKey: string): boolean {
  const trimmed = modelKey.trim();
  if (trimmed.length <= OPENROUTER_FREE_SUFFIX.length) {
    return false;
  }
  if (/\s/.test(trimmed)) {
    return false;
  }
  if (!trimmed.endsWith(OPENROUTER_FREE_SUFFIX)) {
    return false;
  }
  const baseSlug = trimmed.slice(0, -OPENROUTER_FREE_SUFFIX.length);
  return baseSlug.length > 0 && !baseSlug.endsWith(":");
}

export function stripOpenRouterFreeSuffix(modelKey: string): string {
  const trimmed = modelKey.trim();
  return trimmed.endsWith(OPENROUTER_FREE_SUFFIX)
    ? trimmed.slice(0, -OPENROUTER_FREE_SUFFIX.length)
    : trimmed;
}

export function parseNonNegativePrice(
  raw: unknown,
): { readonly valid: true; readonly value: number } | { readonly valid: false } {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) {
      return { valid: false };
    }
    return { valid: true, value: raw === 0 ? 0 : raw };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed || !DECIMAL_NUMBER_PATTERN.test(trimmed)) {
      return { valid: false };
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { valid: false };
    }
    return { valid: true, value: parsed === 0 ? 0 : parsed };
  }
  return { valid: false };
}

export type OpenRouterPricingVerification =
  | {
      readonly status: "zero_confirmed";
      readonly promptPerToken: 0;
      readonly completionPerToken: 0;
      readonly requestFixed: 0;
    }
  | {
      readonly status: "paid";
      readonly promptPerToken: number | null;
      readonly completionPerToken: number | null;
      readonly requestFixed: number | null;
    }
  | {
      readonly status: "unverifiable";
      readonly promptPerToken: number | null;
      readonly completionPerToken: number | null;
      readonly requestFixed: number | null;
    };

/**
 * Verifies OpenRouter pricing fail-closed:
 * - Both `prompt` and `completion` MUST be present and strictly equal to 0.
 * - Absent additional pricing dimensions (keys not present in `pricing`) are ignored.
 * - Every additional dimension present in `pricing` (`request`, `image`,
 *   `web_search`, `internal_reasoning`, cache fees, etc.) MUST be finite,
 *   numeric, and strictly equal to 0.
 * - Any present dimension with `null`, invalid string, non-numeric value,
 *   NaN/Infinity, or negative value (e.g. "-1" dynamic pricing) classifies the
 *   model as `unverifiable` and blocks eligibility.
 * - Any positive price (> 0) immediately classifies the model as `paid`.
 */
export function verifyOpenRouterPricing(
  pricing: Record<string, unknown> | null | undefined,
): OpenRouterPricingVerification {
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) {
    return {
      status: "unverifiable",
      promptPerToken: null,
      completionPerToken: null,
      requestFixed: null,
    };
  }

  const hasPrompt =
    Object.prototype.hasOwnProperty.call(pricing, "prompt") &&
    pricing.prompt !== undefined;
  const hasCompletion =
    Object.prototype.hasOwnProperty.call(pricing, "completion") &&
    pricing.completion !== undefined;
  const hasRequest =
    Object.prototype.hasOwnProperty.call(pricing, "request") &&
    pricing.request !== undefined;

  const promptParsed = hasPrompt
    ? parseNonNegativePrice(pricing.prompt)
    : ({ valid: false } as const);
  const completionParsed = hasCompletion
    ? parseNonNegativePrice(pricing.completion)
    : ({ valid: false } as const);
  const requestParsed = hasRequest
    ? parseNonNegativePrice(pricing.request)
    : undefined;

  const promptSummary = promptParsed.valid ? promptParsed.value : null;
  const completionSummary = completionParsed.valid ? completionParsed.value : null;
  const requestSummary =
    requestParsed === undefined
      ? null
      : requestParsed.valid
        ? requestParsed.value
        : null;

  let sawUnparseable = false;

  for (const [, rawValue] of Object.entries(pricing)) {
    const parsed = parseNonNegativePrice(rawValue);
    if (!parsed.valid) {
      sawUnparseable = true;
      continue;
    }
    if (parsed.value > 0) {
      return {
        status: "paid",
        promptPerToken: promptSummary,
        completionPerToken: completionSummary,
        requestFixed: requestSummary,
      };
    }
  }

  if (
    !promptParsed.valid ||
    !completionParsed.valid ||
    sawUnparseable ||
    promptParsed.value !== 0 ||
    completionParsed.value !== 0
  ) {
    return {
      status: "unverifiable",
      promptPerToken: promptSummary,
      completionPerToken: completionSummary,
      requestFixed: requestSummary,
    };
  }

  return {
    status: "zero_confirmed",
    promptPerToken: 0,
    completionPerToken: 0,
    requestFixed: 0,
  };
}

function isRawModelUnavailable(raw: OpenRouterRawModel, nowMs: number): boolean {
  if (raw.unavailable === true || raw.disabled === true) {
    return true;
  }
  if (typeof raw.status === "string") {
    const normalizedStatus = raw.status.trim().toLowerCase();
    if (
      normalizedStatus === "unavailable" ||
      normalizedStatus === "disabled" ||
      normalizedStatus === "offline" ||
      normalizedStatus === "deprecated"
    ) {
      return true;
    }
  }
  if (typeof raw.context_length === "number" && raw.context_length <= 0) {
    return true;
  }
  if (
    typeof raw.top_provider?.context_length === "number" &&
    raw.top_provider.context_length <= 0
  ) {
    return true;
  }
  if (typeof raw.expiration_date === "string" && raw.expiration_date.trim().length > 0) {
    const expMs = Date.parse(raw.expiration_date);
    if (!Number.isNaN(expMs) && expMs <= nowMs) {
      return true;
    }
  }
  return false;
}

export function extractOpenRouterCapabilities(
  raw: OpenRouterRawModel,
): readonly ModelCapability[] {
  const capabilities = new Set<ModelCapability>();
  const outputModalities = raw.architecture?.output_modalities ?? undefined;
  const supportsTextOutput =
    !outputModalities ||
    outputModalities.length === 0 ||
    outputModalities.some((item) => item.toLowerCase() === "text");

  if (supportsTextOutput) {
    capabilities.add("chat");
    capabilities.add("system_prompt");
    capabilities.add("streaming");
  }

  const supportedParams = new Set(
    (raw.supported_parameters ?? []).map((item) => item.toLowerCase()),
  );
  if (
    supportedParams.has("response_format") ||
    supportedParams.has("structured_outputs")
  ) {
    capabilities.add("structured_output");
  }
  if (
    supportedParams.has("reasoning") ||
    supportedParams.has("include_reasoning")
  ) {
    capabilities.add("reasoning");
  }

  const inputModalities = (raw.architecture?.input_modalities ?? []).map((item) =>
    item.toLowerCase(),
  );
  const modalityLabel = raw.architecture?.modality?.toLowerCase() ?? "";
  if (inputModalities.includes("image") || modalityLabel.includes("image")) {
    capabilities.add("vision");
  }

  const identityText = `${raw.id} ${raw.name ?? ""}`;
  if (/\bcode(r|stral)?\b/i.test(identityText)) {
    capabilities.add("code");
  }

  return Array.from(capabilities);
}

const DEFAULT_CHAT_PARAMETERS: readonly ModelParameterName[] = [
  "temperature",
  "topP",
  "maxOutputTokens",
  "stopSequences",
];

export function extractOpenRouterParameters(
  raw: OpenRouterRawModel,
): readonly ModelParameterName[] {
  if (!raw.supported_parameters) {
    return DEFAULT_CHAT_PARAMETERS;
  }

  const parameters = new Set<ModelParameterName>();
  for (const param of raw.supported_parameters) {
    switch (param.toLowerCase()) {
      case "temperature":
        parameters.add("temperature");
        break;
      case "top_p":
        parameters.add("topP");
        break;
      case "max_tokens":
      case "max_completion_tokens":
        parameters.add("maxOutputTokens");
        break;
      case "stop":
        parameters.add("stopSequences");
        break;
      case "seed":
        parameters.add("seed");
        break;
      case "presence_penalty":
        parameters.add("presencePenalty");
        break;
      case "frequency_penalty":
        parameters.add("frequencyPenalty");
        break;
      case "response_format":
      case "structured_outputs":
        parameters.add("responseFormat");
        break;
      default:
        break;
    }
  }

  return Array.from(parameters);
}

export function evaluateOpenRouterModel(
  raw: OpenRouterRawModel,
  options: { providerId?: string; nowMs?: number } = {},
): ProviderModelDescriptor {
  const providerId = options.providerId ?? OPENROUTER_PROVIDER_ID;
  const nowMs = options.nowMs ?? Date.now();
  const verifiedAt = new Date(nowMs).toISOString();
  const key = raw.id.trim();
  const name = raw.name?.trim() || key;

  const hasFreeSuffix = isOpenRouterFreeModelKey(key);
  const pricingVerification = verifyOpenRouterPricing(raw.pricing);
  const unavailable = isRawModelUnavailable(raw, nowMs);

  let availability: ProviderAvailability;
  let freeEligibility: FreeEligibility;

  if (!hasFreeSuffix) {
    availability = unavailable ? "unavailable" : "restricted";
    freeEligibility =
      pricingVerification.status === "paid"
        ? {
            eligible: false,
            costStatus: "paid",
            verifiedAt,
            requiresPreCallVerification: true,
            reason: "paid_model",
            pricingSummary: {
              promptPerToken: pricingVerification.promptPerToken,
              completionPerToken: pricingVerification.completionPerToken,
              requestFixed: pricingVerification.requestFixed,
            },
          }
        : {
            eligible: false,
            costStatus: "unknown",
            verifiedAt,
            requiresPreCallVerification: true,
            reason: "missing_free_suffix",
            pricingSummary: {
              promptPerToken: pricingVerification.promptPerToken,
              completionPerToken: pricingVerification.completionPerToken,
              requestFixed: pricingVerification.requestFixed,
            },
          };
  } else if (pricingVerification.status === "paid") {
    availability = "restricted";
    freeEligibility = {
      eligible: false,
      costStatus: "paid",
      verifiedAt,
      requiresPreCallVerification: true,
      reason: "paid_model",
      pricingSummary: {
        promptPerToken: pricingVerification.promptPerToken,
        completionPerToken: pricingVerification.completionPerToken,
        requestFixed: pricingVerification.requestFixed,
      },
    };
  } else if (pricingVerification.status === "unverifiable") {
    availability = "restricted";
    freeEligibility = {
      eligible: false,
      costStatus: "unknown",
      verifiedAt,
      requiresPreCallVerification: true,
      reason: "unverifiable_pricing",
      pricingSummary: {
        promptPerToken: pricingVerification.promptPerToken,
        completionPerToken: pricingVerification.completionPerToken,
        requestFixed: pricingVerification.requestFixed,
      },
    };
  } else if (unavailable) {
    availability = "unavailable";
    freeEligibility = {
      eligible: false,
      costStatus: "free_confirmed",
      verifiedAt,
      requiresPreCallVerification: true,
      reason: "model_unavailable",
      pricingSummary: {
        promptPerToken: 0,
        completionPerToken: 0,
        requestFixed: 0,
      },
    };
  } else {
    availability = "available";
    freeEligibility = {
      eligible: true,
      costStatus: "free_confirmed",
      verifiedAt,
      requiresPreCallVerification: true,
      reason: "verified_free",
      pricingSummary: {
        promptPerToken: 0,
        completionPerToken: 0,
        requestFixed: 0,
      },
    };
  }

  const contextLength = raw.top_provider?.context_length ?? raw.context_length ?? null;
  const maxCompletionTokens = raw.top_provider?.max_completion_tokens ?? null;

  return {
    id: deriveModelId(providerId, key),
    providerId,
    providerKey: OPENROUTER_PROVIDER_KEY,
    key,
    name,
    availability,
    capabilities: extractOpenRouterCapabilities(raw),
    supportedParameters: extractOpenRouterParameters(raw),
    contextWindow:
      typeof contextLength === "number" && contextLength > 0 ? contextLength : null,
    maxOutputTokens:
      typeof maxCompletionTokens === "number" && maxCompletionTokens > 0
        ? maxCompletionTokens
        : null,
    freeEligibility,
  };
}
