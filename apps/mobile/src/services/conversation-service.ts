import {
  coreExecutionErrorCodeSchema,
  type Conversation,
  type CoreRun,
  type Message,
} from "@nexus/shared";
import { ApiError } from "./api-client.js";
import type { CoreService } from "./core-service.js";
import { getConversationAssistants, type AssistantOption } from "../lib/assistants.js";
import {
  cancelRun,
  followExecution,
  isTerminalRunStatus,
  messageText,
  recoverRunByRequestId,
  sendChatMessage,
  type CancelOutcome,
  type FollowOptions,
  type FollowOutcome,
} from "./execution-service.js";

/**
 * Conversation orchestration shared by the home and chat screens.
 *
 * Division of responsibility:
 * - the server is the only source of truth for conversations, messages and runs;
 * - this module loads/refreshes that state and turns failures into stable, user-facing text;
 * - the screens hold render state only and never call `fetch` themselves.
 */

/** True when a code is one the CORE is allowed to answer with. */
export function isCoreErrorCode(code: string | null): boolean {
  if (!code) return false;
  return coreExecutionErrorCodeSchema.safeParse(code).success;
}

/**
 * Messages shown for CORE failures.
 *
 * Each entry explains what happened without exposing internals and without implying the
 * message was delivered when the server did not confirm it.
 */
const CORE_ERROR_MESSAGES: Record<string, string> = {
  CORE_NOT_CONFIGURED:
    "O NEXUS CORE não está configurado no servidor. Nenhuma mensagem foi processada.",
  CONVERSATION_NOT_FOUND: "Esta conversa não existe mais ou não pertence a você.",
  CONVERSATION_INACTIVE: "Esta conversa não está ativa e não aceita novas mensagens.",
  EXECUTION_NOT_FOUND: "A execução não foi encontrada no servidor.",
  ASSISTANT_NOT_FOUND: "O assistente selecionado não existe no catálogo do servidor.",
  ASSISTANT_NOT_IN_CONVERSATION:
    "O assistente selecionado não participa desta conversa. Escolha outro assistente.",
  EXECUTION_IN_PROGRESS: "Já existe uma execução em andamento para esta mensagem.",
  EXECUTION_ALREADY_TERMINAL: "A execução já havia terminado.",
  EXECUTION_CANCELLED: "A execução foi cancelada e não gerou resposta.",
  IDEMPOTENCY_CONFLICT:
    "Esta mensagem entrou em conflito com um envio anterior. Reenvie como uma nova mensagem.",
  CONTEXT_LIMIT_EXCEEDED:
    "A conversa excedeu o limite de contexto do modelo. Inicie uma nova conversa.",
  INVALID_DELEGATION_CONTRACT: "O CORE recusou o plano de delegação desta execução.",
  DELEGATION_NOT_ALLOWED: "O CORE recusou uma delegação não autorizada.",
  DELEGATION_CYCLE_DETECTED: "O CORE detectou um ciclo de delegação e interrompeu a execução.",
  DELEGATION_DEPTH_EXCEEDED:
    "O CORE interrompeu a execução por excesso de profundidade de delegação.",
  DELEGATION_LIMIT_EXCEEDED: "O CORE interrompeu a execução por excesso de delegações.",
  DELEGATED_EXECUTION_FAILED: "Todas as execuções delegadas falharam. Nenhuma resposta foi gerada.",
  EMPTY_MODEL_RESPONSE: "O modelo não produziu resposta. Nenhuma mensagem foi criada.",
  PERSISTENCE_FAILED:
    "O servidor não conseguiu persistir a mensagem. Nada foi confirmado — tente novamente.",
  RATE_LIMITED: "O servidor limitou a taxa de requisições. Aguarde e tente novamente.",
};

const PROVIDER_PREFIX = "PROVIDER_";

/**
 * Converts any thrown value into text that can be shown to the user.
 *
 * Contract messages are reused only for codes the app recognises; otherwise a generic,
 * actionable sentence is returned. Tokens and internal details are never rendered.
 */
