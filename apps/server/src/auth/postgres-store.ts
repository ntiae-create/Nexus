import pg from "pg";
import { requirePostgresTls } from "@nexus/database";
import type { AuthStore } from "./store.js";
const { Pool } = pg;

/**
 * Authentication has its own pool because its SQL is intentionally separate
 * from the repository-only database API. Keep it to one connection so the
 * serverless runtime's combined data + auth ceiling remains bounded.
 */
export const AUTH_POOL_OPTIONS = {
  max: 1,
  idleTimeoutMillis: 5_000,
  connectionTimeoutMillis: 10_000,
} as const;

export function createPostgresAuthPool(connectionString: string): pg.Pool {
  return new Pool({
    connectionString: requirePostgresTls(connectionString),
    ...AUTH_POOL_OPTIONS,
    application_name: "nexus-auth",
  });
}

let singleton: pg.Pool | undefined;
let closeInFlight: Promise<void> | undefined;
function getPool(): pg.Pool {
  const url = process.env.NEXUS_DATABASE_URL?.trim();
  if (!url) throw new Error("NEXUS_DATABASE_URL is required for authentication state");
  return singleton ??= createPostgresAuthPool(url);
}

/** Drain the lazy singleton pool during graceful server shutdown. */
export async function closePostgresAuthPool(): Promise<void> {
  if (closeInFlight) return closeInFlight;
  if (!singleton) return;

  const pool = singleton;
  singleton = undefined;
  closeInFlight = (async () => {
    try {
      await pool.end();
    } catch (error) {
      singleton ??= pool;
      throw error;
    } finally {
      closeInFlight = undefined;
    }
  })();
  return closeInFlight;
}

/** Build independently pooled stores; PostgreSQL is the shared authority across processes. */
export function createPostgresAuthStore(pool: pg.Pool): AuthStore {
  return {
    async isRevoked(jti) {
      const result = await pool.query("SELECT 1 FROM nexus.revoked_sessions WHERE jti=$1 AND expires_at > now()", [jti]);
      return result.rowCount !== 0;
    },
    async revoke(jti, expiresAt) {
      await pool.query("INSERT INTO nexus.revoked_sessions(jti, expires_at) VALUES($1,to_timestamp($2)) ON CONFLICT(jti) DO UPDATE SET expires_at=GREATEST(nexus.revoked_sessions.expires_at, EXCLUDED.expires_at)", [jti, expiresAt]);
      // Expired rows cannot authenticate (strict expiry check in verifySessionToken);
      // delete only records whose JWT expiry is already in the past.
      await pool.query("DELETE FROM nexus.revoked_sessions WHERE expires_at <= now()");
    },
    async recordFailure() {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("INSERT INTO nexus.auth_login_state(singleton) VALUES(true) ON CONFLICT DO NOTHING");
        const r = await c.query("SELECT failed_attempts, window_started_at, locked_until FROM nexus.auth_login_state WHERE singleton=true FOR UPDATE");
        const row = r.rows[0];
        const now = Date.now();
        if (row.locked_until && new Date(row.locked_until).getTime() > now) { await c.query("COMMIT"); return false; }
        const reset = now - new Date(row.window_started_at).getTime() >= 15 * 60_000 || (row.locked_until && new Date(row.locked_until).getTime() <= now);
        const failures = (reset ? 0 : Number(row.failed_attempts)) + 1;
        const locked = failures >= 5;
        await c.query("UPDATE nexus.auth_login_state SET failed_attempts=$1, window_started_at=CASE WHEN $2 THEN now() ELSE window_started_at END, locked_until=CASE WHEN $3 THEN now()+interval '15 minutes' ELSE NULL END, updated_at=now() WHERE singleton=true", [failures, reset, locked]);
        await c.query("COMMIT");
        return !locked;
      } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
    },
    async clearFailures() { await pool.query("DELETE FROM nexus.auth_login_state WHERE singleton=true"); },
  };
}
export const postgresAuthStore: AuthStore = {
  isRevoked: (jti) => createPostgresAuthStore(getPool()).isRevoked(jti),
  revoke: (jti, expiresAt) => createPostgresAuthStore(getPool()).revoke(jti, expiresAt),
  recordFailure: () => createPostgresAuthStore(getPool()).recordFailure(),
  clearFailures: () => createPostgresAuthStore(getPool()).clearFailures(),
};
