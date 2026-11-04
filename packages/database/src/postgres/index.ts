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
   * Verifies the pool can obtain a connection and run a trivial query.
   * Used only for process readiness / bootstrap — not a business SQL surface.
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
      await client.query("SELECT 1");
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
