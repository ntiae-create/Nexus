import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_PROFILE_REGISTRY,
  createAssistantProfileRegistry,
  effectiveDelegationTargets,
  type AssistantProfile,
  type AssistantProfileRegistry,
} from "@nexus/assistant-profiles";
import type { AssistantKey, DelegationTaskSpec } from "@nexus/shared";
import { SERVER_DELEGATION_POLICY, type DelegationPolicy } from "./delegation-policy.js";
import {
  canDelegate,
  delegationTargetsFor,
  validateDelegationPlan,
} from "./delegation.js";
import { CoreExecutionError } from "./errors.js";

/**
 * Fase 3 (G2) — as **três** condições do §5.5, comprovadas separadamente.
 *
 * O plano é explícito:
 *
 *   «A lista efetiva = interseção de (perfil do coordenador) ∩ (política do servidor) ∩
 *    (perfis ativos).»
 *
 * A primeira implementação desta fase aplicava duas das três: os alvos declarados no perfil e o
 * status ativo do catálogo. A "política do servidor" não existia como camada — ela era inferida
 * das mesmas declarações, o que torna a interseção uma tautologia: se a única fonte de "permitido"
 * é o próprio perfil, então "permitido" nunca pode recusar nada que o perfil declare.
 *
 * Este arquivo existe para tornar a terceira condição **independente e observável**. Cada teste
 * isola uma das condições, deixando as outras duas satisfeitas:
 *
 * | Teste | Declarado | Política | Ativo |
 * |---|---|---|---|
 * | aparece | ✓ | ✓ | ✓ |
 * | bloqueado pela política | ✓ | ✗ | ✓ |
 * | não declarado | ✗ | ✓ | ✓ |
 * | desativado | ✓ | ✓ | ✗ |
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");

const LIMITS = {
  maxDelegationDepth: 2,
  maxDelegationsPerExecution: 3,
  maxTotalDelegations: 6,
} as const;

function captureError(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof CoreExecutionError ? error.code : undefined;
}

function spec(targetAssistant: string): DelegationTaskSpec {
  return {
    targetAssistant: targetAssistant as AssistantKey,
    objective: "Tarefa delegada de teste",
  } as DelegationTaskSpec;
}

/** Política de teste que bloqueia chaves específicas. Não existe em produção. */
function policyBlocking(...blocked: string[]): DelegationPolicy {
  const blockedSet = new Set(blocked);
  return {
    id: "test-blocking",
    maxTargetsPerCoordinator: 10,
    allowsTarget: ({ target }) => !blockedSet.has(target.key),
  };
}

/** Política de teste que limita o número de alvos, sem nomear assistente algum. */
function policyCapped(maxTargetsPerCoordinator: number): DelegationPolicy {
  return {
    id: "test-capped",
    maxTargetsPerCoordinator,
    allowsTarget: () => true,
  };
}

function makeProfile(overrides: {
  readonly key: string;
  readonly id: string;
  readonly coordination: AssistantProfile["coordination"];
  readonly status?: AssistantProfile["status"];
}): AssistantProfile {
  const template = CANONICAL_PROFILE_REGISTRY.list()[0]!;
  return {
    ...template,
    id: overrides.id as AssistantProfile["id"],
    key: overrides.key,
    name: overrides.key.toUpperCase(),
    status: overrides.status ?? "active",
    coordination: overrides.coordination,
  };
}

const DELTA = makeProfile({
  key: "delta",
  id: "11111111-1111-4111-8111-111111111111",
  coordination: { canCoordinate: true, delegateTo: ["yui"] },
});

function extendedRegistry(): AssistantProfileRegistry {
  return createAssistantProfileRegistry([...CANONICAL_PROFILE_REGISTRY.list(), DELTA]);
}

