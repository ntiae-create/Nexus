import {
  modelGenerationRequestSchema,
  type GenerationFinishReason,
  type GenerationParameters,
  type ModelCapability,
  type ModelGenerationResponse,
  type ModelParameterName,
} from "@nexus/shared";
import { OPENROUTER_PROVIDER_ID, OPENROUTER_PROVIDER_KEY } from "../ids.js";
import { redactSecrets } from "../redaction.js";
import {
  ProviderError,
  type ProviderAdapter,
  type ProviderGenerationCall,
  type ProviderModelDescriptor,
  type ProviderRuntimeStatus,
} from "../types.js";
import {
  evaluateOpenRouterModel,
  isOpenRouterFreeModelKey,
  parseNonNegativePrice,
  stripOpenRouterFreeSuffix,
} from "./pricing.js";
import {
  openRouterChatCompletionResponseSchema,
  openRouterErrorEnvelopeSchema,
  openRouterModelsResponseSchema,
} from "./schemas.js";

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_TIMEOUT_MS = 15_000;

export const OPENROUTER_SUPPORTED_CAPABILITIES: readonly ModelCapability[] = [
  "chat",
  "system_prompt",
  "streaming",
  "structured_output",
  "reasoning",
  "vision",
  "code",
];

export const OPENROUTER_SUPPORTED_PARAMETERS: readonly ModelParameterName[] = [
  "temperature",
  "topP",
  "maxOutputTokens",
  "stopSequences",
  "seed",
  "presencePenalty",
  "frequencyPenalty",
  "responseFormat",
];

export interface OpenRouterEnv {
  readonly OPENROUTER_API_KEY?: string;
  readonly OPENROUTER_BASE_URL?: string;
  readonly OPENROUTER_TIMEOUT_MS?: string;
}

export interface OpenRouterConfig {
  readonly apiKey: string | undefined;
  readonly baseUrl: string;
  readonly timeoutMs: number;
}

export function loadOpenRouterConfig(
  env: OpenRouterEnv = process.env,
): OpenRouterConfig {
  const apiKey = env.OPENROUTER_API_KEY?.trim() || undefined;
  const rawBaseUrl = env.OPENROUTER_BASE_URL?.trim() || DEFAULT_OPENROUTER_BASE_URL;

  let normalizedBaseUrl: string;
  try {
    const parsed = new URL(rawBaseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Unsupported protocol");
    }
    if (parsed.username || parsed.password) {
      throw new Error("Base URL must not embed credentials");
    }
    normalizedBaseUrl = parsed.toString().replace(/\/+$/, "");
  } catch (err) {
    throw new ProviderError(
      "NOT_CONFIGURED",
      "Invalid OPENROUTER_BASE_URL configuration",
      {
        providerKey: OPENROUTER_PROVIDER_KEY,
        cause: err,
        redactValues: [apiKey, rawBaseUrl],
      },
    );
  }

  let timeoutMs = DEFAULT_OPENROUTER_TIMEOUT_MS;
  const rawTimeout = env.OPENROUTER_TIMEOUT_MS?.trim();
  if (rawTimeout) {
    const parsedTimeout = Number(rawTimeout);
    if (
      !Number.isInteger(parsedTimeout) ||
      parsedTimeout < 100 ||
      parsedTimeout > 120_000
    ) {
      throw new ProviderError(
        "NOT_CONFIGURED",
        "OPENROUTER_TIMEOUT_MS must be an integer between 100 and 120000",
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          redactValues: [apiKey],
        },
      );
    }
    timeoutMs = parsedTimeout;
  }

  return {
    apiKey,
    baseUrl: normalizedBaseUrl,
    timeoutMs,
  };
}

export interface OpenRouterAdapterOptions {
  readonly id?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
}

