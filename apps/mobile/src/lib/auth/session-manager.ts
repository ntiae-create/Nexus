import { ApiError } from "../../services/api-client.js";
import type { AuthService, LoginResult, SessionInfo } from "../../services/auth-service.js";
import type { SecureStorage } from "./secure-storage.js";

/**
 * Authentication state as the UI sees it.
 *
 * `restoring` and `signing-in` are explicit states (rather than booleans) so the
 * screens cannot render a login form while a restored session is still being
 * validated, and cannot submit twice while a login is in flight.
 */
export type AuthStatus =
  | { readonly kind: "restoring" }
  | { readonly kind: "signed-out"; readonly reason?: SignOutReason }
  | { readonly kind: "signing-in" }
  | { readonly kind: "signed-in"; readonly session: AuthenticatedSession };

/** Why the app is on the login screen. Drives the message shown to the user. */
export type SignOutReason =
  /** No session was found on this device. */
  | "no-session"
  /** Server rejected the stored token (expired, revoked or invalid). */
  | "session-invalid"
  /** `GET /v1/auth/me` failed for a reason other than an invalid token. */
  | "validation-failed"
  /** The user logged out. */
  | "logged-out";

export interface AuthenticatedSession {
  /** Never rendered, never logged. Only forwarded to the HTTP client. */
  readonly token: string;
  readonly ownerId: string;
  readonly expiresAt: string;
}

export interface AuthSnapshot {
  readonly status: AuthStatus;
  /** True while a request that must block duplicate submissions is running. */
  readonly busy: boolean;
}

export type AuthListener = (snapshot: AuthSnapshot) => void;

export interface SessionManagerDependencies {
  readonly authService: AuthService;
  readonly storage: SecureStorage;
  /** Clock hook (tests). Defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface LoginOutcome {
  readonly ok: boolean;
  readonly error?: ApiError;
}

export interface LogoutOutcome {
  readonly ok: boolean;
  /** True when the server confirmed revocation of the session. */
  readonly revokedRemotely: boolean;
  /** Present when the local session was cleared but revocation was not confirmed. */
  readonly warning?: ApiError;
}

/**
 * Owns the authentication lifecycle: restore, login, logout and invalidation.
 *
 * Concurrency rules (all enforced here, not in the screens):
 * - `login()` is single-flight: a second call while one is in flight returns the
 *   same promise instead of issuing a second request.
 * - `restore()` is single-flight and is a no-op once the session is established.
 * - `logout()` invalidates any in-flight login/restore generation, so a slow login
 *   response can never re-establish a session the user just discarded.
 * - An invalid token always clears storage before the state moves to signed-out.
 */
