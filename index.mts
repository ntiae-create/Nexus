import Fastify from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServerlessApp } from "./apps/server/src/bootstrap.js";

/**
 * Vercel serverless entrypoint for the NEXUS API.
 *
 * The runtime (Node 24 on Vercel) compiles this file with esbuild and resolves
 * extensionless relative imports through Node's TypeScript resolution. That is
 * why it imports `./apps/server/src/bootstrap.js` **without** the extension:
 * `bootstrap.js` does not exist on disk (only `bootstrap.ts` does), so a literal
 * path would break under `node --experimental-strip-types` and under any other
 * loader that resolves the specifier verbatim. Verified with `tsx` and in the
 * Vercel build.
 *
 * Invariants kept intact (see `createServerlessApp` in `bootstrap.ts`):
 * - Fastify is built ONCE per instance, at module scope. Vercel reuses the
 *   instance across requests in a warm lambda, so the cancellation registry
 *   stays coherent and the pool is not recreated per request.
 * - PostgreSQL is created lazily on the first request that needs it, and the
 *   same `pg.Pool` is reused for every later invocation on that instance.
 * - No `listen()`: the platform delivers requests through this handler.
 */
const app: ReturnType<typeof Fastify> = createServerlessApp();

/**
 * `app.ready()` is idempotent in Fastify and resolves immediately after the
 * first call, so awaiting it per request costs nothing once the instance is
 * warm. It must complete before `app.server.emit("request")`, otherwise the
 * request can reach a router that has not finished registering plugins.
 */
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await app.ready();
  app.server.emit("request", req, res);
}
