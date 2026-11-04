import {
  createPostgresDatabase,
  type PostgresNexusDatabase,
  type PostgresDatabaseOptions,
} from "@nexus/database";

/**
 * Creates the PostgreSQL database handle for the backend.
 * Connection string must come from environment / secret manager — never hardcoded.
 *
 * Lifecycle:
 * - Call createServerDatabase() during app bootstrap when NEXUS_DATABASE_URL is set.
 * - Register app.addHook("onClose", () => db.close()) so the pool is drained cleanly.
 * - Do not open the pool on every request; keep a single instance per process.
 *
 * Context boundary:
 * - Only trusted backend code may call createTrustedOwnerContext / withOwnerTransaction.
 * - Never construct OwnerTransactionContext from unvalidated client input.
 */
export function createServerDatabase(
  options?: Partial<PostgresDatabaseOptions>,
): PostgresNexusDatabase {
  const connectionString =
    options?.connectionString ?? process.env.NEXUS_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "NEXUS_DATABASE_URL (or options.connectionString) is required to create the PostgreSQL database",
    );
  }
  return createPostgresDatabase({
    connectionString,
    max: options?.max ?? 10,
    applicationName: options?.applicationName ?? "nexus-server",
    ...options,
  });
}

export type { PostgresNexusDatabase };