export function createSessionManager(dependencies: SessionManagerDependencies) {
  const { authService, storage } = dependencies;
  const now = dependencies.now ?? (() => Date.now());

  let snapshot: AuthSnapshot = { status: { kind: "restoring" }, busy: false };
  const listeners = new Set<AuthListener>();

  let inFlightLogin: Promise<LoginOutcome> | null = null;
  let inFlightRestore: Promise<void> | null = null;
  let inFlightLogout: Promise<LogoutOutcome> | null = null;

  /**
   * Incremented whenever the session is deliberately discarded. Async work started
   * under an older generation must not publish its result.
   */
  let generation = 0;

  function emit(): void {
    for (const listener of listeners) listener(snapshot);
  }

  function setSnapshot(next: AuthSnapshot): void {
    snapshot = next;
    emit();
  }

  function setStatus(status: AuthStatus, busy = false): void {
    setSnapshot({ status, busy });
  }

  /**
   * Clears the stored token, tolerating storage failures.
   *
   * When the store cannot confirm removal, the in-memory session is still dropped;
   * the token is never trusted again in this process, and the next start revalidates
   * whatever remains before showing any authenticated content.
   */
  async function clearStoredSession(): Promise<void> {
    try {
      await storage.clear();
    } catch {
      // Intentionally swallowed: failure to erase cannot keep the user logged in.
    }
  }

  /** Drops the session locally and reports why. Invalidates in-flight work. */
  async function invalidate(reason: SignOutReason): Promise<void> {
    generation += 1;
    await clearStoredSession();
    setStatus({ kind: "signed-out", reason });
  }

  return {
    /** Current snapshot. Stable reference between updates. */
    getSnapshot(): AuthSnapshot {
      return snapshot;
    },

    subscribe(listener: AuthListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /**
     * Accepts a token produced by the login flow, persisting it before the app is
     * considered signed in. If the store cannot confirm the write, authentication
     * fails instead of pretending the session was saved.
     */
    async establish(result: LoginResult): Promise<LoginOutcome> {
      const startedAt = generation;
      try {
        await storage.save(result.token);
      } catch {
        // The token was never written, so the session must not be considered
        // established — and the UI must leave the "signing in" state.
        await clearStoredSession();
        if (startedAt === generation) {
          setStatus({ kind: "signed-out", reason: "no-session" });
        }
        return {
          ok: false,
          error: new ApiError({
            kind: "network",
            message:
              "Login validado, mas não foi possível salvar a sessão neste dispositivo. Tente novamente.",
          }),
        };
      }
      if (startedAt !== generation) {
        // A logout happened while the token was being written: honour it.
        await clearStoredSession();
        return {
          ok: false,
          error: new ApiError({ kind: "http", status: 401, message: "Sessão descartada." }),
        };
      }
      setStatus({
        kind: "signed-in",
        session: { token: result.token, ownerId: result.ownerId, expiresAt: result.expiresAt },
      });
      return { ok: true };
    },

    /**
     * Restores the session at startup: reads the stored token, then validates it
     * against `GET /v1/auth/me`. A transport failure does not authenticate anyone.
     */
    async restore(): Promise<void> {
      if (inFlightRestore) return inFlightRestore;
      if (snapshot.status.kind === "signed-in") return;

      const startedAt = generation;
      setStatus({ kind: "restoring" });

      inFlightRestore = (async () => {
        let token: string | null = null;
        try {
          token = await storage.get();
        } catch {
          // Unreadable store: treat as no session rather than falling back to
          // anything less protected.
          token = null;
        }
        if (startedAt !== generation) return;

        if (!token) {
          setStatus({ kind: "signed-out", reason: "no-session" });
          return;
        }

        let info: SessionInfo;
        try {
          info = await authService.currentSession(token);
        } catch (error) {
          if (startedAt !== generation) return;
          const apiError =
            error instanceof ApiError
              ? error
              : new ApiError({ kind: "network", message: "Falha ao validar a sessão." });
          if (apiError.meansSessionInvalid) {
            await invalidate("session-invalid");
          } else {
            // The server could not confirm the session. Do not enter the app with an
            // unvalidated token; keep it on disk so a later start can revalidate.
            setStatus({ kind: "signed-out", reason: "validation-failed" });
          }
          return;
        }

        if (startedAt !== generation) return;

        if (Date.parse(info.expiresAt) <= now()) {
          await invalidate("session-invalid");
          return;
        }

        setStatus({
          kind: "signed-in",
          session: { token, ownerId: info.ownerId, expiresAt: info.expiresAt },
        });
      })()
        .catch(() => {
          // Defensive: restore must always resolve into a renderable state.
          if (generation === startedAt) setStatus({ kind: "signed-out", reason: "validation-failed" });
        })
        .finally(() => {
          inFlightRestore = null;
        });

      return inFlightRestore;
    },

    /**
     * Authenticates with the owner password.
     *
     * Single-flight: while a login is pending, further calls resolve with the same
     * outcome, so double taps cannot produce two requests or two lockout failures.
     */
    login(password: string): Promise<LoginOutcome> {
      if (inFlightLogin) return inFlightLogin;

      const startedAt = generation;
      setStatus({ kind: "signing-in" }, true);

      inFlightLogin = (async (): Promise<LoginOutcome> => {
        let result: LoginResult;
        try {
          result = await authService.login(password);
        } catch (error) {
          if (startedAt !== generation) return { ok: false };
          const apiError =
            error instanceof ApiError
              ? error
              : new ApiError({ kind: "network", message: "Falha inesperada ao entrar." });
          // A failed attempt never leaves the user signed in.
          await clearStoredSession();
          setStatus({ kind: "signed-out", reason: "no-session" });
          return { ok: false, error: apiError };
        }
        if (startedAt !== generation) return { ok: false };
        return this.establish(result);
      })()
        .catch(async (error: unknown) => {
          await clearStoredSession();
          setStatus({ kind: "signed-out", reason: "no-session" });
          return {
            ok: false,
            error:
              error instanceof ApiError
                ? error
                : new ApiError({ kind: "network", message: "Falha inesperada ao entrar." }),
          };
        })
        .finally(() => {
          inFlightLogin = null;
        });

      return inFlightLogin;
    },

    /**
     * Logs out: revokes the session on the server first, then clears local state.
     *
     * If the backend is unreachable or errors, the local session is cleared anyway
     * and the outcome reports that remote revocation could not be confirmed — the
     * app never keeps a user "logged in" because the network was down.
     */
    logout(): Promise<LogoutOutcome> {
      if (inFlightLogout) return inFlightLogout;

      const current = snapshot.status;
      const token = current.kind === "signed-in" ? current.session.token : null;

      // Invalidate immediately: any slow login/restore must not resurrect the
      // session while logout is running.
      generation += 1;

      inFlightLogout = (async (): Promise<LogoutOutcome> => {
        let warning: ApiError | undefined;
        let revokedRemotely = false;

        if (token) {
          try {
            await authService.logout(token);
            revokedRemotely = true;
          } catch (error) {
            warning =
              error instanceof ApiError
                ? error
                : new ApiError({ kind: "network", message: "Falha ao revogar a sessão." });
          }
        } else {
          // Nothing to revoke server-side.
          revokedRemotely = false;
        }

        await clearStoredSession();
        setStatus({ kind: "signed-out", reason: "logged-out" });

        return { ok: true, revokedRemotely, ...(warning ? { warning } : {}) };
      })().finally(() => {
        inFlightLogout = null;
      });

      return inFlightLogout;
    },

    /**
     * Called when a protected request reports 401: the persisted token is no longer
     * usable, so storage is cleared before returning to the login screen.
     */
    async handleUnauthorized(): Promise<void> {
      if (snapshot.status.kind === "signed-out") return;
      await invalidate("session-invalid");
    },
  };
}

export type SessionManager = ReturnType<typeof createSessionManager>;