function normalizeFinishReason(raw: string | null | undefined): GenerationFinishReason {
  switch (raw?.toLowerCase()) {
    case "stop":
    case "end_turn":
      return "stop";
    case "length":
    case "max_tokens":
      return "length";
    case "content_filter":
      return "content_filter";
    case "error":
      return "error";
    default:
      return "unknown";
  }
}

function extractMessageContent(
  rawContent: string | Array<{ type: string; text?: string }> | null | undefined,
): string | null {
  if (typeof rawContent === "string") {
    return rawContent;
  }
  if (Array.isArray(rawContent)) {
    const textParts: string[] = [];
    for (const part of rawContent) {
      if (part.type === "text" && typeof part.text === "string") {
        textParts.push(part.text);
      }
    }
    return textParts.join("");
  }
  return null;
}

function collectRequestedParameterNames(
  parameters: GenerationParameters | undefined,
): ModelParameterName[] {
  if (!parameters) return [];
  const names: ModelParameterName[] = [];
  if (parameters.temperature !== undefined) names.push("temperature");
  if (parameters.topP !== undefined) names.push("topP");
  if (parameters.maxOutputTokens !== undefined) names.push("maxOutputTokens");
  if (parameters.stopSequences !== undefined) names.push("stopSequences");
  if (parameters.seed !== undefined) names.push("seed");
  if (parameters.presencePenalty !== undefined) names.push("presencePenalty");
  if (parameters.frequencyPenalty !== undefined) names.push("frequencyPenalty");
  if (parameters.responseFormat !== undefined) names.push("responseFormat");
  return names;
}

function mapGenerationParametersToOpenRouter(
  parameters: GenerationParameters | undefined,
): Record<string, unknown> {
  if (!parameters) return {};
  const mapped: Record<string, unknown> = {};
  if (parameters.temperature !== undefined) {
    mapped.temperature = parameters.temperature;
  }
  if (parameters.topP !== undefined) {
    mapped.top_p = parameters.topP;
  }
  if (parameters.maxOutputTokens !== undefined) {
    mapped.max_tokens = parameters.maxOutputTokens;
  }
  if (parameters.stopSequences !== undefined) {
    mapped.stop = parameters.stopSequences;
  }
  if (parameters.seed !== undefined) {
    mapped.seed = parameters.seed;
  }
  if (parameters.presencePenalty !== undefined) {
    mapped.presence_penalty = parameters.presencePenalty;
  }
  if (parameters.frequencyPenalty !== undefined) {
    mapped.frequency_penalty = parameters.frequencyPenalty;
  }
  if (parameters.responseFormat !== undefined) {
    mapped.response_format = parameters.responseFormat;
  }
  return mapped;
}

