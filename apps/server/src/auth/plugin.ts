import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  extractBearerToken, issueSessionToken, loadSessionConfig,
  verifyOwnerPassword, verifySessionToken, OWNER_ID,
  type SessionConfig, type SessionPayload,
} from "./session.js";

declare module "fastify" {
  interface FastifyRequest { session?: SessionPayload; }
  interface FastifyInstance { sessionConfig?: SessionConfig; }
}

export interface AuthPluginOptions { config?: SessionConfig; disabled?: boolean; }

function tryLoadConfig(): SessionConfig | undefined {
  try { return loadSessionConfig(); } catch { return undefined; }
}

export async function authPlugin(app: FastifyInstance, options: AuthPluginOptions = {}): Promise<void> {
  const config = options.disabled === true ? undefined : (options.config ?? tryLoadConfig());
  if (config) app.decorate("sessionConfig", config);

  app.post("/v1/auth/login", async (request, reply) => {
    if (!config) {
      return reply.code(503).send({ error: { code: "AUTH_NOT_CONFIGURED", message: "Set NEXUS_SESSION_SECRET and NEXUS_OWNER_PASSWORD", retryable: false }, timestamp: new Date().toISOString() });
    }
    const body = request.body as { password?: unknown } | null;
    const password = typeof body?.password === "string" ? body.password : undefined;
    if (!password) {
      return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "password is required", retryable: false }, timestamp: new Date().toISOString() });
    }
    if (!verifyOwnerPassword(password, config)) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Invalid credentials", retryable: false }, timestamp: new Date().toISOString() });
    }
    const { token, payload } = issueSessionToken(config);
    return { token, tokenType: "Bearer", expiresAt: new Date(payload.expiresAt * 1000).toISOString(), owner: { userId: OWNER_ID } };
  });

  app.get("/v1/auth/me", { preHandler: requireAuth }, async (request) => ({
    owner: { userId: request.session!.ownerId },
    session: {
      issuedAt: new Date(request.session!.issuedAt * 1000).toISOString(),
      expiresAt: new Date(request.session!.expiresAt * 1000).toISOString(),
    },
  }));

  app.post("/v1/auth/logout", { preHandler: requireAuth }, async () => ({ ok: true }));
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const config = request.server.sessionConfig;
  if (!config) {
    reply.code(503).send({ error: { code: "AUTH_NOT_CONFIGURED", message: "Auth not configured", retryable: false }, timestamp: new Date().toISOString() });
    return;
  }
  const raw = extractBearerToken(request.headers.authorization);
  if (!raw) {
    reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Missing or invalid Authorization header", retryable: false }, timestamp: new Date().toISOString() });
    return;
  }
  const payload = verifySessionToken(raw, config);
  if (!payload) {
    reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Invalid or expired session", retryable: false }, timestamp: new Date().toISOString() });
    return;
  }
  request.session = payload;
}
