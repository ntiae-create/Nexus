import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation } from "@nexus/shared";
import type { AuthenticatedSession } from "../lib/auth/session-manager.js";
import { ASSISTANT_CATALOG, getConversationAssistants, type AssistantOption } from "../lib/assistants.js";
import type { ConversationService } from "../services/conversation-service.js";
import {
  conversationAssistantLabel,
  conversationLabel,
  conversationTimestampLabel,
} from "../services/conversation-service.js";

export interface HomeScreenProps {
  readonly session: AuthenticatedSession;
  readonly service: ConversationService;
  readonly onOpenConversation: (conversation: Conversation) => void;
  readonly onLogout: () => Promise<{ revokedRemotely: boolean }>;
  readonly busy: boolean;
  /** Called when a request proves the session is no longer valid. */
  readonly onSessionExpired: () => void;
}

type ListState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly conversations: readonly Conversation[] }
  | { readonly kind: "error"; readonly message: string };

/**
 * Conversation list for the authenticated owner.
 *
 * Behaviour:
 * - loads `GET /v1/conversations` on mount and on demand (refresh);
 * - creates a conversation with the selected assistant and opens it immediately, reloading
 *   the list only after the server confirmed creation (`201`);
 * - never deletes: the backend exposes no delete route for conversations;
 * - states: loading (spinner), empty (guidance), error (message + retry), ready (list).
 */
export function HomeScreen({
  session,
  service,
  onOpenConversation,
  onLogout,
  busy,
  onSessionExpired,
}: HomeScreenProps) {
  const [listState, setListState] = useState<ListState>({ kind: "loading" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [selectedAssistant, setSelectedAssistant] = useState<AssistantOption>(
    () => ASSISTANT_CATALOG[0]!,
  );
  const [confirming, setConfirming] = useState(false);

  const mounted = useRef(true);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, []);

  const load = useCallback(
    async (mode: "initial" | "refresh") => {
      if (mode === "initial") setListState({ kind: "loading" });
      const controller = new AbortController();
      inFlight.current?.abort();
      inFlight.current = controller;

      const result = await service.list({ signal: controller.signal });
      if (!mounted.current) return;
      if (result.ok) {
        setListState({ kind: "ready", conversations: result.data.conversations });
        return;
      }
      if (result.signedOut) {
        onSessionExpired();
        return;
      }
      setListState({ kind: "error", message: result.message });
    },
    [service, onSessionExpired],
  );

  useEffect(() => {
    void load("initial");
  }, [load]);

  const handleCreate = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setCreateError(null);

    const result = await service.create({ assistant: selectedAssistant });
    if (!mounted.current) return;

    if (!result.ok) {
      setCreating(false);
      if (result.signedOut) {
        onSessionExpired();
        return;
      }
      setCreateError(result.message);
      return;
    }

    // The list is refreshed from the server (the conversation now exists there) and the new
    // conversation is opened — its id is the one the server assigned.
    const created = result.data;
    const refreshed = await service.list();
    if (mounted.current && refreshed.ok) {
      setListState({ kind: "ready", conversations: refreshed.data.conversations });
    }
    if (!mounted.current) return;
    setCreating(false);
    onOpenConversation(created);
  }, [creating, service, selectedAssistant, onOpenConversation, onSessionExpired]);

  async function handleLogout() {
    setConfirming(false);
    // The "revocation unconfirmed" notice is rendered by App: this screen unmounts when the
    // logout completes.
    await onLogout();
  }

  const conversations = useMemo(
    () => (listState.kind === "ready" ? listState.conversations : []),
    [listState],
  );

  return (
    <main className="home-screen">
      <header className="home-header">
        <div>
          <p className="eyebrow">NEXUS.apk</p>
          <h1 className="home-title">Conversas</h1>
        </div>
        <button
          type="button"
          className="link-button"
          onClick={() => void load("refresh")}
          disabled={listState.kind === "loading"}
        >
          Atualizar
        </button>
      </header>

      <section className="card home-create" aria-labelledby="home-create-title">
        <h2 id="home-create-title" className="home-section-title">
          Nova conversa
        </h2>
        <div className="assistant-options" role="radiogroup" aria-label="Assistente da nova conversa">
          {ASSISTANT_CATALOG.map((assistant) => {
            const selected = selectedAssistant.key === assistant.key;
            return (
              <button
                key={assistant.key}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`assistant-option ${selected ? "assistant-option-selected" : ""}`}
                onClick={() => setSelectedAssistant(assistant)}
                disabled={creating}
              >
                {assistant.name}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="button button-primary"
          onClick={() => void handleCreate()}
          disabled={creating}
        >
          {creating ? "Criando…" : `Nova conversa com ${selectedAssistant.name}`}
        </button>
        {creating ? (
          <p className="status" role="status">
            <span className="spinner" aria-hidden="true" />
            Criando conversa no NEXUS CORE…
          </p>
        ) : null}
        {createError ? (
          <p className="alert alert-error" role="alert">
            {createError}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="home-list-title" className="home-list-section">
        <h2 id="home-list-title" className="home-section-title">
          Suas conversas
        </h2>

        {listState.kind === "loading" ? (
          <p className="status" role="status">
            <span className="spinner" aria-hidden="true" />
            Carregando conversas…
          </p>
        ) : null}

        {listState.kind === "error" ? (
          <div className="alert alert-error" role="alert">
            <p>{listState.message}</p>
            <button type="button" className="link-button" onClick={() => void load("refresh")}>
              Tentar novamente
            </button>
          </div>
        ) : null}

        {listState.kind === "ready" && conversations.length === 0 ? (
          <p className="muted">
            Nenhuma conversa ainda. Crie a primeira com YUI, ALICE ou SCHWI acima.
          </p>
        ) : null}

        {conversations.length > 0 ? (
          <ul className="conversation-list">
            {conversations.map((conversation) => {
              const timestamp = conversationTimestampLabel(conversation);
              const assistantNames = getConversationAssistants(conversation.assistantIds)
                .map((assistant) => assistant.name)
                .join(" · ");
              return (
                <li key={conversation.id}>
                  <button
                    type="button"
                    className="conversation-item"
                    onClick={() => onOpenConversation(conversation)}
                    data-testid={`conversation-${conversation.id}`}
                  >
                    <span className="conversation-title">{conversationLabel(conversation)}</span>
                    <span className="conversation-meta">
                      {assistantNames || conversationAssistantLabel(conversation)}
                      {timestamp ? ` · ${timestamp}` : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      <footer className="home-footer">
        <dl className="details">
          <div>
            <dt>Proprietário</dt>
            <dd className="monospace">{session.ownerId}</dd>
          </div>
        </dl>

        {confirming ? (
          <div className="confirm">
            <p>Encerrar a sessão neste dispositivo?</p>
            <div className="row">
              <button
                type="button"
                className="button button-primary"
                onClick={handleLogout}
                disabled={busy}
              >
                {busy ? "Saindo…" : "Sair"}
              </button>
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setConfirming(false)}
                disabled={busy}
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setConfirming(true)}
            disabled={busy}
          >
            Sair
          </button>
        )}

        {busy ? (
          <p className="status" role="status">
            <span className="spinner" aria-hidden="true" />
            Encerrando sessão…
          </p>
        ) : null}
      </footer>
    </main>
  );
}
