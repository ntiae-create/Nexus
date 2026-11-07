import { useState } from "react";
import type { AuthenticatedSession } from "../lib/auth/session-manager.js";

export interface HomeScreenProps {
  readonly session: AuthenticatedSession;
  readonly onLogout: () => Promise<{ revokedRemotely: boolean }>;
  readonly busy: boolean;
}

const formatExpiry = (iso: string): string | null => {
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
};

/**
 * Minimal authenticated screen. Its only job is to prove the session works; chat,
 * conversations and assistant selection are explicitly out of scope for 3C.1.
 */
export function HomeScreen({ session, onLogout, busy }: HomeScreenProps) {
  const [confirming, setConfirming] = useState(false);
  const expiresAt = formatExpiry(session.expiresAt);

  async function handleLogout() {
    setConfirming(false);
    // The "revocation unconfirmed" notice is rendered by App, because this
    // screen unmounts the moment logout completes.
    await onLogout();
  }

  return (
    <main className="screen">
      <section className="card" aria-labelledby="home-title">
        <p className="eyebrow">NEXUS.apk</p>
        <h1 id="home-title">Sessão ativa</h1>
        <p className="muted">
          Autenticação concluída e validada pelo servidor. Os recursos do produto
          entram nas próximas etapas.
        </p>

        <dl className="details">
          <div>
            <dt>Proprietário</dt>
            <dd className="monospace">{session.ownerId}</dd>
          </div>
          <div>
            <dt>Sessão expira em</dt>
            <dd>{expiresAt ?? "desconhecido"}</dd>
          </div>
        </dl>

        {confirming ? (
          <div className="confirm">
            <p>Encerrar a sessão neste dispositivo?</p>
            <div className="row">
              <button type="button" className="button button-primary" onClick={handleLogout} disabled={busy}>
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
      </section>
    </main>
  );
}
