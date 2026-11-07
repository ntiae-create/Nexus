import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

export interface LoginScreenProps {
  /** Submits the owner password. Resolves with a user-facing error when it fails. */
  readonly onSubmit: (password: string) => Promise<{ ok: boolean; message?: string }>;
  /** True while a login request is pending; blocks duplicate submissions. */
  readonly busy: boolean;
  /** Optional message explaining why the user is on this screen. */
  readonly notice?: string;
  /** Optional blocking problem, e.g. missing API configuration. */
  readonly configurationError?: string;
}

const WRONG_PASSWORD_HINT = "Senha incorreta.";

/**
 * Owner-password login. The backend authenticates a single owner by password, so
 * there is deliberately no e-mail field here.
 */
export function LoginScreen({ onSubmit, busy, notice, configurationError }: LoginScreenProps) {
  const [password, setPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const disabled = busy || Boolean(configurationError);
  const trimmedLength = password.length;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Guard against double submission: React state alone is not enough because a
    // second submit can fire before the re-render that disables the button.
    if (inFlight.current || disabled) return;
    if (trimmedLength === 0) {
      setAttempted(true);
      setError("Informe a senha do proprietário.");
      return;
    }

    inFlight.current = true;
    setError(null);
    setAttempted(true);
    setAnnouncement("Verificando a senha…");
    try {
      const outcome = await onSubmit(password);
      if (!outcome.ok) {
        setError(outcome.message ?? "Não foi possível entrar. Tente novamente.");
        setAnnouncement("Não foi possível entrar.");
        // Never keep the rejected password in component state.
        setPassword("");
      } else {
        setAnnouncement("Sessão iniciada.");
      }
    } finally {
      inFlight.current = false;
    }
  }

  function handleToggleReveal() {
    setRevealed((current) => !current);
  }

  return (
    <main className="screen">
      <section className="card" aria-labelledby="login-title">
        <p className="eyebrow">NEXUS.apk</p>
        <h1 id="login-title">Entrar</h1>
        <p className="muted">
          Acesso restrito ao proprietário. Informe a senha para continuar.
        </p>

        {notice ? (
          <p className="notice" role="status">
            {notice}
          </p>
        ) : null}

        {configurationError ? (
          <p className="alert alert-error" role="alert">
            {configurationError}
          </p>
        ) : null}

        <form className="form" onSubmit={handleSubmit} noValidate>
          <label className="field" htmlFor="owner-password">
            <span className="field-label">Senha</span>
            <span className="field-control">
              <input
                id="owner-password"
                ref={inputRef}
                className="input"
                type={revealed ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="text"
                enterKeyHint="go"
                placeholder="Senha do proprietário"
                aria-invalid={attempted && Boolean(error)}
                aria-describedby={error ? "login-error" : undefined}
                disabled={disabled}
                maxLength={1024}
              />
              <button
                type="button"
                className="button button-ghost reveal"
                onClick={handleToggleReveal}
                aria-label={revealed ? "Ocultar senha" : "Mostrar senha"}
                aria-pressed={revealed}
                disabled={disabled}
              >
                {revealed ? "Ocultar" : "Mostrar"}
              </button>
            </span>
          </label>

          {error ? (
            <p id="login-error" className="alert alert-error" role="alert">
              {error}
            </p>
          ) : null}

          {busy ? (
            <p className="status" role="status">
              <span className="spinner" aria-hidden="true" />
              Entrando…
            </p>
          ) : null}

          <button type="submit" className="button button-primary" disabled={disabled}>
            {busy ? "Entrando…" : "Entrar"}
          </button>
        </form>

        <p className="fineprint">
          Sua senha não é armazenada. A sessão fica em armazenamento protegido do
          dispositivo.
        </p>

        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
      </section>
    </main>
  );
}

export const LOGIN_WRONG_PASSWORD_HINT = WRONG_PASSWORD_HINT;
