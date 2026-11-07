import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation, CoreRun, Message, RunStatus } from "@nexus/shared";
import { getConversationAssistants, type AssistantOption } from "../lib/assistants.js";
import { createIdempotencyKey, createUuid } from "../lib/ids.js";
import type {
  ChatSession,
  ConversationService,
  PendingSend,
  SendResult,
} from "../services/conversation-service.js";
import {
  conversationAssistantLabel,
  conversationLabel,
  describeApiError,
} from "../services/conversation-service.js";
import { describeRunStatus, isTerminalRunStatus } from "../services/execution-service.js";
import { MessageBubble } from "../components/MessageBubble.js";
import { ChatComposer } from "../components/ChatComposer.js";

export interface ChatScreenProps {
  readonly conversation: Conversation;
  readonly service: ConversationService;
  readonly onBack: () => void;
  /** Called when the session is no longer valid so the app returns to login. */
  readonly onSessionExpired: () => void;
  /** Test hook: replaces timers used by polling and discovery. */
  readonly scheduler?: (callback: () => void, delayMs: number) => void;
}

/**
 * The single execution the screen is currently tracking.
 *
 * `runId` is `null` until the server has actually persisted the run — the screen never
 * derives or invents one. `origin` states **why** we are tracking it, which decides whether
 * a terminal state also implies a "send finished" outcome.
 */
type ActiveExecution = {
  /** Server-assigned run id, or `null` while discovery has not succeeded yet. */
  readonly runId: string | null;
  /** `requestId` of the send, kept for discovery and recovery correlation. */
  readonly requestId: string;
  /** `sent`: this screen performed the POST. `recovered`: found after reopening. */
  readonly origin: "sent" | "recovered";
  /** Last observed server state, or `null` before the first inspection. */
  readonly status: RunStatus | null;
  /** Message of the last failed inspection, when the state could not be read. */
  readonly failureMessage: string | null;
};

/** Result of the one-shot check for executions left running by a previous visit. */
type RecoveryPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "checking" }
  | { readonly kind: "checked" }
  | { readonly kind: "unconfirmed"; readonly message: string };

/** Distance from the bottom (px) still treated as "following the conversation". */
const STICKY_THRESHOLD_PX = 96;

/** Copy for terminal states, always without inventing an answer. */
function terminalMessage(status: RunStatus): string | null {
  switch (status) {
    case "failed":
      return "A execução falhou no servidor. Nenhuma resposta foi gerada.";
    case "cancelled":
      return "A execução foi cancelada. Nenhuma resposta foi gerada.";
    default:
      return null;
  }
}

/**
 * Chronological chat backed by the persisted CORE state.
 *
 * Source of truth: `GET /v1/conversations/:id/messages`. The screen keeps a copy for
 * rendering, and every mutation goes through the server before being drawn:
 * - optimistic user bubbles are **not** used; a message appears once the server returns it;
 * - after a send (or after following a recovered run) the history is reloaded, so the reply
 *   shown is always a persisted `Message`;
 * - `failed`/`cancelled` render an explicit state block instead of a fake answer.
 *
 * Two distinct lifecycles run here, never more than one of each at a time:
 * 1. **send** — one `POST .../messages` in flight, plus discovery of its `runId` by
 *    `requestId`. Discovery is aborted the moment the send settles.
 * 2. **tracking** — one polling loop over `GET /v1/executions/:runId`, started either when
 *    discovery finds the run or when reopening the conversation finds a non-terminal one.
 */
