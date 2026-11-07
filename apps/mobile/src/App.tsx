import { useEffect, useMemo, useState } from "react";
import type { Conversation } from "@nexus/shared";
import { AuthProvider, useAuth } from "./state/auth-context.js";
import { LoginScreen } from "./screens/LoginScreen.js";
import { HomeScreen } from "./screens/HomeScreen.js";
import { ChatScreen } from "./screens/ChatScreen.js";
import type { AppContainer } from "./lib/auth/bootstrap.js";
import { ApiBaseUrlScreen } from "./screens/ApiBaseUrlScreen.js";

const NOTICE_BY_REASON: Record<string, string | undefined> = {
  "no-session": undefined,
  "session-invalid": "Sua sessão expirou ou foi revogada. Entre novamente.",
  "validation-failed":
    "Não foi possível validar a sessão com o servidor. Entre novamente quando a conexão estiver disponível.",
  "logged-out": "Sessão encerrada.",
};

function AuthenticatedApp({ container }: { container: AppContainer }) {
  const { snapshot, login, logout, restore, handleUnauthorized } = useAuth();
  const [logoutBusy, setLogoutBusy] = useState(false);
  // The open conversation lives here, not in HomeScreen, so navigating to the chat does not
  // unmount the screen that owns the list and a screen cannot keep its own copy of the data.
  const [openConversation, setOpenConversation] = useState<Conversation | null>(null);
  // Shown on the login screen: the Home screen unmounts as soon as logout
  // succeeds, so the "revocation unconfirmed" warning must live above it.
  const [logoutNotice, setLogoutNotice] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [configuredNotice, setConfiguredNotice] = useState<string | null>(null);

  // Restore once on mount. The provider guards against StrictMode double effects,
  // and the manager itself is single-flight.
  useEffect(() => {
    void restore();
  }, [restore]);

  useEffect(() => {
    if (snapshot.status.kind === "signed-in") {
      // A successful login/restore proves the address works.
      setShowConfig(false);
    }
  }, [snapshot.status.kind]);

  // Leaving the authenticated area (logout, expiry, revoked token) must also close the chat,
  // so the next login never resumes on a conversation that was never validated again.
  useEffect(() => {
    if (snapshot.status.kind !== "signed-in") setOpenConversation(null);
  }, [snapshot.status.kind]);

  const sessionToken =
    snapshot.status.kind === "signed-in" ? snapshot.status.session.token : null;

  // One service per session: the token is captured here and never stored elsewhere.
  const conversationService = useMemo(
    () => (sessionToken ? container.createConversationService(sessionToken) : null),
    [container, sessionToken],
  );

  const configurationError =
    container.apiBaseUrl === null && !showConfig
      ? "Defina o endereço da API para entrar."
      : undefined;

  if (showConfig) {
    return (
      <ApiBaseUrlScreen
        current={container.apiBaseUrl}
        onCancel={() => setShowConfig(false)}
        onSave={async (value) => {
          const result = await container.configureApiBaseUrl(value);
          if (result.ok) {
            setConfiguredNotice("Endereço atualizado. Entre novamente.");
            setShowConfig(false);
          }
          return result;
        }}
      />
    );
  }

  if (snapshot.status.kind === "restoring") {
    return (
      <main className="screen">
        <section className="card" aria-labelledby="restoring-title">
          <p className="eyebrow">NEXUS.apk</p>
          <h1 id="restoring-title">Verificando sessão…</h1>
          <p className="status" role="status">
            <span className="spinner" aria-hidden="true" />
            Validando a sessão com o servidor
          </p>
        </section>
      </main>
    );
  }

  if (snapshot.status.kind === "signed-in" && conversationService) {
    const logoutHandler = async () => {
      setLogoutBusy(true);
      try {
        const outcome = await logout();
        setLogoutNotice(
          outcome.revokedRemotely
            ? null
            : "Sessão encerrada neste dispositivo, mas o servidor não confirmou a revogação. " +
                "Entre novamente quando a conexão voltar.",
        );
        return { revokedRemotely: outcome.revokedRemotely };
      } finally {
        setLogoutBusy(false);
      }
    };

    if (openConversation) {
      return (
        <ChatScreen
          conversation={openConversation}
          service={conversationService}
          onBack={() => setOpenConversation(null)}
          onSessionExpired={() => {
            setOpenConversation(null);
            void handleUnauthorized();
          }}
        />
      );
    }

    return (
      <HomeScreen
        session={snapshot.status.session}
        service={conversationService}
        busy={logoutBusy}
        onOpenConversation={setOpenConversation}
        onLogout={logoutHandler}
        onSessionExpired={() => void handleUnauthorized()}
      />
    );
  }

  const busy = snapshot.status.kind === "signing-in";
  const reasonNotice =
    snapshot.status.kind === "signed-out"
      ? NOTICE_BY_REASON[snapshot.status.reason ?? "no-session"]
      : undefined;
  const notice = configuredNotice ?? logoutNotice ?? reasonNotice;

  return (
    <>
      <LoginScreen
        busy={busy}
        {...(notice ? { notice } : {})}
        {...(configurationError ? { configurationError } : {})}
        onSubmit={async (password) => {
          setLogoutNotice(null);
          const outcome = await login(password);
          if (!outcome.ok && outcome.message) {
            return { ok: false, message: outcome.message };
          }
          return outcome;
        }}
      />
      <div className="screen-footer">
        <button
          type="button"
          className="link-button"
          onClick={() => setShowConfig(true)}
          disabled={busy}
        >
          {container.apiBaseUrl ? "Configurar endereço da API" : "Definir endereço da API"}
        </button>
      </div>
    </>
  );
}

export default function App({ container }: { container: AppContainer }) {
  return (
    <AuthProvider manager={container.sessionManager}>
      <AuthenticatedApp container={container} />
    </AuthProvider>
  );
}
