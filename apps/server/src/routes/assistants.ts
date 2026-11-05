import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/plugin.js";

const ASSISTANTS = [
  { id: "00000000-0000-4000-8000-000000000001", key: "yui", name: "YUI", description: "Assistente pessoal.", primaryRole: "Assistente pessoal" },
  { id: "00000000-0000-4000-8000-000000000002", key: "alice", name: "ALICE", description: "Pesquisa e análise.", primaryRole: "Pesquisa e conhecimento" },
  { id: "00000000-0000-4000-8000-000000000003", key: "schwi", name: "SCHWI", description: "Lógica e estratégia.", primaryRole: "Lógica e estratégia" },
] as const;

export function registerAssistantRoutes(app: FastifyInstance): void {
  app.get("/v1/assistants", { preHandler: requireAuth }, async () => ({ assistants: ASSISTANTS }));
  app.get<{ Params: { key: string } }>("/v1/assistants/:key", { preHandler: requireAuth }, async (request, reply) => {
    const key = request.params.key.toLowerCase();
    const assistant = ASSISTANTS.find((a) => a.key === key || a.id === key);
    if (!assistant) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Assistant not found", retryable: false }, timestamp: new Date().toISOString() });
    return { assistant };
  });
}
