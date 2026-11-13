import pg from "pg";
import type { PostgresDatabaseOptions } from "./types.js";
import { requirePostgresTls } from "./connection-string.js";

const { Pool } = pg;

export function createPool(options: PostgresDatabaseOptions): pg.Pool {
  const pool = new Pool({
    connectionString: requirePostgresTls(options.connectionString),
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 15_000,
    application_name: options.applicationName ?? "nexus-backend",
    // Ensure we never inherit session state across checkouts in a dangerous way.
    // Local set_config(true) + explicit BEGIN/COMMIT is the primary defense.
  });

  pool.on("error", (err) => {
    // Log unexpected idle client errors; do not crash the process.
    console.error("[nexus/database] Unexpected pool error:", err.message);
  });

  return pool;
}

/**
 * Ends the pool. Callers that need single-flight / retry semantics must layer
 * that above this helper (see createPostgresDatabase.close).
 */
export async function closePool(pool: pg.Pool): Promise<void> {
  await pool.end();
}