export function ChatScreen({
  conversation,
  service,
  onBack,
  onSessionExpired,
  scheduler,
}: ChatScreenProps) {
  const [messages, setMessages] = useState<readonly Message[]>([]);
  const [historyState, setHistoryState] = useState<"loading" | "ready" | "error">("loading");
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState<PendingSend | null>(null);
  const [execution, setExecution] = useState<ActiveExecution | null>(null);
  const [recovery, setRecovery] = useState<RecoveryPhase>({ kind: "idle" });
  /** Terminal-but-answerless outcome to show (failed/cancelled/unknown). */
  const [notice, setNotice] = useState<string | null>(null);
  /** `true` while `POST /v1/executions/:runId/cancel` is in flight (button lock). */
  const [cancelling, setCancelling] = useState(false);

  const assistants = useMemo(
    () => getConversationAssistants(conversation.assistantIds),
    [conversation.assistantIds],
  );
  const [selectedAssistant, setSelectedAssistant] = useState<AssistantOption | null>(
    () => assistants[0] ?? null,
  );

  const chat = useMemo<ChatSession>(
    () => service.chat(conversation.id),
    // The conversation id is part of the dependency set so switching conversations rebuilds
    // the session and every loop; nothing from the previous conversation survives.
    [service, conversation.id],
  );

  const mounted = useRef(true);
  /** Conversation this screen instance belongs to; guards against late responses from another. */
  const conversationIdRef = useRef(conversation.id);
  const sendAbort = useRef<AbortController | null>(null);
  const discoveryAbort = useRef<AbortController | null>(null);
  const trackingAbort = useRef<AbortController | null>(null);
  const historyAbort = useRef<AbortController | null>(null);
  const recoveryAbort = useRef<AbortController | null>(null);
  const cancelAbort = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  /** True while the user is at (or near) the bottom; controls auto-scroll. */
  const stickToBottom = useRef(true);
  /** The user scrolled up: new content must not yank the view. */
  const userScrolledAway = useRef(false);

  const stopTracking = useCallback(() => {
    trackingAbort.current?.abort();
    trackingAbort.current = null;
  }, []);

  useEffect(() => {
    mounted.current = true;
    conversationIdRef.current = conversation.id;
    return () => {
      mounted.current = false;
      // Every loop and request owned by this screen dies here: no timer, no listener, no
      // setState after unmount, and no tracking left running for a screen nobody sees.
      sendAbort.current?.abort();
      discoveryAbort.current?.abort();
      trackingAbort.current?.abort();
      historyAbort.current?.abort();
      recoveryAbort.current?.abort();
      cancelAbort.current?.abort();
      sendAbort.current = null;
      discoveryAbort.current = null;
      trackingAbort.current = null;
      historyAbort.current = null;
      recoveryAbort.current = null;
      cancelAbort.current = null;
    };
  }, [conversation.id]);

  const applyMessages = useCallback((next: readonly Message[] | null) => {
    if (next) setMessages(next);
  }, []);

  // ---------------------------------------------------------------- history load
  const loadHistory = useCallback(
    async (mode: "initial" | "refresh") => {
      if (mode === "initial") {
        setHistoryState("loading");
        setHistoryError(null);
      }

      historyAbort.current?.abort();
      const controller = new AbortController();
      historyAbort.current = controller;

      const result = await service.history(conversation.id, { signal: controller.signal });
      if (!mounted.current || conversationIdRef.current !== conversation.id) return;
      if (result.ok) {
        setMessages(result.data);
        setHistoryState("ready");
        setHistoryError(null);
        return;
      }
      if (result.signedOut) {
        onSessionExpired();
        return;
      }
      // A refresh failure keeps the messages already on screen; only the notice changes.
      setHistoryError(result.message);
      if (mode === "initial") setHistoryState("error");
    },
    [service, conversation.id, onSessionExpired],
  );

  // ------------------------------------------------------------------ auto-scroll
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const list = listRef.current;
    if (!list) return;
    // `scrollTop` on the list itself keeps page-level scrolling (Android keyboard resize)
    // untouched: only the message viewport moves.
    list.scrollTo({ top: list.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    if (userScrolledAway.current) return;
    scrollToBottom(historyState === "ready" ? "smooth" : "auto");
  }, [messages, sending, execution, historyState, scrollToBottom]);

  function handleScroll() {
    const list = listRef.current;
    if (!list) return;
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    const atBottom = distanceFromBottom <= STICKY_THRESHOLD_PX;
    stickToBottom.current = atBottom;
    userScrolledAway.current = !atBottom;
  }

  // --------------------------------------------------------------------- tracking
  /**
   * Follows one run until it reaches a terminal state.
   *
   * Exactly one loop at a time: starting a new one aborts the previous controller. Every
   * `setState` is guarded by `mounted` **and** by the conversation id, so a late response can
   * never overwrite another conversation's screen.
   */
  const trackRun = useCallback(
    async (runId: string, origin: ActiveExecution["origin"]) => {
      stopTracking();
      const controller = new AbortController();
      trackingAbort.current = controller;

      const followOptions = {
        signal: controller.signal,
        onProgress: (run: CoreRun) => {
          if (!mounted.current || conversationIdRef.current !== conversation.id) return;
          if (trackingAbort.current !== controller) return;
          setExecution((current) =>
            current && current.runId === runId
              ? { ...current, status: run.status, failureMessage: null }
              : current,
          );
        },
        ...(scheduler ? { scheduler } : {}),
      };

      const result = await chat.follow(runId, followOptions);
      if (!mounted.current || conversationIdRef.current !== conversation.id) return;
      if (trackingAbort.current !== controller) return;
      trackingAbort.current = null;

      const outcome = result.outcome;
      if (outcome.kind === "unauthorized") {
        onSessionExpired();
        return;
      }
      if (outcome.kind === "aborted") {
        // Our own abort (unmount / new conversation). Nothing to report: this screen is gone
        // or replaced, and the run keeps existing server-side for the next visit.
        return;
      }

      if (outcome.kind === "unknown") {
        // Honest statement: the run may still be finishing server-side. Keep a retry action
        // but never claim the message was or was not delivered.
        setExecution((current) =>
          current && current.runId === runId
            ? { ...current, failureMessage: outcome.error.message }
            : current,
        );
        return;
      }

      // Terminal: reload the persisted history before clearing the processing indicator.
      applyMessages(result.messages);
      setExecution(null);
      const message = terminalMessage(outcome.run.status);
      if (message) setNotice(message);
      if (origin === "sent") {
        // The send and the tracked run are the same operation: settle the composer too.
        setSending(null);
      }
    },
    [applyMessages, chat, conversation.id, onSessionExpired, scheduler, stopTracking],
  );

  // -------------------------------------------------------------------- recovery
  /**
   * Recovers executions that were admitted before this screen existed.
   *
   * Scenario: the user sent a message, the provider was still working, and the user left the
   * chat (or the app was suspended) — so the local request was aborted but the server kept
   * running. On mount the conversation's persisted runs are listed; a non-terminal run means
   * the message is still being processed, and tracking resumes without sending anything.
   *
   * Contract notes:
   * - no new endpoint: `GET /v1/conversations/:id/executions` already returns the runs;
   * - ambiguous case (several non-terminal runs) is **not** guessed: the oldest non-terminal
   *   run is followed (the server's own `createdAt ASC` order) and the screen states how many
   *   are active, because the contract provides no further disambiguation;
   * - nothing is re-posted: recovery only reads and watches.
   */
  const recoverRunningExecution = useCallback(
    async (hasMessages: boolean) => {
      if (!hasMessages) {
        setRecovery({ kind: "checked" });
        return;
      }
      setRecovery({ kind: "checking" });

      recoveryAbort.current?.abort();
      const controller = new AbortController();
      recoveryAbort.current = controller;

      const result = await chat.activeRuns({ signal: controller.signal });
      if (!mounted.current || conversationIdRef.current !== conversation.id) return;
      if (recoveryAbort.current !== controller) return;
      recoveryAbort.current = null;

      if (!result.ok) {
        if (result.signedOut) {
          onSessionExpired();
          return;
        }
        setRecovery({ kind: "unconfirmed", message: result.message });
        return;
      }

      setRecovery({ kind: "checked" });
      const active = result.data;
      if (active.length === 0) return;

      // Oldest first, per the server's ordering; never an arbitrary pick and never a merge of
      // two executions into one state.
      const run = active[0]!;
      const runId = run.id;
      setSending(null);
      setNotice(null);
      setExecution({
        runId,
        requestId: run.requestId,
        origin: "recovered",
        status: run.status,
        failureMessage: null,
      });
      await trackRun(runId, "recovered");
    },
    [chat, conversation.id, onSessionExpired, trackRun],
  );

  useEffect(() => {
    // Initial load, then recovery of anything the server is still running. `loadHistory`
    // reports whether the conversation actually has messages, so an empty conversation does
    // not spend an extra request.
    void loadHistory("initial").then(() => undefined);
  }, [loadHistory]);

  useEffect(() => {
    let cancelled = false;
    // Recovery runs once per mount and only after the history is known to be non-empty.
    if (historyState !== "ready") return;
    if (recovery.kind !== "idle") return;
    if (cancelled) return;
    void recoverRunningExecution(messages.length > 0);
    return () => {
      cancelled = true;
    };
    // `recovery.kind` is intentionally read, not listed: the effect must run once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyState, messages.length]);

  // -------------------------------------------------------------------- send flow
  /** Guards against double submission from double taps, Enter and the button together. */
  const submitLock = useRef(false);
  /** Guards against a second cancel request before React re-renders the disabled button. */
  const cancellingRef = useRef(false);

  const finishSend = useCallback(
    (result: SendResult) => {
      switch (result.kind) {
        case "delivered":
          applyMessages(result.messages);
          // `delivered` means the run reached `succeeded`/`partial`: there is nothing left to
          // track. Stopping here avoids two loops (send + discovery) racing over one run.
          stopTracking();
          setExecution(null);
          // The server persisted this exact draft (or its reply): the composer starts empty,
          // otherwise the next send would repeat the message the user just sent.
          setDraft("");
          setSending(null);
          setNotice(null);
          return;
        case "failed":
          applyMessages(result.messages);
          stopTracking();
          setDraft("");
          setSending(null);
          setExecution(null);
          setNotice(result.message);
          return;
        case "cancelled":
          applyMessages(result.messages);
          stopTracking();
          setDraft("");
          setSending(null);
          setExecution(null);
          return;
        case "unknown":
          // No history reload here: an unconfirmed outcome must not replace persisted
          // messages with a guess. The processing/tracking state stays as it was.
          setSending(null);
          setNotice(
            result.message ||
              "Não foi possível confirmar o envio. Reabra a conversa antes de reenviar.",
          );
          return;
        case "signed_out":
          onSessionExpired();
          return;
        case "rejected":
          stopTracking();
          setExecution(null);
          setSending(null);
          setNotice(result.message);
          return;
        default:
          return;
      }
    },
    [applyMessages, onSessionExpired, stopTracking],
  );

  const send = useCallback(
    async (pending: PendingSend) => {
      const controller = new AbortController();
      sendAbort.current = controller;
      const discovery = new AbortController();
      discoveryAbort.current = discovery;
      setSending(pending);
      setNotice(null);

      setExecution({
        runId: null,
        requestId: pending.requestId,
        origin: "sent",
        status: null,
        failureMessage: null,
      });

      // Discovery runs in parallel with the POST, bounded by the discovery controller: it
      // stops as soon as the send settles (below) or the screen unmounts. It runs for as long
      // as the send is pending — not for a fixed number of attempts — so a run queued behind a
      // slow provider is still found and stays cancellable.
      void chat
        .findRun(pending.requestId, {
          signal: discovery.signal,
          onProbe: (runs) => {
            if (!mounted.current || conversationIdRef.current !== conversation.id) return;
            if (discoveryAbort.current !== discovery) return;
            // Surface progress as soon as the server lists a run for this request.
            const match = runs.find((run) => run.requestId === pending.requestId);
            if (match && !isTerminalRunStatus(match.status)) {
              setExecution((current) =>
                current && current.requestId === pending.requestId
                  ? { ...current, runId: match.id, status: match.status }
                  : current,
              );
            }
          },
          ...(scheduler ? { scheduler } : {}),
        })
        .then((discoveryResult) => {
          if (!mounted.current || conversationIdRef.current !== conversation.id) return;
          if (discoveryAbort.current !== discovery) return;
          if (discoveryResult.kind === "aborted") return;
          if (discoveryResult.kind === "unavailable") {
            setExecution((current) =>
              current && current.requestId === pending.requestId
                ? { ...current, failureMessage: discoveryResult.message }
                : current,
            );
            return;
          }
          const run = discoveryResult.run;
          setExecution((current) =>
            current && current.requestId === pending.requestId
              ? { ...current, runId: run.id, status: run.status }
              : current,
          );
          if (!isTerminalRunStatus(run.status)) void trackRun(run.id, "sent");
        })
        .catch(() => undefined);

      const result = await chat.send(pending, {
        signal: controller.signal,
        ...(scheduler ? { followOptions: { scheduler } } : {}),
      });

      // The send settled: stop discovery immediately. Anything still needed is now a matter
      // of tracking the run the server already admitted.
      discovery.abort();
      if (discoveryAbort.current === discovery) discoveryAbort.current = null;

      if (!mounted.current || conversationIdRef.current !== conversation.id) return;
      if (sendAbort.current === controller) sendAbort.current = null;
      finishSend(result);
    },
    [chat, conversation.id, finishSend, scheduler, trackRun],
  );

  const handleSend = useCallback(() => {
    if (submitLock.current) return;
    // Only a POST still in flight blocks a new message. A run that is merely being tracked
    // (including one recovered from a previous visit) must never lock the composer: the
    // server accepts another message, and the user did not ask to wait.
    if (sending) return;
    const text = draft.trim();
    if (text.length === 0) return;
    if (!selectedAssistant) {
      setNotice("Esta conversa não possui um assistente do catálogo. Crie uma nova conversa.");
      return;
    }

    submitLock.current = true;
    // requestId + idempotencyKey are generated once per message and kept for every retry of
    // that same message, so a retried send can never create a duplicate in the CORE.
    const pending: PendingSend = {
      requestId: createUuid(),
      idempotencyKey: createIdempotencyKey("msg"),
      assistantKey: selectedAssistant.key,
      text,
    };
    void send(pending).finally(() => {
      submitLock.current = false;
    });
  }, [draft, execution, selectedAssistant, send, sending]);

  /**
   * Requests cancellation of the tracked run.
   *
   * Deliberately does **not** poll: a `trackRun`/`follow` loop may already own this run, and
   * two loops over the same execution would double the requests and could clear the other's
   * state. It only sends the cancel and lets the existing loop observe the terminal state.
   * When nothing is following (discovery succeeded but tracking never started), one follow is
   * performed to learn the outcome; that case cannot overlap an existing loop.
   */
  const handleCancel = useCallback(async () => {
    const runId = execution?.runId ?? null;
    if (!runId || cancellingRef.current) return;

    cancellingRef.current = true;
    setCancelling(true);
    // Decided **before** the request: if a loop is watching this run right now, that loop owns
    // the outcome. It may finish while the cancel is in flight, and re-reading the ref after
    // the await would then start a second loop over an already finished run.
    const ownedByLoop = trackingAbort.current !== null;
    const controller = new AbortController();
    cancelAbort.current = controller;

    try {
      const outcome = await chat.cancel(runId, { signal: controller.signal });
      if (!mounted.current || conversationIdRef.current !== conversation.id) return;
      if (cancelAbort.current !== controller) return;

      if (outcome.kind === "unauthorized") {
        onSessionExpired();
        return;
      }
      if (outcome.kind === "error") {
        // The cancel did not reach the server: the execution keeps running and the UI must
        // keep saying so. Nothing is cleared and no terminal state is invented.
        setNotice(describeApiError(outcome.error));
        return;
      }
      if (outcome.kind === "already_terminal") {
        // Nothing to cancel: the loop in flight will observe the real terminal state.
        setNotice(outcome.message);
        return;
      }

      // Cancellation accepted. A live loop sees `cancelled` on its next probe; only the orphan
      // case (nothing was watching this run) needs one follow to publish the outcome.
      if (!ownedByLoop) {
        const result = await chat.follow(runId, scheduler ? { scheduler } : {});
        if (!mounted.current || conversationIdRef.current !== conversation.id) return;
        if (result.outcome.kind === "unauthorized") {
          onSessionExpired();
          return;
        }
        applyMessages(result.messages);
        setExecution(null);
        setSending(null);
        setNotice(terminalMessage("cancelled"));
      }
    } finally {
      cancellingRef.current = false;
      if (mounted.current) setCancelling(false);
    }
  }, [applyMessages, chat, conversation.id, execution, onSessionExpired, scheduler]);

  /** Manual retry after a state that could not be confirmed. */
  const handleRetryTracking = useCallback(async () => {
    const runId = execution?.runId ?? null;
    setNotice(null);
    if (runId) {
      await trackRun(runId, execution?.origin ?? "recovered");
      return;
    }
    await loadHistory("refresh");
    await recoverRunningExecution(true);
  }, [execution, loadHistory, recoverRunningExecution, trackRun, ]);

  // ---------------------------------------------------------------- presentation
  const busy = sending !== null || (execution !== null && execution.origin === "sent");
  const empty = historyState === "ready" && messages.length === 0;
  const cancellable = execution?.runId ?? null;

  const processingLabel = !execution
    ? sending
      ? "Enviando ao NEXUS CORE…"
      : null
    : execution.status
      ? describeRunStatus({
          status: execution.status,
        } as CoreRun)
      : execution.runId
        ? "O NEXUS CORE está processando esta mensagem."
        : "Enviando ao NEXUS CORE…";

  const showProcessing = execution !== null || sending !== null;

  return (
    <main className="chat-screen">
      <header className="chat-header">
        <button type="button" className="link-button chat-back" onClick={onBack}>
          ← Conversas
        </button>
        <div className="chat-titles">
          <h1 className="chat-title">{conversationLabel(conversation)}</h1>
          <p className="chat-subtitle">{conversationAssistantLabel(conversation)}</p>
        </div>
        <button
          type="button"
          className="link-button"
          onClick={() => void loadHistory("refresh")}
          disabled={historyState === "loading"}
        >
          Atualizar
        </button>
      </header>

      <section
        className="chat-assistant"
        aria-labelledby="chat-assistant-title"
        hidden={assistants.length === 0}
      >
        <p id="chat-assistant-title" className="chat-assistant-label">
          Responder com
        </p>
        <div className="assistant-options" role="radiogroup" aria-labelledby="chat-assistant-title">
          {assistants.map((assistant) => {
            const selected = selectedAssistant?.key === assistant.key;
            return (
              <button
                key={assistant.key}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`assistant-option ${selected ? "assistant-option-selected" : ""}`}
                onClick={() => setSelectedAssistant(assistant)}
                disabled={busy}
              >
                {assistant.name}
              </button>
            );
          })}
        </div>
      </section>

      {historyState === "loading" ? (
        <p className="status chat-loading" role="status">
          <span className="spinner" aria-hidden="true" />
          Carregando histórico…
        </p>
      ) : null}

      {historyError ? (
        <p className="alert alert-error chat-alert" role="alert">
          {historyError}{" "}
          <button type="button" className="link-button" onClick={() => void loadHistory("refresh")}>
            Tentar novamente
          </button>
        </p>
      ) : null}

      {empty && !showProcessing ? (
        <p className="muted chat-empty">
          Nenhuma mensagem nesta conversa ainda. Envie a primeira para o NEXUS CORE.
        </p>
      ) : null}

      <ol
        className="chat-messages"
        ref={listRef}
        onScroll={handleScroll}
        aria-label="Histórico da conversa"
        data-testid="chat-messages"
      >
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        {showProcessing ? (
          <li className="bubble-row bubble-row-assistant" data-testid="chat-processing">
            <div className="bubble bubble-assistant bubble-pending">
              <p className="status">
                <span className="spinner" aria-hidden="true" />
                {processingLabel}
              </p>
              {execution?.origin === "recovered" ? (
                <p className="bubble-state">
                  Execução em andamento recuperada do servidor ao reabrir a conversa.
                </p>
              ) : null}
              {cancellable ? (
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => void handleCancel()}
                  disabled={cancelling}
                >
                  {cancelling ? "Cancelando…" : "Cancelar execução"}
                </button>
              ) : null}
            </div>
          </li>
        ) : null}
      </ol>

      {notice ? (
        <div className="alert alert-error chat-alert" role="alert">
          <p>{notice}</p>
          <button type="button" className="link-button" onClick={() => void handleRetryTracking()}>
            Atualizar estado
          </button>
        </div>
      ) : null}

      {recovery.kind === "unconfirmed" ? (
        <p className="alert alert-warning chat-alert" role="status">
          {recovery.message}{" "}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setRecovery({ kind: "idle" });
              void recoverRunningExecution(true);
            }}
          >
            Verificar novamente
          </button>
        </p>
      ) : null}

      <ChatComposer
        value={draft}
        onChange={setDraft}
        onSend={handleSend}
        disabled={busy}
        disabledReason={busy ? (processingLabel ?? undefined) : undefined}
      />
    </main>
  );
}
