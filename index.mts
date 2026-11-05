import Fastify from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServerlessApp } from "./apps/server/src/bootstrap.js";

const app: ReturnType<typeof Fastify> = createServerlessApp();

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await app.ready();
  app.server.emit("request", req, res);
}