export function describeApiError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "Ocorreu um erro inesperado. Tente novamente.";
  }

  if (
    error.kind === "network" ||
    error.kind === "not_configured" ||
    error.kind === "invalid_response"
  ) {
    return error.message;
  }

  const code = error.code;
  if (code && CORE_ERROR_MESSAGES[code]) return CORE_ERROR_MESSAGES[code];
  if (code && code.startsWith(PROVIDER_PREFIX)) {
    return "O provedor de IA não conseguiu concluir esta execução. Nenhuma resposta foi gerada.";
  }
  if (error.status === 401) {
    return "Sua sessão expirou. Entre novamente.";
  }
  if (error.status === 429) {
    return "Muitas requisições em pouco tempo. Aguarde e tente novamente.";
  }
  if (error.status === 503) {
    return "O serviço está temporariamente indisponível. Tente novamente em instantes.";
  }
  if (error.status !== null && error.status >= 500) {
    return "O servidor encontrou um erro. Tente novamente em instantes.";
  }
  return error.message;
}

/** True when the failure means the stored session is no longer usable. */
export function meansSignedOut(error: unknown): boolean {
  return error instanceof ApiError && error.meansSessionInvalid;
}

/** Identifies a conversation in listings when the server stored no title. */
export function conversationLabel(conversation: Conversation): string {
  if (conversation.title && conversation.title.trim().length > 0) return conversation.title;
  return "Conversa sem título";
}

/**
 * Assistant names for a conversation listing.
 *
 * Uses the frozen catalog; ids unknown to this build are reported as a count instead of
 * being silently dropped.
 */
export function conversationAssistantLabel(conversation: Conversation): string {
  const known = getConversationAssistants(conversation.assistantIds);
  if (known.length === 0) {
    return conversation.assistantIds.length === 0
      ? "Sem assistente definido"
      : `${conversation.assistantIds.length} assistente(s)`;
  }
  return known.map((assistant) => assistant.name).join(" · ");
}

function formatTimestamp(iso: string): string | null {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return null;
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toISOString();
  }
}

/** Timestamp shown under a conversation (`updatedAt`), or `null` when unparseable. */
export function conversationTimestampLabel(conversation: Conversation): string | null {
  return formatTimestamp(conversation.updatedAt);
}

/** Timestamp shown next to a message (`createdAt`), or `null` when unparseable. */
export function messageTimestampLabel(message: Message): string | null {
  return formatTimestamp(message.createdAt);
}

export interface ConversationsSnapshot {
  readonly conversations: readonly Conversation[];
  /** `true` when the last successful load returned no conversations. */
  readonly isEmpty: boolean;
}

/** Result of a load attempt: either data or a message already safe to render. */
export type LoadResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly message: string; readonly signedOut: boolean };

/** A send attempt being tracked by the UI; stable across retries of this message. */
export interface PendingSend {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly assistantKey: AssistantOption["key"];
  readonly text: string;
}

export type SendResult =
  /**
   * The server persisted the user message and a reply.
   *
   * `messages` is the reloaded authoritative history, or `null` when that reload failed —
   * in which case `persisted` still carries the two messages the server itself returned, so
   * the screen never has to guess or lose them.
   */
  | {
      readonly kind: "delivered";
      readonly status: "succeeded" | "partial";
      readonly messages: readonly Message[] | null;
      readonly persisted: { readonly user: Message; readonly assistant: Message };
      readonly run: CoreRun;
    }
  /** The run failed and no answer exists; the history is reloaded when possible. */
  | {
      readonly kind: "failed";
      readonly message: string;
      readonly messages: readonly Message[] | null;
      readonly runId: string | null;
    }
  /** The run was cancelled; no answer will exist. */
  | {
      readonly kind: "cancelled";
      readonly messages: readonly Message[] | null;
      readonly runId: string | null;
    }
  /** The outcome could not be confirmed; the caller keeps a pending state and offers reload. */
  | { readonly kind: "unknown"; readonly message: string; readonly runId: string | null }
  /** `401`: the app must return to login. */
  | { readonly kind: "signed_out" }
  /** Rejected with a definitive error; nothing was persisted by this attempt. */
  | { readonly kind: "rejected"; readonly message: string };

