import cors from "@fastify/cors";
import Fastify, {
  type FastifyInstance,
  type FastifyLoggerOptions,
} from "fastify";
import { healthResponseSchema } from "@nexus/shared";
import {
  getSafeReadinessDatabaseMetadata,
  type ReadinessConnectionEnvironment,
  type SafeReadinessDatabaseMetadata,
} from "./readiness-diagnostics.js";
import { authPlugin, type AuthPluginOptions } from "./auth/plugin.js";
import {
  registerProviderRoutes,
  type ProviderRoutesOptions,
} from "./routes/providers.js";
import { registerCoreRoutes, type CoreRoutesOptions } from "./routes/core.js";
import { registerAssistantRoutes, type AssistantRoutesOptions } from "./routes/assistants.js";

export type DatabaseReadinessProbe = () => Promise<void>;

// Capacitor Android's default hostname/scheme produce the exact origin https://localhost.
const ANDROID_CORS_ORIGIN = "https://localhost";
const CORS_ALLOWED_METHODS = ["GET", "POST"];
const CORS_ALLOWED_HEADERS = ["Authorization", "Content-Type"];

export interface BuildAppOptions {
  /**
   * Optional probe used by GET /v1/ready.
   * Must resolve only when PostgreSQL and the required checksummed schema are ready.
   * Must not leak connection strings, ledger data, or credentials to clients.
   */
  checkDatabase?: DatabaseReadinessProbe;
  /** Raw connection settings are sampled and sanitized only after readiness fails. */
  readinessConnectionEnvironment?: () => ReadinessConnectionEnvironment;
  auth?: AuthPluginOptions;
  providers?: ProviderRoutesOptions;
  core?: CoreRoutesOptions;
  assistants?: AssistantRoutesOptions;
  logger?: boolean;
  /** Optional destination for capturing Fastify log records in tests. */
  loggerStream?: FastifyLoggerOptions["stream"];
}

const SAFE_ERROR_TYPES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "DatabaseError",
  "PostgresError",
  "ConnectionError",
  "TLSError",
]);

const NETWORK_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_SSL_CERTIFICATE_VERIFY_FAILED",
  "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
  "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

const POSTGRES_SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

function readErrorProperty(error: unknown, property: "name" | "code"): unknown {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return undefined;
  }
  try {
    return Reflect.get(error, property);
  } catch {
    return undefined;
  }
}

function readinessErrorCategory(code: string | undefined): string {
  if (!code) return "unknown";
  if (TLS_ERROR_CODES.has(code)) return "tls";
  if (NETWORK_ERROR_CODES.has(code)) return "network";
  if (POSTGRES_SQLSTATE_PATTERN.test(code)) {
    if (code.startsWith("08")) return "database_connection";
    if (code.startsWith("28")) return "database_authentication";
    if (["57P01", "57P02", "57P03"].includes(code)) return "database_unavailable";
    return "postgresql";
  }
  return "unknown";
}

function safeReadinessErrorFields(error: unknown): {
  errorType: string;
  errorCode?: string;
  category: string;
} {
  let isError = false;
  try {
    isError = error instanceof Error;
  } catch {
    // A hostile thrown value must not prevent the readiness route from returning 503.
  }

  const rawName = readErrorProperty(error, "name");
  const errorType = isError
    ? typeof rawName === "string" && SAFE_ERROR_TYPES.has(rawName)
      ? rawName
      : "Error"
    : "NonError";

  const rawCode = readErrorProperty(error, "code");
  const errorCode =
    typeof rawCode === "string" &&
    (NETWORK_ERROR_CODES.has(rawCode) ||
      TLS_ERROR_CODES.has(rawCode) ||
      POSTGRES_SQLSTATE_PATTERN.test(rawCode))
      ? rawCode
      : undefined;

  return {
    errorType,
    ...(errorCode ? { errorCode } : {}),
    category: readinessErrorCategory(errorCode),
  };
}

function safeReadinessDatabaseMetadata(
  readEnvironment?: () => ReadinessConnectionEnvironment,
): SafeReadinessDatabaseMetadata | undefined {
  if (!readEnvironment) return undefined;

  try {
    return getSafeReadinessDatabaseMetadata(readEnvironment());
  } catch {
    // A diagnostic failure must never mask the readiness failure or leak details.
    return { databaseUrlStatus: "unavailable" };
  }
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const enableLogger = options.logger ?? true;
  const app = Fastify({
    logger: enableLogger
      ? {
          ...(options.loggerStream ? { stream: options.loggerStream } : {}),
          redact: {
            paths: [
              "req.headers.authorization",
              "headers.authorization",
              "*.apiKey",
              "*.secret",
              "*.password",
              "*.token",
            ],
            censor: "[REDACTED]",
          },
        }
      : false,
  });
  void app.register(cors, {
    origin: (origin, callback) =>
      callback(null, origin === ANDROID_CORS_ORIGIN ? origin : false),
    methods: CORS_ALLOWED_METHODS,
    allowedHeaders: CORS_ALLOWED_HEADERS,
    credentials: false,
  });
  void app.register(authPlugin, options.auth ?? {});
  void registerProviderRoutes(app, options.providers ?? {});
  void registerCoreRoutes(app, options.core ?? {});
  // Fase 2 (G4): a rota existia mas nunca era chamada — `GET /v1/assistants` respondia 404.
  void registerAssistantRoutes(app, options.assistants ?? {});

  app.get("/v1/health", async () =>
    healthResponseSchema.parse({ status: "ok" }),
  );

  app.get("/v1/ready", async (request, reply) => {
    if (!options.checkDatabase) {
      return reply.code(503).send({ status: "not_ready" });
    }
    try {
      await options.checkDatabase();
      return { status: "ready" };
    } catch (error) {
      // Log only an allowlisted type/code summary; never serialize the error itself.
      try {
        request.log.error(
          {
            ...safeReadinessErrorFields(error),
            ...(safeReadinessDatabaseMetadata(
              options.readinessConnectionEnvironment,
            ) ?? {}),
          },
          "Database readiness check failed",
        );
      } catch {
        // A failing log sink must not change the established 503 response.
      }
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  return app;
}
