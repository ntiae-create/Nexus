import { apiErrorSchema } from "@nexus/shared";

/**
 * Transport-level outcome of an API call. The UI never inspects `Response`
 * objects, status numbers or `fetch` errors directly — it switches on this kind.
 */
export type ApiFailureKind =
  /** The backend could not be reached at all (offline, DNS, TLS, timeout). */
  | "network"
  /** No API base URL is configured for this build/device. */
  | "not_configured"
  /** The backend answered with a non-2xx status. */
  | "http"
  /** The backend answered 2xx with a body that does not match the contract. */
  | "invalid_response";

/** Error codes the mobile client needs to distinguish. Never carries a token. */
export class ApiError extends Error {
  readonly kind: ApiFailureKind;
  readonly status: number | null;
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(input: {
    kind: ApiFailureKind;
    message: string;
    status?: number | null;
    code?: string | null;
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = "ApiError";
    this.kind = input.kind;
    this.status = input.status ?? null;
    this.code = input.code ?? null;
    this.retryable = input.retryable ?? false;
  }

  /** True when the request never produced a usable HTTP response. */
  get isTransportFailure(): boolean {
    return this.kind === "network" || this.kind === "not_configured";
  }

  /** True when the failure means the session must be discarded. */
  get meansSessionInvalid(): boolean {
    return this.kind === "http" && this.status === 401;
  }
}

export interface ApiRequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: unknown;
  readonly token?: string | null;
  readonly signal?: AbortSignal;
  /** Per-request timeout. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Injected dependencies. Both are provided by the application composition root so
 * that the client itself has no hidden globals and tests can substitute them.
 */
export interface ApiEnvironment {
  /** Returns the current base URL, or `null` when the app has none configured. */
  readonly getBaseUrl: () => string | null;
  /** `fetch` implementation. Defaults to the platform `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

const GENERIC_NETWORK_MESSAGE =
  "Não foi possível conectar ao servidor. Verifique sua conexão e o endereço da API.";
const NOT_CONFIGURED_MESSAGE =
  "O endereço da API não está configurado neste aplicativo.";
const INVALID_RESPONSE_MESSAGE = "O servidor respondeu em um formato inesperado.";

/**
 * Status codes whose errors are worth retrying from the user's point of view.
 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function defaultMessageForStatus(status: number): string {
  if (status === 401) return "Senha incorreta.";
  if (status === 429) return "Muitas tentativas. Aguarde alguns minutos e tente novamente.";
  if (status === 503) return "O servidor está temporariamente indisponível. Tente novamente em instantes.";
  if (status === 400) return "Requisição inválida.";
  if (status >= 500) return "O servidor encontrou um erro. Tente novamente em instantes.";
  return "Não foi possível concluir a operação.";
}

/**
 * Builds the central HTTP client. Every request to the backend must go through it.
 *
 * Guarantees:
 * - never logs the password or the bearer token;
 * - attaches `Authorization: Bearer <token>` only when a token is supplied;
 * - normalizes every failure into {@link ApiError} with a user-presentable message;
 * - applies an explicit timeout so a stalled connection cannot freeze the UI.
 */
export function createApiClient(environment: ApiEnvironment) {
  const fetchImpl = environment.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function request<T>(
    path: string,
    options: ApiRequestOptions = {},
  ): Promise<T> {
    const baseUrl = environment.getBaseUrl();
    if (!baseUrl) {
      throw new ApiError({ kind: "not_configured", message: NOT_CONFIGURED_MESSAGE });
    }

    const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.token) headers.Authorization = `Bearer ${options.token}`;

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: options.method ?? "GET",
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal,
      });
    } catch {
      // Covers offline, DNS, TLS, CORS and timeout. The original error is not
      // rethrown because it may embed the URL and platform internals.
      throw new ApiError({
        kind: "network",
        message: GENERIC_NETWORK_MESSAGE,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text().catch(() => "");
    let payload: unknown = undefined;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = undefined;
      }
    }

    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(payload);
      throw new ApiError({
        kind: "http",
        status: response.status,
        code: parsed.success ? parsed.data.error.code : null,
        // Contract messages are shown only when they are actually informative;
        // otherwise a Portuguese, user-facing message is used.
        message: parsed.success ? parsed.data.error.message : defaultMessageForStatus(response.status),
        retryable: RETRYABLE_STATUS.has(response.status),
      });
    }

    if (response.status === 204) return undefined as T;
    if (payload === undefined) {
      throw new ApiError({ kind: "invalid_response", message: INVALID_RESPONSE_MESSAGE });
    }
    return payload as T;
  }

  return {
    request,
    get: <T>(path: string, options?: Omit<ApiRequestOptions, "method" | "body">) =>
      request<T>(path, { ...options, method: "GET" }),
    post: <T>(path: string, body?: unknown, options?: Omit<ApiRequestOptions, "method" | "body">) =>
      request<T>(path, { ...options, method: "POST", ...(body !== undefined ? { body } : {}) }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
