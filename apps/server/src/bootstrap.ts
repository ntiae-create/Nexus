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
}

export interface BootstrappedServer {
  app: FastifyInstance;
  db: PostgresNexusDatabase;
  port: number;
  /** Idempotent shutdown: closes Fastify (and thus the pool via onClose). */
  close(): Promise<void>;
}

/**
 * Initializes PostgreSQL (required), verifies connectivity, builds the Fastify
 * app with readiness probe, and registers pool cleanup on app close.
 *
 * Does not call listen — the caller decides when to open the socket.
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

  let db: PostgresNexusDatabase | undefined;
  let poolClosed = false;

  const closePool = async (): Promise<void> => {
    if (!db || poolClosed) return;
    poolClosed = true;
    await db.close();
  };

  try {
    db = createDatabase(connectionString);
    await db.checkConnectivity();
  } catch (error) {
    await closePool();
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError(
      "DATABASE_UNAVAILABLE",
      "Failed to connect to PostgreSQL during startup",
      { cause: error },
    );
  }

  const app = build({
    checkDatabase: () => db!.checkConnectivity(),
  });

  app.addHook("onClose", async () => {
    await closePool();
  });

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