describe("Fase 3 — a política do servidor é uma camada independente", () => {
  it("existe como objeto próprio, separado dos perfis", () => {
    // O ponto arquitetural: se a política fosse derivada do mesmo dado que as declarações, a
    // interseção do §5.5 seria vazia de significado. Ela precisa ser uma decisão do servidor.
    expect(SERVER_DELEGATION_POLICY).toBeDefined();
    expect(typeof SERVER_DELEGATION_POLICY.allowsTarget).toBe("function");
    expect(SERVER_DELEGATION_POLICY.id.length).toBeGreaterThan(0);
    expect(SERVER_DELEGATION_POLICY.maxTargetsPerCoordinator).toBeGreaterThan(0);
  });

  it("não nomeia assistentes: a política é regra, não lista", () => {
    // Proibição explícita da correção: a política não pode virar o antigo mapa literal com
    // ALICE e SCHWI. Uma regra que precisasse citar chaves seria uma segunda cópia do catálogo.
    const source = readFileSync(
      join(REPO_ROOT, "apps/server/src/core/delegation-policy.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/["']yui["']/);
    expect(source).not.toMatch(/["']alice["']/);
    expect(source).not.toMatch(/["']schwi["']/);
  });

  it("produz o resultado aprovado no catálogo canônico", () => {
    // A camada nova não pode mudar o comportamento aprovado: YUI continua com os seus dois alvos.
    //
    // Antes este teste comparava "com política" × "sem política" — e a comparação só fazia
    // sentido porque omitir a política significava "sem restrição". Depois do endurecimento a
    // omissão é erro, então o teste passou a afirmar o resultado direto, que é o que importa.
    const yui = CANONICAL_PROFILE_REGISTRY.getByKey("yui")!;
    expect(
      effectiveDelegationTargets(yui, CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY),
    ).toEqual(["alice", "schwi"]);
  });
});

describe("Fase 3 — interseção das três condições (§5.5)", () => {
  it("declarado + permitido + ativo aparece na lista efetiva", () => {
    const yui = CANONICAL_PROFILE_REGISTRY.getByKey("yui")!;
    const targets = effectiveDelegationTargets(
      yui,
      CANONICAL_PROFILE_REGISTRY,
      SERVER_DELEGATION_POLICY,
    );
    expect(targets).toEqual(["alice", "schwi"]);
  });

  it("declarado, mas bloqueado pela política do servidor, NÃO aparece", () => {
    const yui = CANONICAL_PROFILE_REGISTRY.getByKey("yui")!;
    // A YUI declara ALICE e SCHWI; a política do servidor recusa ALICE. Sem a terceira camada,
    // ALICE continuaria na lista — é exatamente o buraco que este teste fecha.
    const targets = effectiveDelegationTargets(
      yui,
      CANONICAL_PROFILE_REGISTRY,
      policyBlocking("alice"),
    );
    expect(targets).toEqual(["schwi"]);
  });

  it("permitido pela política, mas não declarado pelo perfil, NÃO aparece", () => {
    const yui = CANONICAL_PROFILE_REGISTRY.getByKey("yui")!;
    // Política permissiva: permite tudo. Ainda assim, o que o perfil não declarou não existe.
    // SCHWI e ALICE são os únicos declarados; DELTA não é.
    const registry = extendedRegistry();
    const targets = effectiveDelegationTargets(
      registry.getByKey("yui")!,
      registry,
      policyCapped(10),
    );
    expect(targets).toEqual(["alice", "schwi"]);
    expect(targets).not.toContain("delta");
    void yui;
  });

  it("declarado e permitido, mas desativado, NÃO aparece", () => {
    const disabledAlice = makeProfile({
      key: "alice",
      id: "00000000-0000-4000-8000-000000000002",
      coordination: { canCoordinate: false },
      status: "disabled",
    });
    const registry = createAssistantProfileRegistry([
      CANONICAL_PROFILE_REGISTRY.getByKey("yui")!,
      disabledAlice,
      CANONICAL_PROFILE_REGISTRY.getByKey("schwi")!,
    ]);

    const targets = effectiveDelegationTargets(
      registry.getByKey("yui")!,
      registry,
      SERVER_DELEGATION_POLICY,
    );
    expect(targets).toEqual(["schwi"]);
  });

  it("um coordenador desativado não recebe alvos efetivos", () => {
    const disabledYui = makeProfile({
      key: "yui",
      id: "00000000-0000-4000-8000-000000000001",
      coordination: { canCoordinate: true, delegateTo: ["alice", "schwi"] },
      status: "disabled",
    });
    const registry = createAssistantProfileRegistry([
      disabledYui,
      CANONICAL_PROFILE_REGISTRY.getByKey("alice")!,
      CANONICAL_PROFILE_REGISTRY.getByKey("schwi")!,
    ]);

    expect(
      effectiveDelegationTargets(registry.getByKey("yui")!, registry, SERVER_DELEGATION_POLICY),
    ).toEqual([]);
  });

  it("a política limita a quantidade de alvos, sem nomear ninguém", () => {
    // `maxTargetsPerCoordinator` é uma regra de servidor legítima: limita volume de coordenação
    // sem conhecer as assistentes. Com teto 1, a YUI mantém apenas o primeiro declarado.
    const yui = CANONICAL_PROFILE_REGISTRY.getByKey("yui")!;
    expect(
      effectiveDelegationTargets(yui, CANONICAL_PROFILE_REGISTRY, policyCapped(1)),
    ).toEqual(["alice"]);
  });
});

describe("Fase 3 — a validação usa a mesma interseção", () => {
  it("rejeita alvo declarado mas bloqueado pela política", () => {
    // A regra vale nos dois pontos: se aparecesse no prompt e fosse recusada na validação
    // (ou o contrário), voltaria a haver duas fontes de verdade.
    const error = captureError(() =>
      validateDelegationPlan({
        specs: [spec("alice")],
        chainKeys: ["yui"],
        baseDepth: 0,
        limits: LIMITS,
        policy: policyBlocking("alice"),
      }),
    );
    expect(errorCode(error)).toBe("DELEGATION_NOT_ALLOWED");
  });

  it("rejeita alvo que não é declarado pelo coordenador", () => {
    const error = captureError(() =>
      validateDelegationPlan({
        specs: [spec("delta")],
        chainKeys: ["yui"],
        baseDepth: 0,
        limits: LIMITS,
      
        policy: SERVER_DELEGATION_POLICY,
      }),
    );
    expect(errorCode(error)).toBe("DELEGATION_NOT_ALLOWED");
  });

  it("aceita alvo na interseção das três condições", () => {
    expect(() =>
      validateDelegationPlan({
        specs: [spec("alice")],
        chainKeys: ["yui"],
        baseDepth: 0,
        limits: LIMITS,
      
        policy: SERVER_DELEGATION_POLICY,
      }),
    ).not.toThrow();
  });

  it("a política informada à validação é a mesma que a do prompt", () => {
    // `delegationTargetsFor` e `validateDelegationPlan` precisam concordar quando recebem a
    // mesma política — senão o coordenador promete o que a validação recusa.
    const targets = delegationTargetsFor("yui", CANONICAL_PROFILE_REGISTRY, policyBlocking("alice"));
    expect(targets).toEqual(["schwi"]);

    expect(captureError(() =>
      validateDelegationPlan({
        specs: [spec("alice")],
        chainKeys: ["yui"],
        baseDepth: 0,
        limits: LIMITS,
        policy: policyBlocking("alice"),
      }),
    )).toBeDefined();

    expect(() =>
      validateDelegationPlan({
        specs: [spec("schwi")],
        chainKeys: ["yui"],
        baseDepth: 0,
        limits: LIMITS,
        policy: policyBlocking("alice"),
      }),
    ).not.toThrow();
  });
});

describe("Fase 3 — compatibilidade preservada após a correção", () => {
  it("YUI continua coordenando ALICE e SCHWI", () => {
    expect([...delegationTargetsFor("yui", CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY)]).toEqual(["alice", "schwi"]);
    expect(canDelegate("yui", CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY)).toBe(true);
  });

  it("ALICE e SCHWI continuam sem poder iniciar delegações", () => {
    for (const key of ["alice", "schwi"] as const) {
      expect(delegationTargetsFor(key, CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY)).toEqual([]);
      expect(canDelegate(key, CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY)).toBe(false);
      expect(
        errorCode(
          captureError(() =>
            validateDelegationPlan({
              specs: [spec("yui")],
              chainKeys: [key],
              baseDepth: 0,
              limits: LIMITS,
            
        policy: SERVER_DELEGATION_POLICY,
      }),
          ),
        ),
      ).toBe("DELEGATION_NOT_ALLOWED");
    }
  });

  it("a quarta assistente sintética continua coordenando sem tocar produção", () => {
    const registry = extendedRegistry();
    expect([...delegationTargetsFor("delta", registry, SERVER_DELEGATION_POLICY)]).toEqual(["yui"]);
    expect(canDelegate("delta", registry, SERVER_DELEGATION_POLICY)).toBe(true);
    // E a política de produção não a bloqueia: a chave não aparece em lugar nenhum do código.
    expect(
      effectiveDelegationTargets(registry.getByKey("delta")!, registry, SERVER_DELEGATION_POLICY),
    ).toEqual(["yui"]);
  });

  it("limites de profundidade, volume e ciclos continuam valendo", () => {
    // Profundidade
    expect(
      errorCode(
        captureError(() =>
          validateDelegationPlan({
            specs: [
              { ...spec("alice"), subDelegations: [{ ...spec("schwi"), subDelegations: [spec("alice")] }] },
            ] as readonly DelegationTaskSpec[],
            chainKeys: ["yui"],
            baseDepth: 0,
            limits: { ...LIMITS, maxDelegationDepth: 2, maxDelegationsPerExecution: 10, maxTotalDelegations: 10 },
          
        policy: SERVER_DELEGATION_POLICY,
      }),
        ),
      ),
    ).toBe("DELEGATION_DEPTH_EXCEEDED");

    // Volume
    expect(
      errorCode(
        captureError(() =>
          validateDelegationPlan({
            specs: [spec("alice"), spec("schwi")],
            chainKeys: ["yui"],
            baseDepth: 0,
            limits: { ...LIMITS, maxDelegationsPerExecution: 1, maxTotalDelegations: 10 },
          
        policy: SERVER_DELEGATION_POLICY,
      }),
        ),
      ),
    ).toBe("DELEGATION_LIMIT_EXCEEDED");

    // Ciclo
    expect(
      errorCode(
        captureError(() =>
          validateDelegationPlan({
            specs: [spec("yui")],
            chainKeys: ["yui"],
            baseDepth: 0,
            limits: LIMITS,
          
        policy: SERVER_DELEGATION_POLICY,
      }),
        ),
      ),
    ).toBe("DELEGATION_CYCLE_DETECTED");
  });
});
