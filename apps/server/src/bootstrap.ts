import type { FastifyInstance } from "fastify";
import { buildApp, type BuildAppOptions } from "./app.js";
import {
  createServerDatabase,
  type PostgresNexusDatabase,
} from "./database.js";

export class BootstrapError extends Error {
  readonly code: "MISSING_DATABASE_URL" | "DATABASE_UNAVAILABLE" | "LISTEN_FAILED";

  constructor(
    code: BootstrapError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "BootstrapError";
    this.code = code;
  }
}

export interface BootstrapEnv {
  NEXUS_DATABASE_URL?: string;
  PORT?: string;
}

export interface BootstrapDependencies {
  createDatabase?: (connectionString: string) => PostgresNexusDatabase;
  buildApp?: (options?: BuildAppOptions) => FastifyInstance;
  /** Optional logger for secondary close failures (defaults to console.error). */
  logError?: (message: string, error: unknown) => void;
}

export interface BootstrappedServer {
  app: FastifyInstance;
  db: PostgresNexusDatabase;
  port: number;
  /** Idempotent shutdown: closes Fastify (and thus the pool via onClose). */
  close(): Promise<void>;
}

async function closePoolSafely(
  closePool: () => Promise<void>,
  primaryError: unknown,
  logError: (message: string, error: unknown) => void,
): Promise<never> {
  try {
    await closePool();
  } catch (closeError) {
    logError(
      "[nexus-server] Failed to close PostgreSQL pool during bootstrap recovery",
      closeError,
    );
  }
  throw primaryError;
}

/**
 * Initializes PostgreSQL (required), verifies connectivity, builds the Fastify
 * app with readiness probe, and registers pool cleanup on app close.
 *
 * Does not call listen — the caller decides when to open the socket.
 * Any failure after the pool is created closes the pool before rethrowing.
 */
export async function bootstrapServer(
  env: BootstrapEnv = process.env,
  deps: BootstrapDependencies = {},
): Promise<BootstrappedServer> {
  const connectionString = env.NEXUS_DATABASE_URL?.trim();
  if (!connectionString) {
    throw new BootstrapError(
      "MISSING_DATABASE_URL",
      "NEXUS_DATABASE_URL is required; the server cannot start without PostgreSQL",
    );
  }

  const createDatabase =
    deps.createDatabase ??
    ((url: string) => createServerDatabase({ connectionString: url }));
  const build =
    deps.buildApp ?? ((options?: BuildAppOptions) => buildApp(options));
  const logError =
    deps.logError ??
    ((message: string, error: unknown) => {
      console.error(message, error);
    });

  let db: PostgresNexusDatabase | undefined;
  let poolClosed = false;
  let closeInFlight: Promise<void> | undefined;

  const closePool = async (): Promise<void> => {
    if (!db || poolClosed) return;
    if (closeInFlight) return closeInFlight;

    closeInFlight = (async () => {
      try {
        await db!.close();
        poolClosed = true;
      } catch (error) {
        closeInFlight = undefined;
        throw error;
      }
    })();

    return closeInFlight;
  };

  try {
    db = createDatabase(connectionString);
    await db.checkConnectivity();
  } catch (error) {
    try {
      await closePool();
    } catch (closeError) {
      logError(
        "[nexus-server] Failed to close PostgreSQL pool after connectivity failure",
        closeError,
      );
    }
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError(
      "DATABASE_UNAVAILABLE",
      "Failed to connect to PostgreSQL during startup",
      { cause: error },
    );
  }

  let app: FastifyInstance;
  try {
    app = build({
      checkDatabase: () => db!.checkConnectivity(),
    });
    app.addHook("onClose", async () => {
      await closePool();
    });
  } catch (error) {
    await closePoolSafely(closePool, error, logError);
  }

  const port = Number(env.PORT ?? 3000);

  return {
    app,
    db,
    port,
    close: async () => {
      await app.close();
    },
  };
}
