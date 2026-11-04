import type { Pool } from "pg";
import type { NexusDatabase, OwnerTransactionContext } from "../contracts.js";
import { createPool, closePool } from "./pool.js";
import { createWithOwnerTransaction } from "./transaction.js";
import { createRepositories } from "./repositories/index.js";
import type { PostgresDatabaseOptions } from "./types.js";

export type { PostgresDatabaseOptions, OwnerTransactionContext };

export interface PostgresNexusDatabase extends NexusDatabase {
  /** Graceful shutdown of the underlying pool. */
  close(): Promise<void>;
  /** Exposed only for tests / health checks — not for business use. */
  readonly pool: Pool;
}

/**
 * Creates a production-ready PostgreSQL-backed NexusDatabase.
 *
 * Security invariants:
 * - Callbacks receive only NexusRepositories (typed methods).
 * - RLS context is set with set_config(..., true) inside the transaction.
 * - Connections are released (or destroyed on uncertain state).
 * - ownerId / assistantId must be supplied by trusted backend code only.
 */
export function createPostgresDatabase(
  options: PostgresDatabaseOptions,
): PostgresNexusDatabase {
  const pool = createPool(options);
  const withOwnerTransaction = createWithOwnerTransaction(pool, createRepositories);

  return {
    withOwnerTransaction,
    pool,
    close: () => closePool(pool),
  };
}

/**
 * Helper for trusted backend code to build a context.
 * Routes / client data must NEVER call this with unvalidated values.
 */
export function createTrustedOwnerContext(
  ownerId: string,
  actor: OwnerTransactionContext["actor"],
): OwnerTransactionContext {
  return { ownerId, actor };
}
