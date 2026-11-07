import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AuthSnapshot, LogoutOutcome, SessionManager } from "../lib/auth/session-manager.js";

interface AuthContextValue {
  readonly snapshot: AuthSnapshot;
  /** Attempts a login. Resolves with a user-presentable error when it fails. */
  readonly login: (password: string) => Promise<{ ok: boolean; message?: string }>;
  /** Logs out, reporting whether remote revocation was confirmed. */
  readonly logout: () => Promise<LogoutOutcome>;
  /** Runs the startup session restoration exactly once. */
  readonly restore: () => Promise<void>;
  /** Called by the app when a protected request reports 401. */
  readonly handleUnauthorized: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  readonly manager: SessionManager;
  readonly children: ReactNode;
}

/**
 * Publishes the session manager snapshot to React and exposes the auth actions.
 *
 * The manager is the single owner of state; this provider only mirrors it. That
 * keeps restore/login/logout races inside one place instead of scattered effects.
 */
export function AuthProvider({ manager, children }: AuthProviderProps) {
  const [snapshot, setSnapshot] = useState<AuthSnapshot>(() => manager.getSnapshot());

  useEffect(() => {
    const unsubscribe = manager.subscribe(setSnapshot);
    // Re-sync in case the manager changed between render and subscription.
    setSnapshot(manager.getSnapshot());
    return unsubscribe;
  }, [manager]);

  const login = useCallback(
    async (password: string) => {
      const outcome = await manager.login(password);
      return outcome.ok ? { ok: true } : { ok: false, message: outcome.error?.message };
    },
    [manager],
  );

  const logout = useCallback(() => manager.logout(), [manager]);
  const handleUnauthorized = useCallback(() => manager.handleUnauthorized(), [manager]);

  // Guarded so React StrictMode's double effect cannot run restoration twice.
  const restoreStarted = useRef(false);
  const restore = useCallback(async () => {
    if (restoreStarted.current) return;
    restoreStarted.current = true;
    await manager.restore();
  }, [manager]);

  const value = useMemo<AuthContextValue>(
    () => ({ snapshot, login, logout, restore, handleUnauthorized }),
    [snapshot, login, logout, restore, handleUnauthorized],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth deve ser usado dentro de AuthProvider");
  }
  return context;
}
