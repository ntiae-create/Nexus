import type {
  CoreExecutionInspection,
  CoreExecutionResponse,
  CoreRun,
  AssistantKey,
  Message,
  RunStatus,
} from "@nexus/shared";
import { ApiError } from "./api-client.js";
import type { CoreService } from "./core-service.js";

/**
 * Conversation/execution orchestration for the chat screen.
 *
 * Everything here is a *projection of persisted server state*: the happy path receives the
 * already-persisted assistant message from `POST /v1/conversations/:id/messages`, and the
 * ambiguous paths (timeout, connection loss, `EXECUTION_IN_PROGRESS`) resolve by reading the
 * run back with `GET /v1/executions/:runId` and then loading the conversation history to
 * find the message referenced by `execution.finalMessageId`. Nothing is ever invented
 * locally: when the server has no assistant message, the operation ends in an explicit
 * failure state.
 *
 * Note on the contract: `coreExecutionInspectionSchema` exposes `execution`, `steps`,
 * `results` and `childExecutions` — it does **not** embed the assistant message. The
 * persisted reply is therefore always read from
 * `GET /v1/conversations/:id/messages`, which is the same source the reopened chat uses.
 */

/** Terminal run states of the frozen contract (`runStatusSchema`). */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "succeeded",
  "partial",
  "failed",
  "cancelled",
];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * Delay schedule for `GET /v1/executions/:runId`.
 *
 * Starts short (so a fast run is reflected immediately) and backs off to a slow steady
 * state, keeping a bounded request rate while the CORE works. Transient transport errors
 * are retried, and the loop stops on the first terminal state.
 */
export const POLL_DELAYS_MS: readonly number[] = [400, 800, 1_200, 1_600, 2_000, 2_500, 3_000];

export function pollDelayFor(attempt: number): number {
  const index = Math.min(Math.max(attempt, 0), POLL_DELAYS_MS.length - 1);
  return POLL_DELAYS_MS[index]!;
}

/** How a tracked execution ended, from the point of view of the UI. */
export type FollowOutcome =
  /** `succeeded`: the CORE persisted a final answer. */
  | { readonly kind: "succeeded"; readonly run: CoreRun }
  /** `partial`: part of the coordinated work failed, a valid answer still exists. */
  | { readonly kind: "partial"; readonly run: CoreRun }
  /** `failed`: no answer was produced. */
  | { readonly kind: "failed"; readonly run: CoreRun; readonly message: string }
  /** `cancelled`: the run will not produce an answer. */
  | { readonly kind: "cancelled"; readonly run: CoreRun }
  /** Polling could not confirm a terminal state (connection lost / budget exhausted). */
  | { readonly kind: "unknown"; readonly error: ApiError }
  /** The session is no longer valid; the app must return to the login screen. */
  | { readonly kind: "unauthorized" }
  /** The caller aborted (screen unmounted / navigation) — no state change is expected. */
  | { readonly kind: "aborted" };

export interface FollowOptions {
  readonly signal?: AbortSignal;
  /** Test hook: replaces `setTimeout` so timers are deterministic. */
  readonly scheduler?: (callback: () => void, delayMs: number) => void;
  /** Test hook: maximum probes before giving up. */
  readonly maxAttempts?: number;
  /** Test hook: consecutive transient failures tolerated. */
  readonly maxTransientFailures?: number;
  /** Called after every successful probe so the screen can show progress. */
  readonly onProgress?: (run: CoreRun) => void;
}

export const DEFAULT_MAX_POLL_ATTEMPTS = 40;
export const DEFAULT_MAX_TRANSIENT_FAILURES = 4;