export interface FollowResult {
  readonly outcome: FollowOutcome;
  /** Persisted messages when the run reached a terminal state, `null` otherwise. */
  readonly messages: readonly Message[] | null;
}

export interface ChatSession {
  send(
    pending: PendingSend,
    options?: { signal?: AbortSignal; followOptions?: FollowOptions },
  ): Promise<SendResult>;
  cancel(runId: string, options?: { signal?: AbortSignal }): Promise<CancelOutcome>;
  /** Follows a run and reloads the history once it reaches a terminal state. */
  follow(runId: string, options?: FollowOptions): Promise<FollowResult>;
  /**
   * Non-terminal executions of this conversation, in the server's own order.
   *
   * Used to recover a run that was admitted before the screen unmounted (user left the chat
   * or the app was suspended). Filtering uses `runStatusSchema` through
   * `isTerminalRunStatus`, so no new state vocabulary is introduced.
   *
   * Returns a `LoadResult` so a `401` reaches the session layer instead of looking like an
   * empty list.
   */
  activeRuns(options?: { signal?: AbortSignal }): Promise<LoadResult<readonly CoreRun[]>>;
  /**
   * Discovers the run id of a message that is still being sent.
   *
   * `POST .../messages` only answers when the execution finishes, so the id needed by
   * `POST /v1/executions/:runId/cancel` is not available while it runs. This polls the
   * conversation's persisted runs and matches `requestId` — the server's own correlation
   * id — using `GET /v1/conversations/:id/executions`. No id is derived client-side.
   *
   * The loop is bounded by the **lifetime of the send**, not by a fixed attempt count:
   * it runs while `signal` is live and stops the moment the caller aborts it (send settled,
   * unmount, conversation change, session expired). One probe at a time, never concurrent.
   *
   * Returns:
   * - `found` with the server's run as soon as `requestId` matches;
   * - `aborted` when the caller aborted — never a statement about the run;
   * - `unavailable` when the state could not be read (repeated transport failures, `401`) or
   *   when the successful probes exhausted `DISCOVERY_SAFETY_PROBE_CAP` with no match.
   *   Only successful, non-matching probes count; a slow provider queue is still discovered.
   */
  findRun(requestId: string, options?: DiscoveryOptions): Promise<DiscoveryResult>;
}

export interface DiscoveryOptions {
  readonly signal?: AbortSignal;
  readonly scheduler?: (callback: () => void, delayMs: number) => void;
  /** Test hook: stop after N successful probes (production leaves this unset). */
  readonly maxAttempts?: number;
  /** Consecutive failed probes tolerated before giving up. */
  readonly maxTransientFailures?: number;
  /** Called after every probe that found persisted runs, so the UI can reflect progress. */
  readonly onProbe?: (runs: readonly CoreRun[]) => void;
}

/**
 * Outcome of discovery. The distinction matters: only `aborted` means "we stopped asking",
 * every other kind is a statement about the server's state.
 */
export type DiscoveryResult =
  /** The server persisted the run; the id is authoritative. */
  | { readonly kind: "found"; readonly run: CoreRun }
  /** The caller aborted (send settled / unmount). No conclusion about the run. */
  | { readonly kind: "aborted" }
  /** Probing failed repeatedly; the run may still exist server-side. */
  | { readonly kind: "unavailable"; readonly message: string };

/**
 * Successful probes performed before giving up on a run the server never recorded, when the
 * caller provides no lifetime signal to bound the loop.
 *
 * This is the conservative fallback: a standalone caller that cannot tell when the send
 * settles would otherwise probe forever.
 */
export const DEFAULT_DISCOVERY_ATTEMPTS = 8;

/**
 * Hard safety ceiling applied while the send is still pending.
 *
 * Discovery is bounded by the *send lifetime* (the `AbortSignal` the caller passes), which is
 * the only thing that actually knows when probing stopped being useful. This cap exists only
 * so a caller that never aborts cannot turn a capped backoff into an endless loop: at the
 * steady-state 3 s interval it allows ~12 minutes of probing, longer than a full provider
 * execution plus queueing, and it is never the reason a live execution goes untracked.
 */
