import type { AssistantProfile } from "@nexus/assistant-profiles";

/**
 * Fase 3 (G2) — política de coordenação do **servidor** (§5.5 do plano).
 *
 * O plano define a lista efetiva como:
 *
 *   «(perfil do coordenador) ∩ (política do servidor) ∩ (perfis ativos)»
 *
 * As duas primeiras condições não podem vir do mesmo lugar. Se "o que é permitido" fosse lido de
 * `profile.coordination.delegateTo`, a interseção seria uma tautologia: nenhuma política poderia
 * recusar algo que o próprio perfil declarou, e a camada do meio não existiria de fato — foi
 * exatamente o estado da primeira versão desta fase.
 *
 * Este módulo é a camada independente. Ele decide sobre uma **relação** `(coordenador, alvo)`,
 * sem possuir catálogo nem nomear assistente algum.
 *
 * Proibição deliberada: nada aqui nomeia assistente alguma. Uma política que precisasse citar
 * chaves seria o antigo mapa literal `DELEGATION_TARGETS` de volta, com outro nome — e
 * reintroduziria o acoplamento que a fase inteira existe para remover. O teste
 * `delegation-policy.phase3.test.ts` verifica isso no texto do arquivo, comentários incluídos,
 * de modo que a proibição vale também para a documentação.
 */
export interface DelegationPolicyInput {
  /** Perfil do coordenador: quem quer delegar. */
  readonly coordinator: AssistantProfile;
  /** Perfil do alvo: para quem se quer delegar. */
  readonly target: AssistantProfile;
}

export interface DelegationPolicy {
  /** Identificador estável, para log e para diferenciar políticas em diagnóstico. */
  readonly id: string;
  /**
   * Regra de admissão da relação coordenador → alvo.
   *
   * É uma função de `(coordenador, alvo)`, não uma lista de permitidos: uma lista seria uma
   * segunda fonte de verdade sobre quais assistentes existem.
   */
  readonly allowsTarget: (input: DelegationPolicyInput) => boolean;
  /** Teto de alvos efetivos por coordenador. Regra de volume, independente de identidade. */
  readonly maxTargetsPerCoordinator: number;
}

/**
 * Falha de configuração da política.
 *
 * Erro próprio (em vez de `Error` genérico) para que a origem seja distinguível em log e em
 * teste: isto é defeito de programação/configuração, não condição de execução.
 */
export class DelegationPolicyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegationPolicyConfigurationError";
  }
}

/**
 * Valida e congela uma política.
 *
 * **Por que validar em vez de confiar no tipo.** O TypeScript não sobrevive a fronteira de dados:
 * uma política pode vir de configuração lida em runtime, e um objeto forjado (`as DelegationPolicy`)
 * entra no sistema sem passar por checagem nenhuma. Os três campos abaixo falham de formas
 * silenciosas, que é a pior categoria:
 *
 * - `maxTargetsPerCoordinator: NaN` — `allowed.length >= NaN` é **sempre falso**, então o laço
 *   nunca para pelo teto e o limite simplesmente deixa de existir, sem erro;
 * - `maxTargetsPerCoordinator: 0` — não há cenário legítimo em que um coordenador tenha zero
 *   alvos efetivos e ainda declare coordenação; um teto zero é erro de quem configurou, e deve
 *   ser dito agora, não descoberto como "coordenação silenciosamente vazia";
 * - `Infinity` — é a representação de "sem teto". O contrato não oferece esse jeito de propósito:
 *   desativar o próprio limite precisa ser uma decisão explícita, não o resultado de um valor
 *   mágico;
 * - `allowsTarget` que não é função — estoura em runtime, no meio de uma execução, convertendo
 *   um erro de configuração em falha de conversa do usuário.
 *
 * @throws DelegationPolicyConfigurationError descrevendo o campo inválido.
 */
export function defineDelegationPolicy(config: DelegationPolicy): DelegationPolicy {
  if (typeof config.id !== "string" || config.id.trim().length === 0) {
    throw new DelegationPolicyConfigurationError(
      "Delegation policy 'id' must be a non-empty string",
    );
  }

  if (typeof config.allowsTarget !== "function") {
    throw new DelegationPolicyConfigurationError(
      "Delegation policy 'allowsTarget' must be a function",
    );
  }

  const cap = config.maxTargetsPerCoordinator;
  if (typeof cap !== "number" || !Number.isFinite(cap) || !Number.isInteger(cap) || cap <= 0) {
    throw new DelegationPolicyConfigurationError(
      `Delegation policy 'maxTargetsPerCoordinator' must be a finite positive integer; received ${String(cap)}`,
    );
  }

  return Object.freeze({
    id: config.id,
    allowsTarget: config.allowsTarget,
    maxTargetsPerCoordinator: cap,
  });
}

/**
 * Política de produção.
 *
 * Deliberadamente **permissiva**: nesta fase nenhuma restrição adicional de servidor é aplicada
 * além do teto de volume, e o comportamento observável permanece o aprovado (YUI coordena ALICE e
 * SCHWI; as folhas não coordenam). A camada existe para que a restrição seja *possível e testável*,
 * não para inventar uma agora — criar uma denylist de servidor sem requisito seria antecipar
 * decisão de produto e, pior, voltaria a codificar nomes de assistente no servidor.
 *
 * `maxTargetsPerCoordinator` reaproveita o limite de 10 alvos do schema de perfil (§7.2), para
 * que o plano não tenha dois números diferentes para a mesma ideia.
 */
export const SERVER_DELEGATION_POLICY: DelegationPolicy = defineDelegationPolicy({
  id: "nexus.delegation.server.v1",
  maxTargetsPerCoordinator: 10,
  allowsTarget: () => true,
});