function waitFor(delayMs: number, options: FollowOptions): Promise<void> {
  if (options.scheduler) {
    return new Promise<void>((resolve) => options.scheduler!(resolve, delayMs));
  }
  return new Promise<void>((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted) {
      reject(new ApiError({ kind: "network", message: "Operação cancelada." }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ApiError({ kind: "network", message: "Operação cancelada." }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Failure code of a run, read from the persisted metadata the engine writes
 * (`failureCode`, see `markFailed`/`completeRootExecution` in `apps/server/src/core/engine.ts`).
 */
export function failureCodeOf(run: CoreRun): string | null {
  const metadata = run.metadata as Record<string, unknown> | undefined;
  const code = metadata?.["failureCode"];
  return typeof code === "string" ? code : null;
}

/** User-facing explanation for a persisted run status; never invents content. */
export function describeRunStatus(run: CoreRun): string {
  switch (run.status) {
    case "queued":
      return "Aguardando o NEXUS CORE iniciar a execução.";
    case "running":
      return "O NEXUS CORE está processando esta mensagem.";
    case "succeeded":
      return "Resposta concluída.";
    case "partial":
      return "Resposta parcial: parte do trabalho coordenado falhou.";
    case "failed": {
      const code = failureCodeOf(run);
      return code
        ? `A execução falhou (${code}). Nenhuma resposta foi gerada.`
        : "A execução falhou. Nenhuma resposta foi gerada.";
    }
    case "cancelled":
      return "Execução cancelada. Nenhuma resposta foi gerada.";
    default:
      return "Estado de execução desconhecido.";
  }
}

/** Human-readable text of a persisted message, ignoring non-text parts. */
export function messageText(message: Message): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Follows a run until a terminal state.
 *
 * - polls `GET /v1/executions/:runId` with the bounded backoff schedule above;
 * - **stops on any terminal state** (`succeeded`, `partial`, `failed`, `cancelled`);
 * - tolerates transient transport/5xx failures up to `maxTransientFailures` consecutive
 *   probes, then reports `unknown` (the run may still be finishing server-side);
 * - `401` aborts immediately with `unauthorized` so the app returns to login;
 * - an aborted `signal` returns `aborted` without touching the UI.
 */
export async function followExecution(input: {
  readonly service: CoreService;
  readonly token: string;
  readonly runId: string;
  readonly options?: FollowOptions;
}): Promise<FollowOutcome> {
  const options = input.options ?? {};
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
  const maxTransientFailures = options.maxTransientFailures ?? DEFAULT_MAX_TRANSIENT_FAILURES;

  let transientFailures = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (options.signal?.aborted) return { kind: "aborted" };

    let inspection: CoreExecutionInspection | null = null;
    try {
      inspection = await input.service.getExecution(input.token, input.runId, {
        ...(options.signal ? { signal: options.signal } : {}),
      });
      transientFailures = 0;
    } catch (error) {
      if (options.signal?.aborted) return { kind: "aborted" };
      if (error instanceof ApiError && error.meansSessionInvalid) return { kind: "unauthorized" };
      transientFailures += 1;
      const retryable = error instanceof ApiError ? error.retryable : true;
      if (!retryable || transientFailures > maxTransientFailures) {
        return {
          kind: "unknown",
          error:
            error instanceof ApiError
              ? error
              : new ApiError({ kind: "network", message: "Falha ao consultar a execução." }),
        };
      }
    }

    if (inspection) {
      const run = inspection.execution;
      options.onProgress?.(run);
      if (run.status === "succeeded") return { kind: "succeeded", run };
      if (run.status === "partial") return { kind: "partial", run };
      if (run.status === "failed") {
        return { kind: "failed", run, message: describeRunStatus(run) };
      }
      if (run.status === "cancelled") return { kind: "cancelled", run };
    }

    if (attempt < maxAttempts - 1) {
      try {
        await waitFor(pollDelayFor(attempt), options);
      } catch {
        return { kind: "aborted" };
      }
    }
  }

  return {
    kind: "unknown",
    error: new ApiError({
      kind: "network",
      message:
        "Não foi possível confirmar o resultado da execução. Abra a conversa novamente para ver o estado persistido.",
    }),
  };
}

/**
 * Loads the assistant message a finished run persisted.
 *
 * The inspection endpoint does not embed messages, so the reply is read from the
 * conversation history and matched by `execution.finalMessageId`. Returns `null` when the
 * run has no final message — which is the truth for `failed`/`cancelled` runs.
 */
export async function loadAssistantMessageForRun(input: {
  readonly service: CoreService;
  readonly token: string;
  readonly conversationId: string;
  readonly run: CoreRun;
  readonly signal?: AbortSignal;
}): Promise<Message | null> {
  const finalMessageId = input.run.finalMessageId;
  if (!finalMessageId) return null;
  const messages = await input.service.listMessages(input.token, input.conversationId, {
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const found = messages.find((message) => message.id === finalMessageId);
  if (!found) return null;
  // A reply is only shown when the server persisted it as an assistant message of a
  // successful/partial run; anything else would be a contract violation.
  if (found.role !== "assistant") return null;
  return found;
}

/** Extracts the persisted assistant message from a successful execution response. */
export function assistantMessageOf(response: CoreExecutionResponse): Message {
  return response.assistantMessage;
}

export interface SendMessageOutcome {
  /** Persisted user message, as returned by the server. */
  readonly userMessage: Message;
  /** Persisted assistant message; always present — the server has no reply-less success. */
  readonly assistantMessage: Message;
  readonly run: CoreRun;
  /** `succeeded` or `partial`; both carry a real, persisted answer. */
  readonly status: "succeeded" | "partial";
}

/**
 * Sends a message and returns only what the server persisted.
 *
 * Rejects with `ApiError`, which the caller maps to a user-facing message. In particular:
 * - `401` → the caller must return to login (`meansSessionInvalid`);
 * - `EXECUTION_IN_PROGRESS` → the same request is already running server-side: the caller
 *   should follow the run (`error.details` is not part of `ApiError`, so recovery uses
 *   `recoverRunByRequestId`);
 * - transport failure → ambiguous: the request may have been admitted, so the caller should
 *   attempt recovery instead of blindly resending.
 */
export async function sendChatMessage(input: {
  readonly service: CoreService;
  readonly token: string;
  readonly conversationId: string;
  readonly text: string;
  readonly assistantKey: AssistantKey;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}): Promise<SendMessageOutcome> {
  const response = await input.service.sendMessage(
    input.token,
    input.conversationId,
    {
      content: [{ type: "text", text: input.text }],
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      assistantKey: input.assistantKey,
    },
    { ...(input.signal ? { signal: input.signal } : {}) },
  );

  const status = response.execution.status;
  if (status !== "succeeded" && status !== "partial") {
    // `POST .../messages` only answers with a persisted reply; anything else is either a
    // replay of a terminal run or a contract violation. Never present it as an answer.
    throw new ApiError({
      kind: "invalid_response",
      message: `O servidor retornou uma execução em estado "${status}" sem resposta persistida.`,
    });
  }

  return {
    userMessage: response.inputMessage,
    assistantMessage: response.assistantMessage,
    run: response.execution,
    status,
  };
}

/**
 * Finds the run a `requestId` produced, using only persisted server state.
 *
 * `POST /v1/conversations/:id/messages` derives the run id from the conversation and the
 * idempotency key, so a lost response can be recovered by listing the conversation's runs
 * and matching `requestId` — no id is invented and no request is duplicated.
 */
export async function recoverRunByRequestId(input: {
  readonly service: CoreService;
  readonly token: string;
  readonly conversationId: string;
  readonly requestId: string;
  readonly signal?: AbortSignal;
}): Promise<CoreRun | null> {
  const runs = await input.service.listExecutions(input.token, input.conversationId, {
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const matches = runs.filter((run) => run.requestId === input.requestId);
  if (matches.length === 0) return null;
  // Newest first: the conversation may legitimately contain earlier runs.
  return matches.reduce((latest, run) => (run.createdAt > latest.createdAt ? run : latest));
}

/**
 * Cancel outcome. `EXECUTION_ALREADY_TERMINAL`/`EXECUTION_CANCELLED` are not failures from
 * the user's point of view: the run simply finished (or was already cancelled) first, and
 * the caller reloads the persisted state.
 */
export type CancelOutcome =
  | { readonly kind: "cancelled" }
  | { readonly kind: "already_terminal"; readonly message: string }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error"; readonly error: ApiError };

export async function cancelRun(input: {
  readonly service: CoreService;
  readonly token: string;
  readonly runId: string;
  readonly signal?: AbortSignal;
}): Promise<CancelOutcome> {
  try {
    await input.service.cancelExecution(input.token, input.runId, {
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return { kind: "cancelled" };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.meansSessionInvalid) return { kind: "unauthorized" };
      if (error.code === "EXECUTION_ALREADY_TERMINAL" || error.code === "EXECUTION_CANCELLED") {
        return { kind: "already_terminal", message: "A execução já havia terminado." };
      }
      if (error.code === "EXECUTION_NOT_FOUND") {
        return { kind: "already_terminal", message: "A execução não está mais disponível." };
      }
      return { kind: "error", error };
    }
    return {
      kind: "error",
      error: new ApiError({ kind: "network", message: "Não foi possível cancelar a execução." }),
    };
  }
}
