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
 * Política de admissão da relação coordenador → alvo.
 *
 * Declarada **aqui como interface** e implementada pelo servidor. O pacote de perfis não pode
 * importar de `apps/server`, então a dependência aponta para o lado que sabe menos: o dado
 * declara a forma, quem opera fornece a regra.
 */
export interface DelegationTargetPolicy {
  readonly id: string;
  readonly allowsTarget: (input: {
    readonly coordinator: AssistantProfile;
    readonly target: AssistantProfile;
  }) => boolean;
  readonly maxTargetsPerCoordinator: number;
}

/**
 * Alvos efetivos de coordenação de um perfil.
 *
 * A lista efetiva é a interseção de **três** condições independentes, conforme o plano (§5.5):
 *
 * 1. **declarado** — o perfil do coordenador lista o alvo em `coordination.delegateTo`;
 * 2. **permitido** — a política do servidor admite a relação `(coordenador, alvo)`;
 * 3. **ativo** — o coordenador pode coordenar, e o alvo existe no catálogo com
 *    `status: "active"`.
 *
 * A condição 2 é a que dá sentido à interseção. Na primeira versão desta fase ela não existia:
 * o "permitido" era lido do próprio `delegateTo`, o que tornava a fórmula uma tautologia e
 * deixava o servidor sem nenhuma decisão própria sobre coordenação.
 *
 * A condição 3 cobre dois casos que o plano trata como um só ("perfis ativos"): sem ela,
 * desabilitar uma assistente a deixaria disponível como alvo **e** como coordenadora — visível
 * na API como `disabled`, mas operante na delegação, que é a pior combinação possível.
 *
 * O resultado preserva a **ordem de declaração** do perfil, truncada pelo teto da política.
 * Ordem importa: o prompt do coordenador apresenta os alvos nessa sequência.
 *
 * @param policy Omitida -> nenhuma restrição de servidor além do que o perfil declara. Isso é
 *   intencional: quem chama sem política (testes de schema, ferramentas de inspeção) enxerga a
 *   projeção pura do dado; o servidor sempre passa a própria política explicitamente.
 */
export function effectiveDelegationTargets(
  profile: AssistantProfile,
  registry: AssistantProfileRegistry,
  policy?: DelegationTargetPolicy,
): readonly string[] {
  if (profile.status !== "active") return [];
  if (!profile.coordination.canCoordinate) return [];

  const cap = policy?.maxTargetsPerCoordinator ?? Number.POSITIVE_INFINITY;

  const allowed: string[] = [];
  for (const key of profile.coordination.delegateTo ?? []) {
    if (allowed.length >= cap) break;

    const target = registry.getByKey(key);
    if (!target) continue;
    if (target.status !== "active") continue;
    if (policy && !policy.allowsTarget({ coordinator: profile, target })) continue;

    allowed.push(key);
  }

  return allowed;
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
