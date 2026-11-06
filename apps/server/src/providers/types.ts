import type {
  ApiError,
  FreeEligibility,
  GenerationFinishReason,
  GenerationMessage,
  GenerationParameters,
  JsonValue,
  ModelCapability,
  ModelGenerationRequest,
  ModelGenerationResponse,
  ModelParameterName,
  ProviderAvailability,
  ProviderCostStatus,
  ProviderErrorCode,
  ProviderKind,
  TokenUsage,
} from "@nexus/shared";
import { redactSecrets, sanitizeDetailsRecord, sanitizeErrorCause } from "./redaction.js";

export type {
  FreeEligibility,
  GenerationFinishReason,
  GenerationMessage,
  GenerationParameters,
  ModelCapability,
  ModelGenerationRequest,
  ModelGenerationResponse,
  ModelParameterName,
  ProviderAvailability,
  ProviderCostStatus,
  ProviderErrorCode,
  ProviderKind,
  TokenUsage,
};

/**
 * Legacy-compatible alias kept so existing type references remain valid.
 */
export type ProviderCostClass = ProviderCostStatus;
export type ChatMessage = GenerationMessage;

export interface ProviderIdentity {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly kind: ProviderKind;
}

export interface ProviderRuntimeStatus {
  readonly provider: ProviderIdentity;
  readonly configured: boolean;
  readonly availability: ProviderAvailability;
  readonly costPolicy: "free_only";
  readonly costStatus: ProviderCostStatus;
  readonly capabilities: readonly ModelCapability[];
  readonly supportedParameters: readonly ModelParameterName[];
  readonly unavailableReason?: string;
}

export interface ProviderModelDescriptor {
  readonly id: string;
  readonly providerId: string;
  readonly providerKey: string;
  readonly key: string;
  readonly name: string;
  readonly availability: ProviderAvailability;
  readonly capabilities: readonly ModelCapability[];
  readonly supportedParameters: readonly ModelParameterName[];
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  readonly freeEligibility: FreeEligibility;
}

/**
 * Backwards-compatible alias for ProviderModelDescriptor.
 */
export type ProviderModelInfo = ProviderModelDescriptor;

export interface ProviderGenerationCall extends ModelGenerationRequest {
  readonly signal?: AbortSignal;
}

export type ChatCompletionRequest = ProviderGenerationCall;
export type ChatCompletionResult = ModelGenerationResponse;

export interface ProviderAdapter {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly kind: ProviderKind;
  readonly supportedCapabilities: readonly ModelCapability[];
  readonly supportedParameters: readonly ModelParameterName[];
  isConfigured(): boolean;
  getStatus(): ProviderRuntimeStatus;
  listModels(options?: { signal?: AbortSignal }): Promise<readonly ProviderModelDescriptor[]>;
  verifyModelEligibility(
    modelKey: string,
    options?: { signal?: AbortSignal },
  ): Promise<ProviderModelDescriptor>;
  generate(request: ProviderGenerationCall): Promise<ModelGenerationResponse>;
  complete(request: ProviderGenerationCall): Promise<ModelGenerationResponse>;
}

const DEFAULT_STATUS_BY_ERROR_CODE: Record<ProviderErrorCode, number> = {
  NOT_CONFIGURED: 503,
  PAID_MODEL_BLOCKED: 403,
  UNVERIFIED_PRICING_BLOCKED: 403,
  MODEL_NOT_FOUND: 404,
  MODEL_UNAVAILABLE: 503,
  INVALID_SELECTION: 422,
  INCOMPATIBLE_PARAMETERS: 422,
  AUTHENTICATION_FAILED: 502,
  RATE_LIMITED: 429,
  TIMEOUT: 504,
  CANCELLED: 499,
  UNAVAILABLE: 503,
  UPSTREAM_ERROR: 502,
  INVALID_RESPONSE: 502,
};

const DEFAULT_RETRYABLE_BY_ERROR_CODE: Record<ProviderErrorCode, boolean> = {
  NOT_CONFIGURED: false,
  PAID_MODEL_BLOCKED: false,
  UNVERIFIED_PRICING_BLOCKED: false,
  MODEL_NOT_FOUND: false,
  MODEL_UNAVAILABLE: false,
  INVALID_SELECTION: false,
  INCOMPATIBLE_PARAMETERS: false,
  AUTHENTICATION_FAILED: false,
  RATE_LIMITED: true,
  TIMEOUT: true,
  CANCELLED: false,
  UNAVAILABLE: true,
  UPSTREAM_ERROR: false,
  INVALID_RESPONSE: false,
};

export interface ProviderErrorOptions {
  readonly providerKey: string;
  readonly statusCode?: number;
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
  readonly redactValues?: readonly (string | undefined)[];
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly providerKey: string;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details?: Record<string, JsonValue>;
  declare readonly cause?: unknown;

  constructor(
    code: ProviderErrorCode,
    message: string,
    options: ProviderErrorOptions,
  ) {
    const secrets = options.redactValues ?? [];
    const safeMessage = redactSecrets(message, secrets);
    const safeCause = sanitizeErrorCause(options.cause, secrets);
    super(safeMessage);
    if (safeCause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: safeCause,
        configurable: true,
        writable: true,
      });
    }
    this.name = "ProviderError";
    this.code = code;
    this.providerKey = options.providerKey;
    this.statusCode = options.statusCode ?? DEFAULT_STATUS_BY_ERROR_CODE[code];
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE_BY_ERROR_CODE[code];
    this.details = sanitizeDetailsRecord(options.details, secrets);
    if (this.stack) {
      this.stack = redactSecrets(this.stack, secrets);
    }
  }

  toApiError(requestId?: string): ApiError {
    return {
      error: {
        code: `PROVIDER_${this.code}`,
        message: this.message,
        ...(requestId ? { requestId } : {}),
        retryable: this.retryable,
        details: {
          provider: this.providerKey,
          ...(this.details ?? {}),
        },
      },
      timestamp: new Date().toISOString(),
    };
  }
}
