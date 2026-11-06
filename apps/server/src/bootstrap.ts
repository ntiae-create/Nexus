import type { FastifyInstance } from "fastify";
import { buildApp, type BuildAppOptions } from "./app.js";
import {
  createServerDatabase,
  type PostgresNexusDatabase,
} from "./database.js";
import {
  createDefaultProviderRuntime,
  type ProviderRuntime,
  type ProviderRuntimeEnv,
} from "./providers/index.js";
import { createDatabasePreferenceReader } from "./routes/providers.js";
import { NexusCoreEngine } from "./core/engine.js";

export class BootstrapError extends Error {
  readonly code: "MISSING_DATABASE_URL" | "DATABASE_UNAVAILABLE" | "LISTEN_FAILED";

  constructor(
    code: BootstrapError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);

    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        configurable: true,
        writable: true,
      });
    }
    this.name = "BootstrapError";
    this.code = code;
  }
}

export interface BootstrapEnv extends ProviderRuntimeEnv {
  NEXUS_DATABASE_URL?: string;
  PORT?: string;
}

/**
 * Builds the NEXUS CORE engine bound to the lazily-created PostgreSQL handle.
 * A single engine instance per process keeps the cancellation registry coherent
 * across requests (Vercel keeps warm instances, so this matters in practice).
 */
export function createCoreEngine(
  getDb: () => PostgresNexusDatabase,
  providers: ProviderRuntime,
  logger?: CoreEngineLogger,
): NexusCoreEngine {
  return new NexusCoreEngine({
    database: {
      withOwnerTransaction: (context, operation) =>
        getDb().withOwnerTransaction(context, operation),
    },
    providers,
    ...(logger ? { logger } : {}),
  });
}

export type CoreEngineLogger = NonNullable<
  ConstructorParameters<typeof NexusCoreEngine>[0]["logger"]
>;

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

/**
 * Builds the Fastify application for a serverless runtime. PostgreSQL is
 * created and checked only when /v1/ready is requested, so app initialization
 * and /v1/health do not depend on Neon availability.
 */
export function createServerlessApp(
  env: BootstrapEnv = process.env,
  deps: BootstrapDependencies = {},
): FastifyInstance {
  const createDatabase =
    deps.createDatabase ??
    ((url: string) => createServerDatabase({ connectionString: url }));
  const build =
    deps.buildApp ?? ((options?: BuildAppOptions) => buildApp(options));
  let db: PostgresNexusDatabase | undefined;
  const getOrCreateDb = (): PostgresNexusDatabase => {
    const connectionString = env.NEXUS_DATABASE_URL?.trim();
    if (!connectionString) {
      throw new BootstrapError(
        "MISSING_DATABASE_URL",
        "NEXUS_DATABASE_URL is required to connect to PostgreSQL",
      );
    }
    db ??= createDatabase(connectionString);
    return db;
  };

  const providerRuntime = createDefaultProviderRuntime({ env });

  const app = build({
    checkDatabase: async () => {
      await getOrCreateDb().checkConnectivity();
    },
    providers: {
      runtime: providerRuntime,
      env,
      readPreferences: createDatabasePreferenceReader(getOrCreateDb),
    },
    core: {
      core: createCoreEngine(getOrCreateDb, providerRuntime, {
        info: (payload, message) => app.log.info(payload, message),
        warn: (payload, message) => app.log.warn(payload, message),
        error: (payload, message) => app.log.error(payload, message),
      }),
    },
  });

  app.addHook("onClose", async () => {
    await db?.close();
  });

  return app;
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

  const app = await (async (): Promise<FastifyInstance> => {
    try {
      const providerRuntime = createDefaultProviderRuntime({ env });
      const builtApp = build({
        checkDatabase: () => db!.checkConnectivity(),
        providers: {
          runtime: providerRuntime,
          env,
          readPreferences: createDatabasePreferenceReader(() => db!),
        },
        core: {
          core: createCoreEngine(() => db!, providerRuntime, {
            info: (payload, message) => builtApp.log.info(payload, message),
            warn: (payload, message) => builtApp.log.warn(payload, message),
            error: (payload, message) => builtApp.log.error(payload, message),
          }),
        },
      });
      builtApp.addHook("onClose", async () => {
        await closePool();
      });
      return builtApp;
    } catch (error) {
      return await closePoolSafely(closePool, error, logError);
    }
  })();

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
