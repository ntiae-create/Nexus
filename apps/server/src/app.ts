import Fastify, { type FastifyInstance } from "fastify";
import { healthResponseSchema } from "@nexus/shared";
import { authPlugin, type AuthPluginOptions } from "./auth/plugin.js";
import {
  registerProviderRoutes,
  type ProviderRoutesOptions,
} from "./routes/providers.js";
import { registerCoreRoutes, type CoreRoutesOptions } from "./routes/core.js";
import { registerAssistantRoutes, type AssistantRoutesOptions } from "./routes/assistants.js";

export type DatabaseReadinessProbe = () => Promise<void>;

export interface BuildAppOptions {
  /**
   * Optional probe used by GET /v1/ready.
   * Must resolve when PostgreSQL is reachable; reject otherwise.
   * Must not leak connection strings or credentials in thrown errors that reach clients.
   */
  checkDatabase?: DatabaseReadinessProbe;
  auth?: AuthPluginOptions;
  providers?: ProviderRoutesOptions;
  core?: CoreRoutesOptions;
  assistants?: AssistantRoutesOptions;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const enableLogger = options.logger ?? true;
  const app = Fastify({
    logger: enableLogger
      ? {
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
  void app.register(authPlugin, options.auth ?? {});
  void registerProviderRoutes(app, options.providers ?? {});
  void registerCoreRoutes(app, options.core ?? {});
  // Fase 2 (G4): a rota existia mas nunca era chamada — `GET /v1/assistants` respondia 404.
  void registerAssistantRoutes(app, options.assistants ?? {});

  app.get("/v1/health", async () =>
    healthResponseSchema.parse({ status: "ok" }),
  );

  app.get("/v1/ready", async (_request, reply) => {
    if (!options.checkDatabase) {
      return reply.code(503).send({ status: "not_ready" });
    }
    try {
      await options.checkDatabase();
      return { status: "ready" };
    } catch {
      // Do not expose underlying driver errors or connection details to clients.
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  return app;
}