export const DISCOVERY_SAFETY_PROBE_CAP = 240;

/** Consecutive failed probes (network/5xx) tolerated while the send is still pending. */
export const DEFAULT_DISCOVERY_TRANSIENT_FAILURES = 5;

/**
 * Backoff for discovery probes: fast at first (the CORE persists the run before calling the
 * provider), then a slow steady state so a long execution costs ~1 request every 3 s.
 */
export const DISCOVERY_DELAYS_MS: readonly number[] = [
  400, 800, 1_200, 1_600, 2_000, 2_500, 3_000,
];

export function discoveryDelayFor(attempt: number): number {
  const index = Math.min(Math.max(attempt, 0), DISCOVERY_DELAYS_MS.length - 1);
  return DISCOVERY_DELAYS_MS[index]!;
}

export interface ConversationService {
  list(options?: { signal?: AbortSignal }): Promise<LoadResult<ConversationsSnapshot>>;
  get(
    conversationId: string,
    options?: { signal?: AbortSignal },
  ): Promise<LoadResult<Conversation>>;
  create(
    input: { assistant: AssistantOption; title?: string },
    options?: { signal?: AbortSignal },
  ): Promise<LoadResult<Conversation>>;
  history(
    conversationId: string,
    options?: { signal?: AbortSignal },
  ): Promise<LoadResult<readonly Message[]>>;
  /** Chat state for one conversation: send, follow and cancel. */
  chat(conversationId: string): ChatSession;
}

