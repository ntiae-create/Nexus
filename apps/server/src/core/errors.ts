import type { ApiError, CoreExecutionErrorCode, JsonValue } from "@nexus/shared";
import {
  redactSecrets,
  sanitizeDetailsRecord,
  sanitizeErrorCause,
} from "../providers/redaction.js";

const DEFAULT_STATUS_BY_CORE_ERROR: Record<CoreExecutionErrorCode, number> = {
  CORE_NOT_CONFIGURED: 503,
  CONVERSATION_NOT_FOUND: 404,
  CONVERSATION_INACTIVE: 409,
  EXECUTION_NOT_FOUND: 404,
  ASSISTANT_NOT_FOUND: 404,
  ASSISTANT_NOT_IN_CONVERSATION: 422,
  EXECUTION_IN_PROGRESS: 409,
  EXECUTION_ALREADY_TERMINAL: 409,
  EXECUTION_CANCELLED: 499,
  IDEMPOTENCY_CONFLICT: 409,
  CONTEXT_LIMIT_EXCEEDED: 422,
  INVALID_DELEGATION_CONTRACT: 502,
  DELEGATION_NOT_ALLOWED: 422,
  DELEGATION_CYCLE_DETECTED: 422,
  DELEGATION_DEPTH_EXCEEDED: 422,
  DELEGATION_LIMIT_EXCEEDED: 422,
  DELEGATED_EXECUTION_FAILED: 502,
  EMPTY_MODEL_RESPONSE: 502,
  PERSISTENCE_FAILED: 503,
  RATE_LIMITED: 429,
};

const DEFAULT_RETRYABLE_BY_CORE_ERROR: Record<CoreExecutionErrorCode, boolean> = {
  CORE_NOT_CONFIGURED: true,
  CONVERSATION_NOT_FOUND: false,
  CONVERSATION_INACTIVE: false,
  EXECUTION_NOT_FOUND: false,
  ASSISTANT_NOT_FOUND: false,
  ASSISTANT_NOT_IN_CONVERSATION: false,
  EXECUTION_IN_PROGRESS: true,
  EXECUTION_ALREADY_TERMINAL: false,
  EXECUTION_CANCELLED: false,
  IDEMPOTENCY_CONFLICT: false,
  CONTEXT_LIMIT_EXCEEDED: false,
  INVALID_DELEGATION_CONTRACT: false,
  DELEGATION_NOT_ALLOWED: false,
  DELEGATION_CYCLE_DETECTED: false,
  DELEGATION_DEPTH_EXCEEDED: false,
  DELEGATION_LIMIT_EXCEEDED: false,
  DELEGATED_EXECUTION_FAILED: false,
  EMPTY_MODEL_RESPONSE: false,
  PERSISTENCE_FAILED: true,
  RATE_LIMITED: true,
};

export interface CoreExecutionErrorOptions {
  readonly statusCode?: number;
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
  readonly redactValues?: readonly (string | undefined)[];
}

export class CoreExecutionError extends Error {
  readonly code: CoreExecutionErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details?: Record<string, JsonValue>;
  declare readonly cause?: unknown;

  constructor(
    code: CoreExecutionErrorCode,
    message: string,
    options: CoreExecutionErrorOptions = {},
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

    this.name = "CoreExecutionError";
    this.code = code;
    this.statusCode = options.statusCode ?? DEFAULT_STATUS_BY_CORE_ERROR[code];
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE_BY_CORE_ERROR[code];
    this.details = sanitizeDetailsRecord(options.details, secrets);
    if (this.stack) {
      this.stack = redactSecrets(this.stack, secrets);
    }
  }

  toApiError(requestId?: string): ApiError {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(requestId ? { requestId } : {}),
        retryable: this.retryable,
        ...(this.details ? { details: this.details } : {}),
      },
      timestamp: new Date().toISOString(),
    };
  }
}
