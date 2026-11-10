import type { AssistantProfile } from "./profile.schema.js";
import { createAssistantProfileCatalogSchema } from "./profile.schema.js";
import { listAssistantProfiles } from "./catalog.js";

/**
 * Fase 3 (G2) — registro de perfis como fonte única da política de coordenação.
 *
 * O problema que este módulo resolve é de **fonte de verdade**, não de armazenamento. Antes
 * desta fase, "quem pode delegar para quem" existia em dois lugares no servidor e em nenhum
 * perfil. Um registro explícito permite:
 *
 * - derivar a política do dado (`profile.coordination`), em um só lugar;
 * - injetar uma composição isolada em teste e provar que uma quarta assistente participa de
 *   coordenação **sem tocar em código de produção** — que é o critério de conclusão da fase;
 * - validar a coerência do conjunto (alvos existentes, sem ciclos) no carregamento.
 *
 * O padrão é selado: `CANONICAL_PROFILE_REGISTRY` é construído uma vez, a partir do catálogo
 * congelado, e nunca é substituído. Não há singleton mutável — quem precisa de outra composição
 * chama `createAssistantProfileRegistry` e passa o resultado adiante.
 */
export interface AssistantProfileRegistry {
  readonly list: () => readonly AssistantProfile[];
  readonly getByKey: (key: string) => AssistantProfile | undefined;
  readonly getById: (id: string) => AssistantProfile | undefined;
}

/**
 * Alvos efetivos de coordenação de um perfil.
 *
 * A lista efetiva é a interseção de três condições, conforme o plano (§5.5):
 *
 * 1. o perfil **declara** os alvos (`coordination.delegateTo`);
 * 2. o coordenador pode coordenar (`coordination.canCoordinate`);
 * 3. o coordenador e cada alvo estão **ativos** no catálogo (`status: "active"`).
 *
 * A terceira condição é o "∩ perfis ativos" do plano. Sem ela, desabilitar uma assistente a
 * deixaria disponível como alvo e como coordenadora — visível na API como `disabled`, mas
 * operante na delegação, que é a pior combinação possível.
 *
 * O resultado preserva a **ordem de declaração** do perfil. Ordem importa: o prompt do
 * coordenador apresenta os alvos nessa sequência, e um teste de caracterização a fixa.
 */
export function effectiveDelegationTargets(
  profile: AssistantProfile,
  registry: AssistantProfileRegistry,
): readonly string[] {
  if (profile.status !== "active") return [];
  if (!profile.coordination.canCoordinate) return [];

  return (profile.coordination.delegateTo ?? []).filter((target) => {
    const candidate = registry.getByKey(target);
    return candidate !== undefined && candidate.status === "active";
  });
}

/**
 * Constrói um registro validado.
 *
 * A validação é a do catálogo completo — ids e chaves únicas, alvos existentes, sem ciclos — e
 * não a do perfil isolado, porque essas três regras dependem do conjunto. Um catálogo incoerente
 * falha aqui, no carregamento, e não na conversa de um usuário.
 */
export function createAssistantProfileRegistry(
  profiles: readonly AssistantProfile[],
): AssistantProfileRegistry {
  const parsed = createAssistantProfileCatalogSchema().parse([...profiles]);

  const byKey = new Map(parsed.map((profile) => [profile.key, profile]));
  const byId = new Map(parsed.map((profile) => [profile.id, profile]));

  return {
    list: () => parsed,
    getByKey: (key) => byKey.get(key),
    getById: (id) => byId.get(id),
  };
}

/**
 * Catálogo de produção. Construído a partir do registro congelado e nunca reatribuído.
 */
export const CANONICAL_PROFILE_REGISTRY: AssistantProfileRegistry =
  createAssistantProfileRegistry(listAssistantProfiles());
