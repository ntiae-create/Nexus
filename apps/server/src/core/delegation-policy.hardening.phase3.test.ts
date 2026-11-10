import { describe, expect, it } from "vitest";
import {
  CANONICAL_PROFILE_REGISTRY,
  createAssistantProfileRegistry,
  effectiveDelegationTargets,
  type AssistantProfile,
} from "@nexus/assistant-profiles";
import type { AssistantKey, DelegationTaskSpec } from "@nexus/shared";
import {
  SERVER_DELEGATION_POLICY,
  defineDelegationPolicy,
  type DelegationPolicy,
} from "./delegation-policy.js";
import {
  DELEGATION_TARGETS,
  canDelegate,
  delegationTargetsFor,
  validateDelegationPlan,
} from "./delegation.js";
import { CoreExecutionError } from "./errors.js";

/**
 * Fase 3 (G2) — endurecimento do contrato de `DelegationPolicy`.
 *
 * Duas brechas fechadas aqui, ambas de **falha silenciosa**:
 *
 * 1. **Configuração não validada.** `maxTargetsPerCoordinator` aceitava qualquer coisa. Com `NaN`
 *    a comparação `allowed.length >= NaN` é sempre falsa, e o teto simplesmente não existe; com
 *    `0` negativo/fracionário o comportamento é arbitrário. Nada falhava — o limite apenas
 *    deixava de valer. Pior: um `allowsTarget` que não seja função estourava em runtime, no meio
 *    de uma execução, em vez de no carregamento.
 *
 * 2. **Política opcional na projeção.** `effectiveDelegationTargets(profile, registry, policy?)`
 *    tratava a omissão como `Number.POSITIVE_INFINITY`, isto é, "nenhuma restrição de servidor".
 *    Um caminho de produção que esquecesse o terceiro argumento ignorava a camada independente
 *    **sem erro** — exatamente o defeito que a correção anterior do §5.5 fechou. A política passa
 *    a ser obrigatória na projeção; a compatibilidade fica restrita a um único ponto, declarado e
 *    coberto por teste.
 */

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

function policyBlocking(...blocked: string[]): DelegationPolicy {
  const blockedSet = new Set(blocked);
  return defineDelegationPolicy({
    id: "test-blocking",
    maxTargetsPerCoordinator: 10,
    allowsTarget: ({ target }) => !blockedSet.has(target.key),
  });
}