export function createOpenRouterAdapter(
  options: OpenRouterAdapterOptions = {},
): ProviderAdapter {
  const providerId = options.id ?? OPENROUTER_PROVIDER_ID;
  const apiKey = options.apiKey?.trim() || undefined;
  const baseUrl = (options.baseUrl?.trim() || DEFAULT_OPENROUTER_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_OPENROUTER_TIMEOUT_MS;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const redactList = [apiKey];

  function assertConfigured(): string {
    if (!apiKey) {
      throw new ProviderError(
        "NOT_CONFIGURED",
        "OpenRouter API key (OPENROUTER_API_KEY) is not configured",
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          redactValues: redactList,
        },
      );
    }
    return apiKey;
  }

  async function requestJson(
    path: string,
    init: {
      method: "GET" | "POST";
      body?: Record<string, unknown>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<unknown> {
    const configuredKey = assertConfigured();

    if (init.signal?.aborted) {
      throw new ProviderError("CANCELLED", "OpenRouter request was cancelled", {
        providerKey: OPENROUTER_PROVIDER_KEY,
        redactValues: redactList,
      });
    }

    const effectiveTimeoutMs = init.timeoutMs ?? defaultTimeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    let cancelledByCaller = false;

    const onCallerAbort = (): void => {
      cancelledByCaller = true;
      controller.abort();
    };

    if (init.signal) {
      init.signal.addEventListener("abort", onCallerAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, effectiveTimeoutMs);

    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${configuredKey}`,
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          "X-Title": "NEXUS",
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      if (cancelledByCaller || init.signal?.aborted) {
        throw new ProviderError("CANCELLED", "OpenRouter request was cancelled", {
          providerKey: OPENROUTER_PROVIDER_KEY,
          cause: err,
          redactValues: redactList,
        });
      }
      if (timedOut) {
        throw new ProviderError(
          "TIMEOUT",
          `OpenRouter request timed out after ${effectiveTimeoutMs}ms`,
          {
            providerKey: OPENROUTER_PROVIDER_KEY,
            details: { timeoutMs: effectiveTimeoutMs },
            cause: err,
            redactValues: redactList,
          },
        );
      }
      throw new ProviderError(
        "UNAVAILABLE",
        `Failed to reach OpenRouter: ${redactSecrets(
          err instanceof Error ? err.message : "network error",
          redactList,
        )}`,
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          cause: err,
          redactValues: redactList,
        },
      );
    } finally {
      clearTimeout(timer);
      if (init.signal) {
        init.signal.removeEventListener("abort", onCallerAbort);
      }
    }

    let rawText: string;
    try {
      rawText = await response.text();
    } catch (err) {
      if (timedOut) {
        throw new ProviderError(
          "TIMEOUT",
          `OpenRouter response timed out after ${effectiveTimeoutMs}ms`,
          {
            providerKey: OPENROUTER_PROVIDER_KEY,
            details: { timeoutMs: effectiveTimeoutMs },
            cause: err,
            redactValues: redactList,
          },
        );
      }
      throw new ProviderError(
        "UNAVAILABLE",
        "Failed while reading OpenRouter HTTP response body",
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          cause: err,
          redactValues: redactList,
        },
      );
    }

    if (!response.ok) {
      let upstreamDetail: string | undefined;
      try {
        const parsedErr = openRouterErrorEnvelopeSchema.safeParse(JSON.parse(rawText));
        if (parsedErr.success && parsedErr.data.error.message) {
          upstreamDetail = redactSecrets(
            parsedErr.data.error.message.slice(0, 240),
            redactList,
          );
        }
      } catch {
        // Non-JSON upstream error body; fall back to HTTP status classification.
      }

      throw mapHttpError(response.status, upstreamDetail, redactList);
    }

    try {
      return JSON.parse(rawText) as unknown;
    } catch (err) {
      throw new ProviderError(
        "INVALID_RESPONSE",
        "OpenRouter returned invalid JSON",
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          cause: err,
          redactValues: redactList,
        },
      );
    }
  }

  async function listModels(
    callOptions: { signal?: AbortSignal } = {},
  ): Promise<readonly ProviderModelDescriptor[]> {
    const rawPayload = await requestJson("/models", {
      method: "GET",
      signal: callOptions.signal,
    });

    const parsed = openRouterModelsResponseSchema.safeParse(rawPayload);
    if (!parsed.success) {
      throw new ProviderError(
        "INVALID_RESPONSE",
        "OpenRouter returned a malformed models catalog payload",
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          redactValues: redactList,
        },
      );
    }

    const nowMs = now();
    return parsed.data.data.map((rawModel) =>
      evaluateOpenRouterModel(rawModel, { providerId, nowMs }),
    );
  }

  async function verifyModelEligibility(
    modelKey: string,
    callOptions: { signal?: AbortSignal } = {},
  ): Promise<ProviderModelDescriptor> {
    const trimmedKey = modelKey.trim();
    if (!trimmedKey) {
      throw new ProviderError(
        "INVALID_SELECTION",
        "Model key must not be empty",
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          redactValues: redactList,
        },
      );
    }

    if (!isOpenRouterFreeModelKey(trimmedKey)) {
      throw new ProviderError(
        "PAID_MODEL_BLOCKED",
        `Model '${trimmedKey}' is blocked because OpenRouter requires the ':free' suffix`,
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          details: { model: trimmedKey, reason: "missing_free_suffix" },
          redactValues: redactList,
        },
      );
    }

    const models = await listModels({ signal: callOptions.signal });
    const match = models.find((item) => item.key === trimmedKey);

    if (!match) {
      throw new ProviderError(
        "MODEL_UNAVAILABLE",
        `Free model '${trimmedKey}' is not currently available in OpenRouter's live catalog`,
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          details: { model: trimmedKey, reason: "model_unavailable" },
          redactValues: redactList,
        },
      );
    }

    if (match.freeEligibility.costStatus === "paid") {
      throw new ProviderError(
        "PAID_MODEL_BLOCKED",
        `Model '${trimmedKey}' reported non-zero pricing on live verification and was blocked`,
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          details: { model: trimmedKey, reason: "paid_model" },
          redactValues: redactList,
        },
      );
    }

    if (match.freeEligibility.costStatus === "unknown") {
      throw new ProviderError(
        "UNVERIFIED_PRICING_BLOCKED",
        `Model '${trimmedKey}' lacks verifiable zero-cost pricing and was blocked`,
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          details: { model: trimmedKey, reason: "unverifiable_pricing" },
          redactValues: redactList,
        },
      );
    }

    if (match.availability !== "available" || !match.freeEligibility.eligible) {
      throw new ProviderError(
        "MODEL_UNAVAILABLE",
        `Free model '${trimmedKey}' is currently unavailable`,
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          details: { model: trimmedKey, reason: match.freeEligibility.reason },
          redactValues: redactList,
        },
      );
    }

    return match;
  }

  async function generate(
    rawRequest: ProviderGenerationCall,
  ): Promise<ModelGenerationResponse> {
    const parsedRequest = modelGenerationRequestSchema.safeParse({
      model: rawRequest.model,
      messages: rawRequest.messages,
      ...(rawRequest.parameters !== undefined
        ? { parameters: rawRequest.parameters }
        : {}),
      ...(rawRequest.requestId !== undefined
        ? { requestId: rawRequest.requestId }
        : {}),
      ...(rawRequest.timeoutMs !== undefined
        ? { timeoutMs: rawRequest.timeoutMs }
        : {}),
    });

    if (!parsedRequest.success) {
      throw new ProviderError(
        "INCOMPATIBLE_PARAMETERS",
        "Invalid generation request payload or parameter bounds",
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          details: {
            issues: parsedRequest.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
          redactValues: redactList,
        },
      );
    }

    const request = parsedRequest.data;

    // 1. Fail-closed check before touching network: key configured + `:free` suffix.
    assertConfigured();
    if (!isOpenRouterFreeModelKey(request.model)) {
      throw new ProviderError(
        "PAID_MODEL_BLOCKED",
        `Model '${request.model}' is blocked: only ':free' OpenRouter models are permitted`,
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          details: { model: request.model, reason: "missing_free_suffix" },
          redactValues: redactList,
        },
      );
    }

    // 2. Mandatory live pre-call eligibility & zero-price verification.
    // Never assume a model is still free merely because it appeared in an older catalog.
    const verifiedModel = await verifyModelEligibility(request.model, {
      signal: rawRequest.signal,
    });

    // 3. Validate parameter compatibility against the verified model.
    const requestedParamNames = collectRequestedParameterNames(request.parameters);
    const unsupportedParams = requestedParamNames.filter(
      (param) => !verifiedModel.supportedParameters.includes(param),
    );
    if (unsupportedParams.length > 0) {
      throw new ProviderError(
        "INCOMPATIBLE_PARAMETERS",
        `Model '${verifiedModel.key}' does not support requested parameter(s): ${unsupportedParams.join(", ")}`,
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          details: {
            model: verifiedModel.key,
            unsupportedParameters: unsupportedParams,
          },
          redactValues: redactList,
        },
      );
    }

    // 4. Execute generation strictly targeting the single verified `:free` model
    // with zero paid fallbacks.
    const rawCompletion = await requestJson("/chat/completions", {
      method: "POST",
      body: {
        model: verifiedModel.key,
        messages: request.messages,
        ...mapGenerationParametersToOpenRouter(request.parameters),
      },
      timeoutMs: request.timeoutMs,
      signal: rawRequest.signal,
    });

    // OpenRouter can occasionally return `{ error: { code, message } }` inside a 200 payload.
    const embeddedError = openRouterErrorEnvelopeSchema.safeParse(rawCompletion);
    if (
      embeddedError.success &&
      !("choices" in (rawCompletion as Record<string, unknown>))
    ) {
      const errCode = Number(embeddedError.data.error.code);
      const errMessage = embeddedError.data.error.message
        ? redactSecrets(embeddedError.data.error.message.slice(0, 240), redactList)
        : undefined;
      if (Number.isInteger(errCode) && errCode >= 400 && errCode < 600) {
        throw mapHttpError(errCode, errMessage, redactList);
      }
      throw new ProviderError(
        "UPSTREAM_ERROR",
        errMessage ?? "OpenRouter returned an error payload during generation",
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          redactValues: redactList,
        },
      );
    }

    const parsedCompletion =
      openRouterChatCompletionResponseSchema.safeParse(rawCompletion);
    if (!parsedCompletion.success) {
      throw new ProviderError(
        "INVALID_RESPONSE",
        "OpenRouter returned a malformed chat completion response",
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          redactValues: redactList,
        },
      );
    }

    const completion = parsedCompletion.data;

    // 5. Post-response safety verification: reject if OpenRouter reported non-zero cost
    // or substituted a different/paid model.
    const rawReportedCost = completion.usage?.cost ?? completion.usage?.total_cost;
    if (rawReportedCost !== undefined) {
      const parsedCost = parseNonNegativePrice(rawReportedCost);
      if (!parsedCost.valid || parsedCost.value > 0) {
        throw new ProviderError(
          "PAID_MODEL_BLOCKED",
          "OpenRouter reported a non-zero or unverifiable cost on completion response",
          {
            providerKey: OPENROUTER_PROVIDER_KEY,
            details: { model: verifiedModel.key },
            redactValues: redactList,
          },
        );
      }
    }

    if (completion.model) {
      const returnedModel = completion.model.trim();
      const expectedBase = stripOpenRouterFreeSuffix(verifiedModel.key);
      if (
        returnedModel !== verifiedModel.key &&
        returnedModel !== expectedBase
      ) {
        throw new ProviderError(
          "PAID_MODEL_BLOCKED",
          `OpenRouter routed generation to unexpected model '${returnedModel}'`,
          {
            providerKey: OPENROUTER_PROVIDER_KEY,
            details: {
              requestedModel: verifiedModel.key,
              returnedModel,
            },
            redactValues: redactList,
          },
        );
      }
    }

    const primaryChoice = completion.choices[0]!;
    const content = extractMessageContent(primaryChoice.message.content);
    if (content === null) {
      throw new ProviderError(
        "INVALID_RESPONSE",
        "OpenRouter completion response did not contain message content",
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          redactValues: redactList,
        },
      );
    }

    const createdAt =
      typeof completion.created === "number" && completion.created > 0
        ? new Date(completion.created * 1000).toISOString()
        : new Date(now()).toISOString();

    const inputTokens = completion.usage?.prompt_tokens;
    const outputTokens = completion.usage?.completion_tokens;
    const totalTokens =
      completion.usage?.total_tokens ??
      (inputTokens !== undefined && outputTokens !== undefined
        ? inputTokens + outputTokens
        : undefined);

    return {
      id: completion.id,
      providerId,
      providerKey: OPENROUTER_PROVIDER_KEY,
      modelId: verifiedModel.id,
      modelKey: verifiedModel.key,
      content,
      finishReason: normalizeFinishReason(primaryChoice.finish_reason),
      ...(inputTokens !== undefined &&
      outputTokens !== undefined &&
      totalTokens !== undefined
        ? {
            usage: {
              inputTokens,
              outputTokens,
              totalTokens,
            },
          }
        : {}),
      createdAt,
      freeEligibility: verifiedModel.freeEligibility,
    };
  }

  return {
    id: providerId,
    key: OPENROUTER_PROVIDER_KEY,
    name: "OpenRouter",
    kind: "cloud",
    supportedCapabilities: OPENROUTER_SUPPORTED_CAPABILITIES,
    supportedParameters: OPENROUTER_SUPPORTED_PARAMETERS,
    isConfigured: () => Boolean(apiKey),
    getStatus(): ProviderRuntimeStatus {
      const configured = Boolean(apiKey);
      return {
        provider: {
          id: providerId,
          key: OPENROUTER_PROVIDER_KEY,
          name: "OpenRouter",
          kind: "cloud",
        },
        configured,
        availability: configured ? "available" : "unavailable",
        costPolicy: "free_only",
        costStatus: configured ? "free_confirmed" : "unknown",
        capabilities: OPENROUTER_SUPPORTED_CAPABILITIES,
        supportedParameters: OPENROUTER_SUPPORTED_PARAMETERS,
        ...(!configured ? { unavailableReason: "provider_not_configured" } : {}),
      };
    },
    listModels,
    verifyModelEligibility,
    generate,
    complete: generate,
  };
}