export function createConversationService(input: {
  readonly service: CoreService;
  readonly token: string;
}): ConversationService {
  const { service, token } = input;

  async function historyOf(
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<readonly Message[]> {
    return service.listMessages(token, conversationId, {
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Waits between discovery probes, waking up immediately on abort.
   *
   * Resolves `true` when the full delay elapsed, `false` when the caller aborted. The timer
   * and the `abort` listener are always released, so an unmounted screen leaves nothing
   * behind (no dangling timer, no retained listener on a long-lived signal).
   */
  function waitForDelay(delayMs: number, options: DiscoveryOptions): Promise<boolean> {
    const signal = options.signal;
    if (signal?.aborted) return Promise.resolve(false);

    if (options.scheduler) {
      // The scheduler only invokes the callback; the abort check happens after it fires so a
      // test scheduler cannot outlive an aborted discovery.
      return new Promise<void>((resolve) => {
        options.scheduler!(() => resolve(), delayMs);
      }).then(() => !signal?.aborted);
    }

    return new Promise<boolean>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(true);
      }, delayMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  function wrap<T>(thunk: () => Promise<T>): Promise<LoadResult<T>> {
    return thunk().then(
      (data) => ({ ok: true as const, data }),
      (error: unknown) => ({
        ok: false as const,
        message: describeApiError(error),
        signedOut: meansSignedOut(error),
      }),
    );
  }

  /**
   * History reload used after a send.
   *
   * Returns `null` when the reload fails, so the caller keeps whatever it already renders
   * instead of replacing real messages with an empty list.
   */
  async function historyOrNull(
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<readonly Message[] | null> {
    try {
      return await historyOf(conversationId, signal);
    } catch {
      return null;
    }
  }

  /**
   * Maps a terminal follow outcome to a `SendResult`, reloading the persisted history.
   */
  async function settle(
    followed: FollowOutcome,
    conversationId: string,
    runId: string | null,
    signal?: AbortSignal,
  ): Promise<SendResult> {
    switch (followed.kind) {
      case "succeeded":
      case "partial": {
        // The run is confirmed by the server, but the reply must be read from the
        // persisted history — the inspection endpoint carries no message bodies.
        const messages = await historyOrNull(conversationId, signal);
        if (!messages) {
          return {
            kind: "unknown",
            message:
              "O NEXUS CORE concluiu a execução, mas o histórico não pôde ser carregado. " +
              "Atualize a conversa para ver a resposta persistida.",
            runId,
          };
        }
        const user = messages.find((message) => message.id === followed.run.inputMessageId);
        const assistant = followed.run.finalMessageId
          ? messages.find((message) => message.id === followed.run.finalMessageId)
          : undefined;
        if (!user || !assistant) {
          return {
            kind: "unknown",
            message:
              "A execução foi concluída, mas as mensagens persistidas não foram encontradas. " +
              "Atualize a conversa para ver o estado real.",
            runId,
          };
        }
        return {
          kind: "delivered",
          status: followed.kind,
          messages,
          persisted: { user, assistant },
          run: followed.run,
        };
      }
      case "failed": {
        const messages = await historyOrNull(conversationId, signal);
        return { kind: "failed", message: followed.message, messages, runId };
      }
      case "cancelled": {
        const messages = await historyOrNull(conversationId, signal);
        return { kind: "cancelled", messages, runId };
      }
      case "unauthorized":
        return { kind: "signed_out" };
      case "aborted":
        return {
          kind: "unknown",
          message: "O envio foi interrompido. Reabra a conversa para ver o estado persistido.",
          runId,
        };
      case "unknown":
        return { kind: "unknown", message: followed.error.message, runId };
      default:
        return { kind: "unknown", message: "Estado de execução desconhecido.", runId };
    }
  }

  /**
   * Turns a failed `POST .../messages` into a trustworthy outcome.
   *
   * `EXECUTION_IN_PROGRESS`, `PERSISTENCE_FAILED` and transport failures are ambiguous: the
   * server may have admitted (or even finished) the run. The persisted run list is then
   * consulted by `requestId` and, if found, the run is followed instead of resent — same
   * idempotency key, no duplicate message.
   */
  async function recoverAfterFailure(
    conversationId: string,
    error: unknown,
    pending: PendingSend,
    options: { signal?: AbortSignal; followOptions?: FollowOptions },
  ): Promise<SendResult> {
    if (meansSignedOut(error)) return { kind: "signed_out" };

    const ambiguous =
      error instanceof ApiError &&
      (error.kind === "network" ||
        error.code === "EXECUTION_IN_PROGRESS" ||
        error.code === "PERSISTENCE_FAILED");

    if (!ambiguous) {
      return { kind: "rejected", message: describeApiError(error) };
    }

    let run: CoreRun | null;
    try {
      run = await recoverRunByRequestId({
        service,
        token,
        conversationId,
        requestId: pending.requestId,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (recoveryError) {
      if (meansSignedOut(recoveryError)) return { kind: "signed_out" };
      return {
        kind: "unknown",
        message:
          "A conexão falhou durante o envio e não foi possível confirmar o estado no servidor. " +
          "Reabra a conversa antes de reenviar.",
        runId: null,
      };
    }

    if (!run) {
      return {
        kind: "rejected",
        message: "A mensagem não foi enviada ao servidor. Verifique a conexão e tente novamente.",
      };
    }

    const followed = await followExecution({
      service,
      token,
      runId: run.id,
      options: {
        ...options.followOptions,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    });

    return settle(followed, conversationId, run.id, options.signal);
  }

  return {
    list(options = {}) {
      return wrap(async () => {
        const conversations = await service.listConversations(token, {
          ...(options.signal ? { signal: options.signal } : {}),
        });
        return { conversations, isEmpty: conversations.length === 0 };
      });
    },

    get(conversationId, options = {}) {
      return wrap(() =>
        service.getConversation(token, conversationId, {
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      );
    },

    create(payload, options = {}) {
      return wrap(() =>
        service.createConversation(
          token,
          {
            assistantIds: [payload.assistant.id],
            ...(payload.title ? { title: payload.title } : {}),
          },
          { ...(options.signal ? { signal: options.signal } : {}) },
        ),
      );
    },

    history(conversationId, options = {}) {
      return wrap(() => historyOf(conversationId, options.signal));
    },

    chat(conversationId): ChatSession {
      return {
        async send(pending, options = {}) {
          let outcome;
          try {
            outcome = await sendChatMessage({
              service,
              token,
              conversationId,
              text: pending.text,
              assistantKey: pending.assistantKey,
              requestId: pending.requestId,
              idempotencyKey: pending.idempotencyKey,
              ...(options.signal ? { signal: options.signal } : {}),
            });
          } catch (error) {
            return recoverAfterFailure(conversationId, error, pending, options);
          }

          // Authoritative reload: the screen renders only what the server persisted.
          const messages = await historyOrNull(conversationId, options.signal);
          return {
            kind: "delivered",
            status: outcome.status,
            messages,
            persisted: { user: outcome.userMessage, assistant: outcome.assistantMessage },
            run: outcome.run,
          };
        },

        async cancel(runId, options = {}) {
          return cancelRun({
            service,
            token,
            runId,
            ...(options.signal ? { signal: options.signal } : {}),
          });
        },

        async findRun(requestId, options = {}) {
          // With a lifetime signal the loop is bounded by the send itself; without one, fall
          // back to the conservative attempt budget. Either way a hard safety cap applies.
          const maxAttempts =
            options.maxAttempts ??
            (options.signal ? DISCOVERY_SAFETY_PROBE_CAP : DEFAULT_DISCOVERY_ATTEMPTS);
          const maxTransientFailures =
            options.maxTransientFailures ?? DEFAULT_DISCOVERY_TRANSIENT_FAILURES;

          let probes = 0;
          let transientFailures = 0;
          let attempt = 0;

          // One probe at a time (awaited), so a slow request can never stack duplicates.
          while (true) {
            if (options.signal?.aborted) return { kind: "aborted" };

            let runs: readonly CoreRun[] | null = null;
            try {
              runs = await service.listExecutions(token, conversationId, {
                ...(options.signal ? { signal: options.signal } : {}),
              });
              transientFailures = 0;
              probes += 1;
            } catch (error) {
              // Abort looks exactly like a transport failure at this level; never report an
              // aborted local request as "the run is gone".
              if (options.signal?.aborted) return { kind: "aborted" };
              if (error instanceof ApiError && error.meansSessionInvalid) {
                return { kind: "unavailable", message: describeApiError(error) };
              }
              transientFailures += 1;
              if (transientFailures > maxTransientFailures) {
                return {
                  kind: "unavailable",
                  message:
                    "Não foi possível consultar o estado da execução no servidor. " +
                    "Atualize a conversa para conferir o resultado.",
                };
              }
            }

            if (runs) {
              options.onProbe?.(runs);
              // Match by the server's own correlation id; nothing is derived locally.
              const match = runs.find((run) => run.requestId === requestId);
              if (match) return { kind: "found", run: match };
              if (probes >= maxAttempts) {
                return {
                  kind: "unavailable",
                  message:
                    "O servidor não registrou uma execução para esta mensagem. " +
                    "Atualize a conversa para conferir o resultado antes de reenviar.",
                };
              }
            }

            const waited = await waitForDelay(discoveryDelayFor(attempt), options);
            if (!waited) return { kind: "aborted" };
            attempt += 1;
          }
        },

        async activeRuns(options = {}) {
          const result = await wrap(() =>
            service.listExecutions(token, conversationId, {
              ...(options.signal ? { signal: options.signal } : {}),
            }),
          );
          if (!result.ok) return result;
          return {
            ok: true,
            data: result.data.filter((run) => !isTerminalRunStatus(run.status)),
          };
        },

        async follow(runId, options = {}) {
          const outcome = await followExecution({ service, token, runId, options });
          if (
            outcome.kind === "succeeded" ||
            outcome.kind === "partial" ||
            outcome.kind === "failed" ||
            outcome.kind === "cancelled"
          ) {
            return {
              outcome,
              messages: await historyOrNull(conversationId, options.signal),
            };
          }
          return { outcome, messages: null };
        },
      };
    },
  };
}

export { messageText };
export type { CancelOutcome, FollowOptions, FollowOutcome };