function policyCapped(maxTargetsPerCoordinator: number): DelegationPolicy {
  return defineDelegationPolicy({
    id: "test-capped",
    maxTargetsPerCoordinator,
    allowsTarget: () => true,
  });
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

describe("Fase 3 — validação da configuração da política (ponto 1)", () => {
  const valid = {
    id: "test-valid",
    maxTargetsPerCoordinator: 10,
    allowsTarget: () => true,
  };

  it("aceita uma configuração válida", () => {
    expect(() => defineDelegationPolicy(valid)).not.toThrow();
    expect(SERVER_DELEGATION_POLICY.maxTargetsPerCoordinator).toBe(10);
  });

  it("rejeita teto igual a zero", () => {
    expect(() => defineDelegationPolicy({ ...valid, maxTargetsPerCoordinator: 0 })).toThrow();
  });

  it("rejeita teto negativo", () => {
    expect(() => defineDelegationPolicy({ ...valid, maxTargetsPerCoordinator: -1 })).toThrow();
  });

  it("rejeita NaN", () => {
    // O caso mais insidioso: `n >= NaN` é sempre falso, então o teto sumiria em silêncio.
    expect(() =>
      defineDelegationPolicy({ ...valid, maxTargetsPerCoordinator: Number.NaN }),
    ).toThrow();
  });

  it("rejeita Infinity", () => {
    // Infinito é a representação de "sem teto". Uma política real não pode desativar o próprio
    // limite sem dizê-lo, e o contrato não oferece esse jeito.
    expect(() =>
      defineDelegationPolicy({ ...valid, maxTargetsPerCoordinator: Number.POSITIVE_INFINITY }),
    ).toThrow();
    expect(() =>
      defineDelegationPolicy({ ...valid, maxTargetsPerCoordinator: Number.NEGATIVE_INFINITY }),
    ).toThrow();
  });

  it("rejeita teto fracionário", () => {
    for (const fraction of [1.5, 0.5, 9.99]) {
      expect(
        () => defineDelegationPolicy({ ...valid, maxTargetsPerCoordinator: fraction }),
        `teto fracionário aceito: ${fraction}`,
      ).toThrow();
    }
  });

  it("rejeita identificador vazio ou em branco", () => {
    for (const badId of ["", "   ", "\t\n"]) {
      expect(
        () => defineDelegationPolicy({ ...valid, id: badId }),
        `id inválido aceito: ${JSON.stringify(badId)}`,
      ).toThrow();
    }
  });

  it("rejeita identificador que não é string", () => {
    for (const badId of [null, undefined, 42, {}, []]) {
      expect(() =>
        defineDelegationPolicy({ ...valid, id: badId as unknown as string }),
      ).toThrow();
    }
  });

  it("rejeita `allowsTarget` que não é função", () => {
    for (const bad of [undefined, null, true, "sim", {}, []]) {
      expect(
        () => defineDelegationPolicy({ ...valid, allowsTarget: bad as never }),
        `allowsTarget inválido aceito: ${JSON.stringify(bad)}`,
      ).toThrow();
    }
  });

  it("a rejeição é explícita: mensagem identifica o campo", () => {
    const error = captureError(() =>
      defineDelegationPolicy({ ...valid, maxTargetsPerCoordinator: 0 }),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("maxTargetsPerCoordinator");

    const idError = captureError(() => defineDelegationPolicy({ ...valid, id: "" }));
    expect((idError as Error).message).toContain("id");

    const fnError = captureError(() =>
      defineDelegationPolicy({ ...valid, allowsTarget: null as never }),
    );
    expect((fnError as Error).message).toContain("allowsTarget");
  });

  it("a política resultante é congelada", () => {
    const policy = defineDelegationPolicy(valid);
    expect(Object.isFrozen(policy)).toBe(true);
  });
});

describe("Fase 3 — política nunca é omitida na projeção (ponto 2)", () => {
  it("`effectiveDelegationTargets` exige a política", () => {
    const yui = CANONICAL_PROFILE_REGISTRY.getByKey("yui")!;
    // Antes: omitir equivalia a "sem restrição de servidor" (Infinity), em silêncio.
    // Agora: omitir é erro, e o erro aponta para a razão.
    const error = captureError(() =>
      (effectiveDelegationTargets as unknown as (
        p: AssistantProfile,
        r: typeof CANONICAL_PROFILE_REGISTRY,
      ) => readonly string[])(yui, CANONICAL_PROFILE_REGISTRY),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("policy");
  });

  it("`delegationTargetsFor` e `canDelegate` exigem a política", () => {
    const targetsError = captureError(() =>
      (delegationTargetsFor as unknown as (key: AssistantKey) => readonly AssistantKey[])("yui"),
    );
    expect(targetsError).toBeInstanceOf(Error);

    const canError = captureError(() =>
      (canDelegate as unknown as (key: AssistantKey) => boolean)("yui"),
    );
    expect(canError).toBeInstanceOf(Error);
  });

  it("`validateDelegationPlan` exige a política", () => {
    const error = captureError(() =>
      (validateDelegationPlan as unknown as (input: unknown) => void)({
        specs: [spec("alice")],
        chainKeys: ["yui"],
        baseDepth: 0,
        limits: LIMITS,
      }),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("policy");
  });

  it("a única API de compatibilidade é `DELEGATION_TARGETS`, e ela é comprovada", () => {
    // Decisão declarada: `DELEGATION_TARGETS` é público desde a Etapa 3B e é construído no
    // carregamento do módulo a partir do registro canônico **com a política de produção**. Não é
    // um caminho que possa "esquecer" a política: ele não recebe parâmetros.
    expect(DELEGATION_TARGETS).toBeDefined();
    expect([...DELEGATION_TARGETS.yui!]).toEqual(["alice", "schwi"]);
    expect([...DELEGATION_TARGETS.alice!]).toEqual([]);
    expect([...DELEGATION_TARGETS.schwi!]).toEqual([]);
    expect(Object.isFrozen(DELEGATION_TARGETS)).toBe(true);
  });
});

describe("Fase 3 — as sete garantias obrigatórias (ponto 3)", () => {
  it("1. alvo declarado, ativo e permitido é aceito", () => {
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

  it("2. alvo declarado e ativo, mas recusado pela política, é rejeitado", () => {
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

  it("3. alvo permitido, mas não declarado, é rejeitado", () => {
    const error = captureError(() =>
      validateDelegationPlan({
        specs: [spec("delta")],
        chainKeys: ["yui"],
        baseDepth: 0,
        limits: LIMITS,
        policy: policyCapped(10),
      }),
    );
    expect(errorCode(error)).toBe("DELEGATION_NOT_ALLOWED");
  });

  it("4. alvo desativado é rejeitado", () => {
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

    expect(
      effectiveDelegationTargets(
        registry.getByKey("yui")!,
        registry,
        SERVER_DELEGATION_POLICY,
      ),
    ).toEqual(["schwi"]);

    const error = captureError(() =>
      validateDelegationPlan({
        specs: [spec("alice")],
        chainKeys: ["yui"],
        baseDepth: 0,
        limits: LIMITS,
        registry,
        policy: SERVER_DELEGATION_POLICY,
      }),
    );
    expect(errorCode(error)).toBe("DELEGATION_NOT_ALLOWED");
  });

  it("5. uma política inválida não pode ser utilizada", () => {
    const yui = CANONICAL_PROFILE_REGISTRY.getByKey("yui")!;

    // Caso A — `allowsTarget` que não é função. Aqui a chamada estouraria sozinha (TypeError),
    // então o teste **não** se contenta com "lançou": exige o erro de contrato, que é o que
    // garante mensagem útil e recusa antes de qualquer leitura de dado.
    const forgedFunction = {
      id: "forgery",
      maxTargetsPerCoordinator: 10,
      allowsTarget: "não é função",
    } as unknown as DelegationPolicy;
    const fnError = captureError(() =>
      effectiveDelegationTargets(yui, CANONICAL_PROFILE_REGISTRY, forgedFunction),
    );
    expect(fnError).toBeInstanceOf(Error);
    expect((fnError as Error).name).not.toBe("TypeError");
    expect((fnError as Error).message).toContain("allowsTarget");

    // Caso B — o mais insidioso: `allowsTarget` é válido, mas o teto é `NaN`. Sem validação no
    // ponto de uso **nada lançaria**: `allowed.length >= NaN` é sempre falso, o laço nunca para
    // pelo teto e o limite desaparece em silêncio. É o cenário que justifica validar duas vezes.
    const forgedCap = {
      id: "forgery",
      maxTargetsPerCoordinator: Number.NaN,
      allowsTarget: () => true,
    } as unknown as DelegationPolicy;
    const capError = captureError(() =>
      effectiveDelegationTargets(yui, CANONICAL_PROFILE_REGISTRY, forgedCap),
    );
    expect(capError).toBeInstanceOf(Error);
    expect((capError as Error).message).toContain("maxTargetsPerCoordinator");

    // Caso C — teto zero: mesmo raciocínio, com um valor que "parece" válido por ser número.
    const forgedZero = {
      id: "forgery",
      maxTargetsPerCoordinator: 0,
      allowsTarget: () => true,
    } as unknown as DelegationPolicy;
    expect(
      captureError(() =>
        effectiveDelegationTargets(yui, CANONICAL_PROFILE_REGISTRY, forgedZero),
      ),
    ).toBeInstanceOf(Error);
  });

  it("o contrato no ponto de uso valida `id`, não só função e teto", () => {
    // Defeito encontrado na auditoria de revisão: `assertDelegationTargetPolicy` validava
    // `allowsTarget` e `maxTargetsPerCoordinator`, mas **não** `id`. Uma política forjada com
    // `id` vazio — ou de tipo inválido — e função/teto corretos atravessava a projeção inteira.
    //
    // Por que isso importa: `id` existe para diagnosticar qual política agiu. Um `id` inválido
    // não quebra nada visivelmente, então o erro apareceria longe da causa, num log sem
    // identificação. É o mesmo padrão de falha silenciosa dos outros campos.
    const yui = CANONICAL_PROFILE_REGISTRY.getByKey("yui")!;

    const forgedIds: readonly unknown[] = ["", "   ", "\t\n  ", null, 42];

    for (const badId of forgedIds) {
      const forged = {
        id: badId,
        maxTargetsPerCoordinator: 10,
        allowsTarget: () => true,
      } as unknown as DelegationPolicy;

      const error = captureError(() =>
        effectiveDelegationTargets(yui, CANONICAL_PROFILE_REGISTRY, forged),
      );

      // Não basta "lançou": um `TypeError` incidental de chamar algo inexistente também lança.
      // O teste exige erro de **contrato**, com mensagem que nomeia o campo.
      expect(error, `id forjado não rejeitado: ${JSON.stringify(badId)}`).toBeInstanceOf(Error);
      expect((error as Error).name, `erro incidental para id ${JSON.stringify(badId)}`).not.toBe(
        "TypeError",
      );
      expect((error as Error).message).toContain("id");
    }
  });

  it("a rejeição de `id` inválido ocorre antes de consultar o registro", () => {
    // Ordem exigida: o contrato é verificado antes de qualquer consulta ou avaliação de alvo.
    // Prova por observação: um registro que explode ao ser lido não pode ser tocado.
    const yui = CANONICAL_PROFILE_REGISTRY.getByKey("yui")!;
    let registryTouched = false;
    const tripwire = {
      list: () => {
        registryTouched = true;
        return [];
      },
      getByKey: () => {
        registryTouched = true;
        return yui;
      },
      getById: () => {
        registryTouched = true;
        return undefined;
      },
    };

    const forged = {
      id: "",
      maxTargetsPerCoordinator: 10,
      allowsTarget: () => true,
    } as unknown as DelegationPolicy;

    expect(captureError(() => effectiveDelegationTargets(yui, tripwire, forged))).toBeInstanceOf(
      Error,
    );
    expect(registryTouched, "o registro foi consultado antes da validação do contrato").toBe(false);
  });

  it("6. prompt e validação usam a mesma política", () => {
    // A propriedade que fecha a divergência original: dada a mesma política, a lista apresentada
    // ao coordenador e a lista aceita pela validação coincidem exatamente.
    const policy = policyBlocking("alice");

    const presented = delegationTargetsFor("yui", CANONICAL_PROFILE_REGISTRY, policy);
    expect(presented).toEqual(["schwi"]);

    // O que está na lista passa…
    for (const target of presented) {
      expect(() =>
        validateDelegationPlan({
          specs: [spec(target)],
          chainKeys: ["yui"],
          baseDepth: 0,
          limits: LIMITS,
          policy,
        }),
      ).not.toThrow();
    }

    // …e o que está fora dela é recusado.
    for (const rejected of ["alice"]) {
      expect(
        errorCode(
          captureError(() =>
            validateDelegationPlan({
              specs: [spec(rejected)],
              chainKeys: ["yui"],
              baseDepth: 0,
              limits: LIMITS,
              policy,
            }),
          ),
        ),
      ).toBe("DELEGATION_NOT_ALLOWED");
    }
  });

  it("7. a quarta assistente sintética continua funcionando sem nomes no código de produção", () => {
    const registry = createAssistantProfileRegistry([
      ...CANONICAL_PROFILE_REGISTRY.list(),
      DELTA,
    ]);

    const presented = delegationTargetsFor("delta", registry, SERVER_DELEGATION_POLICY);
    expect(presented).toEqual(["yui"]);

    expect(() =>
      validateDelegationPlan({
        specs: [spec("yui")],
        chainKeys: ["delta"],
        baseDepth: 0,
        limits: LIMITS,
        registry,
        policy: SERVER_DELEGATION_POLICY,
      }),
    ).not.toThrow();
  });
});