function mapHttpError(
  status: number,
  upstreamDetail: string | undefined,
  redactList: readonly (string | undefined)[],
): ProviderError {
  const suffix = upstreamDetail ? `: ${upstreamDetail}` : "";

  switch (status) {
    case 401:
    case 403:
      return new ProviderError(
        "AUTHENTICATION_FAILED",
        `OpenRouter authentication failed (HTTP ${status})${suffix}`,
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          details: { upstreamStatus: status },
          redactValues: redactList,
        },
      );
    case 402:
      return new ProviderError(
        "PAID_MODEL_BLOCKED",
        `OpenRouter rejected request because payment or credits were required (HTTP 402)${suffix}`,
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          details: { upstreamStatus: status },
          redactValues: redactList,
        },
      );
    case 404:
      return new ProviderError(
        "MODEL_UNAVAILABLE",
        `Requested free model or endpoint is unavailable on OpenRouter (HTTP 404)${suffix}`,
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          details: { upstreamStatus: status },
          redactValues: redactList,
        },
      );
    case 408:
    case 504:
      return new ProviderError(
        "TIMEOUT",
        `OpenRouter upstream timed out (HTTP ${status})${suffix}`,
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          details: { upstreamStatus: status },
          redactValues: redactList,
        },
      );
    case 429:
      return new ProviderError(
        "RATE_LIMITED",
        `OpenRouter rate limit or free quota reached (HTTP 429)${suffix}`,
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          details: { upstreamStatus: status },
          redactValues: redactList,
        },
      );
    case 500:
    case 502:
    case 503:
      return new ProviderError(
        "UNAVAILABLE",
        `OpenRouter is temporarily unavailable (HTTP ${status})${suffix}`,
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          details: { upstreamStatus: status },
          redactValues: redactList,
        },
      );
    default:
      return new ProviderError(
        "UPSTREAM_ERROR",
        `OpenRouter request failed with HTTP ${status}${suffix}`,
        {
          providerKey: OPENROUTER_PROVIDER_KEY,
          retryable: status >= 500,
          details: { upstreamStatus: status },
          redactValues: redactList,
        },
      );
  }
}
