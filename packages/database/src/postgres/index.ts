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
   * Verifies the pool can obtain a connection AND that the `nexus` schema has
   * actually been migrated on that database.
   *
   * Why not `SELECT 1`: that succeeds against any reachable PostgreSQL, so it
   * reports "ready" for a database where the schema was never applied. Measured
   * in production on 2026-11-12: `/v1/ready` returned 200 while every data route
   * failed with `42P01 relation "nexus.auth_login_state" does not exist`. A
   * readiness probe that cannot distinguish "connected" from "migrated" is a
   * probe that lies, and the deploy was nearly signed off on it.
   *
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
      // `to_regclass` resolves a name without throwing, so it distinguishes the
      // three states that matter: no connection (connect() threw), connection
      // but no migration (NULL), and migrated (a non-null OID).
      const result = await client.query<{ nexus_schema: string | null }>(
        "SELECT to_regclass('nexus.auth_login_state')::text AS nexus_schema",
      );
      if (result.rows[0]?.nexus_schema == null) {
        throw new Error(
          "PostgreSQL reachable but the nexus schema is not migrated " +
            "(nexus.auth_login_state is missing)",
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
