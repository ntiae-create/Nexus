import type { Pool, PoolClient } from "pg";
import type {
  NexusDatabase,
  NexusRepositories,
  OwnerTransactionContext,
} from "../contracts.js";
import type { CreateRepositories } from "./types.js";

/**
 * Secure transaction runner.
 *
 * - Never exposes PoolClient or arbitrary query to the business callback.
 * - Sets RLS context exclusively with set_config(..., true) (transaction-local).
 * - Guarantees BEGIN → set_config → operation → COMMIT/ROLLBACK.
 * - On uncertain state, discards the connection (release(true)).
 * - Propagates original errors after rollback attempt.
 */
export function createWithOwnerTransaction(
  pool: Pool,
  createRepositories: CreateRepositories,
): NexusDatabase["withOwnerTransaction"] {
  return async function withOwnerTransaction<T>(
    context: OwnerTransactionContext,
    operation: (repositories: NexusRepositories) => Promise<T>,
  ): Promise<T> {
    // Validate context shape early (trusted backend only; still defensive).
    if (
      !context ||
      typeof context.ownerId !== "string" ||
      context.ownerId.trim().length === 0 ||
      !context.actor
    ) {
      throw new Error("Invalid OwnerTransactionContext: missing ownerId or actor");
    }
    if (context.actor.type === "assistant" && !context.actor.assistantId) {
      throw new Error("Invalid OwnerTransactionContext: assistant actor requires assistantId");
    }

    let client: PoolClient | undefined;
    let released = false;
    let transactionStarted = false;
    let committed = false;

    const releaseClient = (destroy = false) => {
      if (client && !released) {
        released = true;
        client.release(destroy);
      }
    };

    try {
      client = await pool.connect();
      await client.query("BEGIN");
      transactionStarted = true;

      // Transaction-local context only (third argument = true).
      await client.query("SELECT set_config('nexus.owner_id', $1, true)", [
        context.ownerId,
      ]);
      await client.query("SELECT set_config('nexus.actor_type', $1, true)", [
        context.actor.type,
      ]);

      if (context.actor.type === "assistant") {
        await client.query("SELECT set_config('nexus.assistant_id', $1, true)", [
          context.actor.assistantId,
        ]);
      } else {
        // Clear any residual assistant id for owner actor.
        await client.query("SELECT set_config('nexus.assistant_id', '', true)");
      }

      // Build repositories that close over the private client.
      // The repositories interface contains only typed methods — no raw query surface.
      const repositories = createRepositories(client);

      const result = await operation(repositories);

      await client.query("COMMIT");
      committed = true;
      return result;
    } catch (error) {
      if (transactionStarted && client && !committed) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          // Connection is in an uncertain state — destroy it.
          releaseClient(true);
          // Prefer the original business error; attach rollback failure if useful.
          if (error instanceof Error && rollbackError instanceof Error) {
            error.message += ` (also failed to ROLLBACK: ${rollbackError.message})`;
          }
          throw error;
        }
      }
      // Normal error path: release cleanly after successful ROLLBACK.
      releaseClient(false);
      throw error;
    } finally {
      // If we already released (destroy case), do nothing.
      // Otherwise release the healthy client back to the pool.
      if (!released) {
        releaseClient(false);
      }
    }
  };
}
