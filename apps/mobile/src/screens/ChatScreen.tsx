import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation, CoreRun, Message } from "@nexus/shared";
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
import { describeRunStatus } from "../services/execution-service.js";
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

/** Phase of the send pipeline, mirrored in the UI without pretending success. */
type SendPhase =
  | { readonly kind: "idle" }
  /** Request in flight; the server has not confirmed anything yet. */
  | { readonly kind: "sending"; readonly pending: PendingSend }
  /** The run id is known and the CORE is working; the cancel action is available. */
  | { readonly kind: "processing"; readonly pending: PendingSend; readonly run: CoreRun }
  /** The send ended in a state the user must see (failure, ambiguity). */
  | { readonly kind: "error"; readonly message: string; readonly canRetry: boolean };

/** Distance from the bottom (px) still treated as "following the conversation". */
const STICKY_THRESHOLD_PX = 96;

/**
 * Chronological chat backed by the persisted CORE state.
 *
 * Source of truth: `GET /v1/conversations/:id/messages`. The screen keeps a copy for
 * rendering, and every mutation goes through the server before being drawn:
 * - optimistic user bubbles are **not** used; a message appears once the server returns it;
 * - after a send, the history is reloaded, so a reply typed nowhere by the client shows up;
 * - `failed`/`cancelled` runs render an explicit state block instead of a fake answer.
 *
 * Polling (execution tracking) is bounded, cancelled on unmount and stops on terminal states.
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
  const [phase, setPhase] = useState<SendPhase>({ kind: "idle" });
  const [draft, setDraft] = useState("");

  const assistants = useMemo(
    () => getConversationAssistants(conversation.assistantIds),
    [conversation.assistantIds],
  );
  const [selectedAssistant, setSelectedAssistant] = useState<AssistantOption | null>(
    () => assistants[0] ?? null,
  );

  const chat = useMemo<ChatSession>(() => service.chat(conversation.id), [service, conversation.id]);

  // One AbortController per send; aborted on unmount so no request or timer outlives the screen.
  const sendAbort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const listRef = useRef<HTMLOListElement | null>(null);
  /** True while the user is at (or near) the bottom; controls auto-scroll. */
  const stickToBottom = useRef(true);
  /** The user scrolled up: new content must not yank the view. */
  const userScrolledAway = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sendAbort.current?.abort();
      sendAbort.current = null;
    };
  }, []);

  // ---------------------------------------------------------------- history load
  const loadHistory = useCallback(
    async (mode: "initial" | "refresh") => {
      if (mode === "initial") {
        setHistoryState("loading");
        setHistoryError(null);
      }
      const result = await service.history(conversation.id);
      if (!mounted.current) return;
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

  useEffect(() => {
    void loadHistory("initial");
  }, [loadHistory]);

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
  }, [messages, phase.kind, historyState, scrollToBottom]);

  function handleScroll() {
    const list = listRef.current;
    if (!list) return;
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    const atBottom = distanceFromBottom <= STICKY_THRESHOLD_PX;
    stickToBottom.current = atBottom;
    userScrolledAway.current = !atBottom;
  }

  // -------------------------------------------------------------------- send flow
  /** Guards against double submission from double taps, Enter and the button together. */
  const submitLock = useRef(false);

  const applyMessages = useCallback((next: readonly Message[] | null) => {
    if (next) setMessages(next);
  }, []);

  const finishSend = useCallback(
    (result: SendResult) => {
      switch (result.kind) {
        case "delivered":
          applyMessages(result.messages);
          setPhase({ kind: "idle" });
          return;
        case "failed":
          applyMessages(result.messages);
          setPhase({ kind: "error", message: result.message, canRetry: true });
          return;
        case "cancelled":
          applyMessages(result.messages);
          setPhase({ kind: "idle" });
          return;
        case "unknown":
          // No history reload is attempted here: an unconfirmed outcome must not replace
          // persisted messages with a guess. The refresh action reloads on demand.

          setPhase({
            kind: "error",
            message:
              result.message ||
              "Não foi possível confirmar o envio. Reabra a conversa antes de reenviar.",
            canRetry: false,
          });
          return;
        case "signed_out":
          onSessionExpired();
          return;
        case "rejected":
          setPhase({ kind: "error", message: result.message, canRetry: true });
          return;
        default:
          return;
      }
    },
    [applyMessages, onSessionExpired],
  );

  const send = useCallback(
    async (pending: PendingSend) => {
      const controller = new AbortController();
      sendAbort.current = controller;
      setPhase({ kind: "sending", pending });

      // Discovery runs in parallel so the cancel action becomes available while the CORE
      // is still working; it stops as soon as the run is found or the send settles.
      let discoveryCancelled = false;
      const discovery = chat
        .findRun(pending.requestId, {
          signal: controller.signal,
          ...(scheduler ? { scheduler } : {}),
        })
        .then((run) => {
          if (!run || discoveryCancelled || !mounted.current) return;
          setPhase((current) =>
            current.kind === "sending" && current.pending.requestId === pending.requestId
              ? { kind: "processing", pending, run }
              : current,
          );
        })
        .catch(() => undefined);

      const result = await chat.send(pending, {
        signal: controller.signal,
        ...(scheduler ? { followOptions: { scheduler } } : {}),
      });

      // The send already settled: stop the discovery loop and publish the outcome now.
      // Awaiting discovery here would delay a definitive error by the whole backoff budget.
      discoveryCancelled = true;
      if (!mounted.current) {
        void discovery;
        return;
      }
      if (sendAbort.current === controller) sendAbort.current = null;
      finishSend(result);
      if (result.kind === "delivered" || result.kind === "cancelled") {
        setDraft("");
      }
    },
    [chat, finishSend, scheduler],
  );

  const handleSend = useCallback(() => {
    if (submitLock.current) return;
    if (phase.kind !== "idle" && phase.kind !== "error") return;
    const text = draft.trim();
    if (text.length === 0) return;
    if (!selectedAssistant) {
      setPhase({
        kind: "error",
        message: "Esta conversa não possui um assistente do catálogo. Crie uma nova conversa.",
        canRetry: false,
      });
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
  }, [phase.kind, draft, selectedAssistant, send]);

  const handleCancel = useCallback(async () => {
    if (phase.kind !== "processing") return;
    const outcome = await chat.cancel(phase.run.id);
    if (!mounted.current) return;
    if (outcome.kind === "unauthorized") {
      onSessionExpired();
      return;
    }
    if (outcome.kind === "error") {
      setPhase({ kind: "error", message: describeApiError(outcome.error), canRetry: false });
      return;
    }
    // The cancel was accepted or the run had already finished: reload the persisted truth.
    const result = await chat.follow(phase.run.id, scheduler ? { scheduler } : {});
    if (!mounted.current) return;
    if (result.outcome.kind === "unauthorized") {
      onSessionExpired();
      return;
    }
    applyMessages(result.messages);
    setPhase({ kind: "idle" });
  }, [phase, chat, onSessionExpired, applyMessages, scheduler]);

  // ---------------------------------------------------------------- presentation
  const busy = phase.kind === "sending" || phase.kind === "processing";
  const empty = historyState === "ready" && messages.length === 0;

  const processingLabel =
    phase.kind === "processing" ? describeRunStatus(phase.run) : "Enviando ao NEXUS CORE…";

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

      {empty && !busy ? (
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
        {phase.kind === "sending" || phase.kind === "processing" ? (
          <li className="bubble-row bubble-row-assistant" data-testid="chat-processing">
            <div className="bubble bubble-assistant bubble-pending">
              <p className="status">
                <span className="spinner" aria-hidden="true" />
                {processingLabel}
              </p>
              {phase.kind === "processing" ? (
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => void handleCancel()}
                >
                  Cancelar execução
                </button>
              ) : null}
            </div>
          </li>
        ) : null}
      </ol>

      {phase.kind === "error" ? (
        <div className="alert alert-error chat-alert" role="alert">
          <p>{phase.message}</p>
          {phase.canRetry ? (
            <p className="fineprint">
              A mensagem não foi confirmada pelo servidor. Verifique o histórico antes de reenviar.
            </p>
          ) : null}
        </div>
      ) : null}

      <ChatComposer
        value={draft}
        onChange={setDraft}
        onSend={handleSend}
        disabled={busy}
        disabledReason={busy ? processingLabel : undefined}
      />
    </main>
  );
}
