import Fastify, { type FastifyInstance } from "fastify";
import { healthResponseSchema } from "@nexus/shared";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/v1/health", async () =>
    healthResponseSchema.parse({ status: "ok" }),
  );

  return app;
}
