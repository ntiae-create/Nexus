import type { Pool } from "pg";
import type { NexusDatabase, OwnerTransactionContext } from "../contracts.js";
import { createPool, closePool } from "./pool.js";
import { createWithOwnerTransaction } from "./transaction.js";
import { createRepositories } from "./repositories/index.js";
import type { PostgresDatabaseOptions } from "./types.js";

export type { PostgresDatabaseOptions, OwnerTransactionContext };

/**
 * Internal symbol — never part of the public API surface.
 * Tests that must inspect the pool import this module and use the symbol;
 * application code has no legitimate path to Pool or PoolClient.
 */
export const INTERNAL_POOL = Symbol.for("nexus.database.internalPool");

export interface PostgresNexusDatabase extends NexusDatabase {
  /**
   * Graceful shutdown of the underlying pool.
   * Concurrent callers share the same in-flight end(); successful close is
   * idempotent. If end() fails, the pool is not marked closed so a later
   * retry can attempt shutdown again.
   */
  close(): Promise<void>;
  /**
   * Verifies the pool can obtain a connection and that the checksummed ledger
   * contains the exact required migrations 00001–00008. It calls the narrowly
   * granted `nexus.migration_ledger_ready()` SECURITY DEFINER function; the
   * runtime role never reads `nexus_migrations` directly.
   *
   * Any missing function, inaccessible/malformed ledger, absent migration, or
   * checksum mismatch rejects readiness. Used only for process readiness /
   * bootstrap — not a business SQL surface.
   */
  checkConnectivity(): Promise<void>;
}

/**
 * Creates a production-ready PostgreSQL-backed NexusDatabase.
 *
 * Security invariants:
 * - Callbacks receive only NexusRepositories (typed methods).
 * - No Pool, PoolClient, or raw query is exposed on the public surface.
 * - RLS context is set with set_config(..., true) inside the transaction.
 * - Connections are released (or destroyed on uncertain state).
 * - ownerId / assistantId must be supplied by trusted backend code only.
 */
export function createPostgresDatabase(
  options: PostgresDatabaseOptions,
): PostgresNexusDatabase {
  const pool = createPool(options);
  const withOwnerTransaction = createWithOwnerTransaction(pool, createRepositories);
  let closedSuccessfully = false;
  let closeInFlight: Promise<void> | undefined;

  const close = async (): Promise<void> => {
    if (closedSuccessfully) return;
    if (closeInFlight) return closeInFlight;

    closeInFlight = (async () => {
      try {
        await closePool(pool);
        closedSuccessfully = true;
      } catch (error) {
        // Allow a subsequent close() to retry; do not treat failure as closed.
        closeInFlight = undefined;
        throw error;
      }
    })();

    return closeInFlight;
  };

  const checkConnectivity = async (): Promise<void> => {
    if (closedSuccessfully) {
      throw new Error("PostgreSQL pool is closed");
    }
    const client = await pool.connect();
    try {
      // The function returns a single boolean and deliberately hides ledger
      // details. A missing/inaccessible function or any query error also fails
      // readiness and is translated to HTTP 503 by the route.
      const result = await client.query<{ migrations_ready: boolean | null }>(
        "SELECT nexus.migration_ledger_ready() AS migrations_ready",
      );
      if (result.rows[0]?.migrations_ready !== true) {
        throw new Error(
          "PostgreSQL is reachable but its required checksummed migrations are not ready",
        );
      }
    } finally {
      client.release();
    }
  };

  const db: PostgresNexusDatabase & { [INTERNAL_POOL]: Pool } = {
    withOwnerTransaction,
    close,
    checkConnectivity,
    [INTERNAL_POOL]: pool,
  };

  return db;
}

/**
 * Helper for trusted backend code to build a context.
 * Routes / client data must NEVER call this with unvalidated values.
 * Zod / TypeScript types are not authentication.
 */
export function createTrustedOwnerContext(
  ownerId: string,
  actor: OwnerTransactionContext["actor"],
): OwnerTransactionContext {
  return { ownerId, actor };
}
