import type { FastifyInstance } from "fastify";
import {
  getAssistantProfileById,
  getAssistantProfileByKey,
  listAssistantProfiles,
  type AssistantProfile,
} from "@nexus/assistant-profiles";
import { requireAuth } from "../auth/plugin.js";

/**
 * Read-side view of a profile exposed to clients.
 *
 * Deliberadamente menor que o perfil: instruções operacionais, `configuration`, `tools`,
 * `memoryPolicy` e `usageRestrictions` são material interno do prompt e não têm por que
 * atravessar a API. O que o cliente precisa para montar a interface é identidade e
 * apresentação.
 */
interface AssistantView {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly primaryRole: string;
  readonly capabilities: readonly string[];
  readonly status: string;
}

export function toAssistantView(profile: AssistantProfile): AssistantView {
  return {
    id: profile.id,
    key: profile.key,
    name: profile.name,
    description: profile.description ?? "",
    primaryRole: profile.primaryRole,
    capabilities: profile.capabilities,
    status: profile.status,
  };
}

/**
 * Fonte de perfis usada pelas rotas.
 *
 * O padrão é o catálogo canônico de `@nexus/assistant-profiles`. A interface existe para permitir
 * que um teste injete um registro estendido e comprove que a rota **deriva** do registro em vez
 * de carregar uma cópia — que é o critério de conclusão da Fase 2. Em produção nunca é
 * substituída.
 */
export interface AssistantRegistry {
  readonly list: () => readonly AssistantProfile[];
  readonly getByKey: (key: string) => AssistantProfile | undefined;
  readonly getById: (id: string) => AssistantProfile | undefined;
}

export const CANONICAL_ASSISTANT_REGISTRY: AssistantRegistry = {
  list: listAssistantProfiles,
  getByKey: getAssistantProfileByKey,
  getById: getAssistantProfileById,
};

export interface AssistantRoutesOptions {
  /** Omitted -> the canonical profile catalog. */
  readonly registry?: AssistantRegistry;
}

/**
 * `GET /v1/assistants` and `GET /v1/assistants/:key`.
 *
 * Etapa 3C.3, Fase 2 (G4): esta rota servia de um array literal próprio, divergente dos perfis
 * (`description`, `primaryRole`) — o defeito L9 da Fase 0 — e nem sequer era registrada por
 * `buildApp`. Agora ela deriva do registro: acrescentar um perfil ao catálogo o faz aparecer na
 * API sem tocar neste arquivo.
 *
 * O código do erro de "não encontrado" continua `NOT_FOUND`, como antes da fase. Trocar por
 * `ASSISTANT_NOT_FOUND` quebraria o cliente sem necessidade; a unificação de vocabulário de erro
 * não faz parte desta fase.
 */
export function registerAssistantRoutes(
  app: FastifyInstance,
  options: AssistantRoutesOptions = {},
): void {
  const registry = options.registry ?? CANONICAL_ASSISTANT_REGISTRY;

  app.get("/v1/assistants", { preHandler: requireAuth }, async () => ({
    assistants: registry.list().map(toAssistantView),
  }));

  app.get<{ Params: { key: string } }>(
    "/v1/assistants/:key",
    { preHandler: requireAuth },
    async (request, reply) => {
      const identifier = request.params.key.toLowerCase();
      const profile = registry.getByKey(identifier) ?? registry.getById(identifier);
      if (!profile) {
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: "Assistant not found", retryable: false },
          timestamp: new Date().toISOString(),
        });
      }
      return { assistant: toAssistantView(profile) };
    },
  );
}
