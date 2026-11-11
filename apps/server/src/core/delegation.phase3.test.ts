import { readFileSync } from "node:fs";
import ts from "typescript";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AssistantProfile } from "@nexus/assistant-profiles";
import {
  CANONICAL_PROFILE_REGISTRY,
  createAssistantProfileRegistry,
} from "@nexus/assistant-profiles";
import type { AssistantKey, DelegationTaskSpec } from "@nexus/shared";
import {
  canDelegate,
  delegationTargetsFor,
  validateDelegationPlan,
} from "./delegation.js";
import { SERVER_DELEGATION_POLICY } from "./delegation-policy.js";
import { CoreExecutionError } from "./errors.js";

/**
 * Fase 3 (G2) — coordenação declarativa derivada dos perfis.
 *
 * Escrito ANTES da implementação, por TDD. O estado anterior tinha **duas** fontes de verdade
 * para a mesma regra:
 *
 *   1. `DELEGATION_TARGETS` — mapa literal em `delegation.ts`;
 *   2. `canDelegateTo: ["alice", "schwi"]` — literal duplicado em `engine.ts`, que o prompt
 *      usava e a validação não.
 *
 * Consequência prática: uma quarta assistente jamais participaria de coordenação sem editar
 * código de produção em dois lugares. Depois desta fase a política é **dado**, e o código só
 * projeta o dado.
 *
 * Toda asserção de política é comparada com o **perfil**, nunca com uma lista escrita à mão.
 * Uma asserção `expect(targets).toEqual(["alice", "schwi"])` viraria uma terceira cópia da regra
 * e congelaria justamente o que a fase precisa manter aberto.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");

const LIMITS = {
  maxDelegationDepth: 2,
  maxDelegationsPerExecution: 3,
  maxTotalDelegations: 6,
} as const;

/** AST de um fonte, como script (não módulo): basta para inspecionar literais. */
function parseSource(text: string, fileName = "analisado.ts"): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

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

/**
 * Quarto perfil, existente apenas neste teste.
 *
 * A chave `delta` não aparece em nenhum enum, lista ou condicional de produção — esse é o ponto
 * inteiro da fase. O perfil é montado por composição sobre um perfil real, para não repetir
 * manualmente os 15 campos obrigatórios do schema (e para que uma mudança de schema apareça
 * aqui como erro de tipo, não como teste silenciosamente desatualizado).
 */
function makeProfile(overrides: {
  readonly key: string;
  readonly id: string;
  readonly coordination: AssistantProfile["coordination"];
  readonly status?: AssistantProfile["status"];
  readonly name?: string;
}): AssistantProfile {
  const template = CANONICAL_PROFILE_REGISTRY.list()[0]!;
  return {
    ...template,
    id: overrides.id as AssistantProfile["id"],
    key: overrides.key,
    name: overrides.name ?? overrides.key.toUpperCase(),
    status: overrides.status ?? "active",
    coordination: overrides.coordination,
  };
}

const DELTA = makeProfile({
  key: "delta",
  id: "11111111-1111-4111-8111-111111111111",
  coordination: { canCoordinate: true, delegateTo: ["yui"] },
});

const EPSILON_LEAF = makeProfile({
  key: "epsilon",
  id: "22222222-2222-4222-8222-222222222222",
  coordination: { canCoordinate: false },
});

/** Catálogo canônico + os perfis sintéticos. Nunca toca no catálogo de produção. */
function extendedRegistry() {
  return createAssistantProfileRegistry([
    ...CANONICAL_PROFILE_REGISTRY.list(),
    DELTA,
    EPSILON_LEAF,
  ]);
}

function spec(targetAssistant: string): DelegationTaskSpec {
  return {
    targetAssistant: targetAssistant as AssistantKey,
    objective: "Tarefa delegada de teste",
  } as DelegationTaskSpec;
}

describe("Fase 3 — política derivada do perfil (YUI, ALICE, SCHWI)", () => {
  it("YUI coordena exatamente os alvos declarados no próprio perfil", () => {
    const profile = CANONICAL_PROFILE_REGISTRY.getByKey("yui")!;
    const declared = profile.coordination.delegateTo ?? [];

    // A asserção é contra o perfil, não contra um literal. Se a declaração mudar, o teste
    // acompanha; se a derivação mentir, o teste falha.
    expect(declared.length).toBeGreaterThan(0);
    expect([...delegationTargetsFor("yui", CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY)]).toEqual([...declared]);
    expect(canDelegate("yui", CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY)).toBe(true);
  });

  it("YUI continua coordenando ALICE e SCHWI, e só elas além da VIVY da Fase 4", () => {
    const targets = delegationTargetsFor("yui", CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY);
    expect(targets).toContain("alice");
    expect(targets).toContain("schwi");
    // Fase 4 acrescenta exatamente uma entrada. Qualquer outro acréscimo — inclusive um alvo
    // que só exista por efeito colateral — quebra aqui.
    expect(targets).toContain("vivy");
    expect(targets).toHaveLength(3);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("ALICE, SCHWI e VIVY são folhas: não coordenam ninguém", () => {
    for (const key of ["alice", "schwi", "vivy"] as const) {
      const profile = CANONICAL_PROFILE_REGISTRY.getByKey(key)!;
      expect(profile.coordination.canCoordinate).toBe(false);
      expect(profile.coordination.delegateTo).toBeUndefined();
      expect(delegationTargetsFor(key, CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY)).toEqual([]);
      expect(canDelegate(key, CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY)).toBe(false);
    }
  });

  it("nenhuma das três ganhou alvo por consequência da refatoração", () => {
    const declared = new Map(
      CANONICAL_PROFILE_REGISTRY.list().map((profile) => [
        profile.key,
        [...(profile.coordination.delegateTo ?? [])],
      ]),
    );
    expect(declared.get("alice")).toEqual([]);
    expect(declared.get("schwi")).toEqual([]);
    // YUI é a única com alvos declarados.
    expect([...declared.values()].filter((targets) => targets.length > 0)).toHaveLength(1);
  });

  it("um identificador fora do catálogo não delega, sem quebrar", () => {
    expect(delegationTargetsFor("nao-registrado", CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY)).toEqual([]);
    expect(canDelegate("nao-registrado", CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY)).toBe(false);
  });
});

describe("Fase 3 — quarta assistente de teste, sem tocar produção", () => {
  it("o perfil sintético coordena outro perfil", () => {
    const registry = extendedRegistry();
    expect([...delegationTargetsFor("delta", registry, SERVER_DELEGATION_POLICY)]).toEqual(["yui"]);
    expect(canDelegate("delta", registry, SERVER_DELEGATION_POLICY)).toBe(true);
  });

  it("o perfil sintético é alvo de coordenação de outra assistente", () => {
    const registry = createAssistantProfileRegistry([
      ...CANONICAL_PROFILE_REGISTRY.list(),
      { ...DELTA, coordination: { canCoordinate: true, delegateTo: ["epsilon"] } },
      EPSILON_LEAF,
    ]);
    // `epsilon` é coordenado por `delta`; e `yui` não conhece `delta` porque não o declara —
    // ser alvo exige declaração explícita de quem coordena, não o contrário.
    expect([...delegationTargetsFor("delta", registry, SERVER_DELEGATION_POLICY)]).toEqual(["epsilon"]);
    expect(delegationTargetsFor("yui", registry, SERVER_DELEGATION_POLICY)).toEqual(["alice", "schwi", "vivy"]);
  });

  it("a quarta assistente funciona sem estar em enum, lista ou condicional de produção", () => {
    // Varredura estrutural: a chave de teste não pode aparecer em nenhum arquivo de produção.
    const productionFiles = [
      "apps/server/src/core/delegation.ts",
      "apps/server/src/core/engine.ts",
      "apps/server/src/core/instructions.ts",
      "packages/assistant-profiles/src/catalog.ts",
      "packages/shared/src/schemas/assistants.ts",
    ];
    for (const file of productionFiles) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      expect(source, `${file} menciona a chave sintética`).not.toMatch(/\bdelta\b/);
    }

    // E ainda assim funciona, porque a política vem do registro injetado.
    const registry = extendedRegistry();
    expect(canDelegate("delta", registry, SERVER_DELEGATION_POLICY)).toBe(true);
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

  it("delegar para o perfil sintético é autorizado quando quem coordena o declara", () => {
    // Substitui a YUI em vez de duplicá-la: o registro recusa id/chave repetidos, e a variante
    // com `delta` na lista precisa ocupar o mesmo lugar da original.
    const registry = createAssistantProfileRegistry([
      ...CANONICAL_PROFILE_REGISTRY.list().filter((profile) => profile.key !== "yui"),
      {
        ...CANONICAL_PROFILE_REGISTRY.getByKey("yui")!,
        coordination: { canCoordinate: true, delegateTo: ["alice", "schwi", "delta"] },
      },
      // `DELTA` sem coordenação: se ele coordenasse `yui` e a YUI coordenasse `delta`, o
      // catálogo formaria um ciclo — e o registro recusaria o conjunto inteiro, que é o
      // comportamento correto. O cenário que este teste quer isolar é a autorização.
      { ...DELTA, coordination: { canCoordinate: false } },
    ]);

    expect(() =>
      validateDelegationPlan({
        specs: [spec("delta")],
        chainKeys: ["yui"],
        baseDepth: 0,
        limits: LIMITS,
        registry,
      
        policy: SERVER_DELEGATION_POLICY,
      }),
    ).not.toThrow();

    // Contra o registro de produção, o mesmo plano é recusado — a política é dado, não código.
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
});

describe("Fase 3 — limites preservados (item 6)", () => {
  it("respeita o volume por execução", () => {
    const specs = [spec("alice"), spec("schwi"), spec("alice")];
    const error = captureError(() =>
      validateDelegationPlan({
        specs,
        chainKeys: ["yui"],
        baseDepth: 0,
        limits: { ...LIMITS, maxDelegationsPerExecution: 2, maxTotalDelegations: 10 },
      
        policy: SERVER_DELEGATION_POLICY,
      }),
    );
    expect(errorCode(error)).toBe("DELEGATION_LIMIT_EXCEEDED");
  });

  it("respeita o volume total do plano", () => {
    const specs = [spec("alice"), spec("schwi")];
    const error = captureError(() =>
      validateDelegationPlan({
        specs,
        chainKeys: ["yui"],
        baseDepth: 0,
        limits: { ...LIMITS, maxDelegationsPerExecution: 10, maxTotalDelegations: 1 },
      
        policy: SERVER_DELEGATION_POLICY,
      }),
    );
    expect(errorCode(error)).toBe("DELEGATION_LIMIT_EXCEEDED");
  });

  it("respeita a profundidade máxima", () => {
    const nested = [
      { ...spec("alice"), subDelegations: [{ ...spec("schwi"), subDelegations: [spec("alice")] }] },
    ];
    const error = captureError(() =>
      validateDelegationPlan({
        specs: nested as readonly DelegationTaskSpec[],
        chainKeys: ["yui"],
        baseDepth: 0,
        limits: { ...LIMITS, maxDelegationDepth: 2, maxDelegationsPerExecution: 10, maxTotalDelegations: 10 },
      
        policy: SERVER_DELEGATION_POLICY,
      }),
    );
    expect(errorCode(error)).toBe("DELEGATION_DEPTH_EXCEEDED");
  });

  it("um plano válido dentro dos limites passa", () => {
    expect(() =>
      validateDelegationPlan({
        specs: [spec("alice"), spec("schwi")],
        chainKeys: ["yui"],
        baseDepth: 0,
        limits: LIMITS,
      
        policy: SERVER_DELEGATION_POLICY,
      }),
    ).not.toThrow();
  });
});

describe("Fase 3 — ciclos continuam rejeitados (item 7)", () => {
  it("rejeita delegação para a própria assistente", () => {
    const error = captureError(() =>
      validateDelegationPlan({
        specs: [spec("yui")],
        chainKeys: ["yui"],
        baseDepth: 0,
        limits: LIMITS,
      
        policy: SERVER_DELEGATION_POLICY,
      }),
    );
    expect(errorCode(error)).toBe("DELEGATION_CYCLE_DETECTED");
  });

  it("rejeita ciclo com a cadeia de ancestrais", () => {
    const error = captureError(() =>
      validateDelegationPlan({
        specs: [spec("yui")],
        chainKeys: ["yui", "alice"],
        baseDepth: 0,
        limits: LIMITS,
      
        policy: SERVER_DELEGATION_POLICY,
      }),
    );
    expect(errorCode(error)).toBe("DELEGATION_CYCLE_DETECTED");
  });

  it("o ciclo é checado antes da autorização, preservando a ordem auditável", () => {
    // `schwi` não é ancestral e é alvo válido de yui; `alice` é ancestral. Se a ordem tivesse
    // mudado, o erro seria de autorização.
    const error = captureError(() =>
      validateDelegationPlan({
        specs: [spec("alice")],
        chainKeys: ["yui", "alice"],
        baseDepth: 0,
        limits: { ...LIMITS, maxDelegationDepth: 0 },
      
        policy: SERVER_DELEGATION_POLICY,
      }),
    );
    expect(errorCode(error)).toBe("DELEGATION_CYCLE_DETECTED");
  });
});

describe("Fase 3 — autorização vem do perfil (item 8 do escopo)", () => {
  it("ALICE e SCHWI não coordenam ninguém, sob qualquer alvo pedido", () => {
    // A ordem da validação é intencional (ciclo → profundidade → autorização → volume), então o
    // alvo do teste não pode ser a própria assistente nem um ancestral: isso dispararia o ciclo
    // antes de a autorização ser avaliada, e o teste passaria a medir a regra errada.
    for (const key of ["alice", "schwi"] as const) {
      const error = captureError(() =>
        validateDelegationPlan({
          specs: [spec("yui")],
          chainKeys: [key],
          baseDepth: 0,
          limits: LIMITS,
        
        policy: SERVER_DELEGATION_POLICY,
      }),
      );
      expect(errorCode(error), `${key} não deveria delegar`).toBe("DELEGATION_NOT_ALLOWED");
    }
  });

  it("YUI não coordena um alvo que não declarou", () => {
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
});

describe("Fase 3 — alvos inativos não são oferecidos", () => {
  it("um perfil desabilitado sai da lista efetiva, mesmo declarado", () => {
    const disabled = makeProfile({
      key: "alice",
      id: "00000000-0000-4000-8000-000000000002",
      coordination: { canCoordinate: false },
      status: "disabled",
    });
    const registry = createAssistantProfileRegistry([
      CANONICAL_PROFILE_REGISTRY.getByKey("yui")!,
      disabled,
      CANONICAL_PROFILE_REGISTRY.getByKey("schwi")!,
      // Fase 4: a YUI declara `vivy` como alvo, e o registro recusa alvo declarado que não exista
      // no conjunto. O perfil entra aqui inteiro — é o que mantém o cenário isolado: o que se
      // mede é a saída de ALICE por `disabled`, não a ausência de VIVY.
      CANONICAL_PROFILE_REGISTRY.getByKey("vivy")!,
    ]);

    expect(delegationTargetsFor("yui", registry, SERVER_DELEGATION_POLICY)).toEqual(["schwi", "vivy"]);
  });

  it("um coordenador desabilitado não coordena", () => {
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

    expect(delegationTargetsFor("yui", registry, SERVER_DELEGATION_POLICY)).toEqual([]);
    expect(canDelegate("yui", registry, SERVER_DELEGATION_POLICY)).toBe(false);
  });
});

describe("Fase 3 — não existe segunda lista literal de alvos (item 9)", () => {
  it("`engine.ts` não repete a lista de alvos (verificação estrutural)", () => {
    // A verificação é no **AST**, não no texto: os comentários deste arquivo citam
    // `["alice", "schwi"]` justamente para documentar o defeito corrigido. Um teste textual
    // proibiria a documentação e passaria a punir quem explica o problema.
    //
    // O que não pode existir é um literal de array com nomes de assistente — nem no prompt, nem
    // em qualquer outro ponto. Quem conhece os alvos é o perfil, projetado por
    // `delegationTargetsFor`.
    const engine = readFileSync(join(REPO_ROOT, "apps/server/src/core/engine.ts"), "utf8");
    const sourceFile = parseSource(engine, "engine.ts");
    const offending: string[] = [];

    const visit = (node: ts.Node): void => {
      if (ts.isArrayLiteralExpression(node)) {
        const names = node.elements
          .map((element) => (ts.isStringLiteral(element) ? element.text : null))
          .filter((text): text is string => text !== null);
        if (names.includes("alice") || names.includes("schwi")) {
          offending.push(names.join(","));
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    expect(offending, "literais de alvo encontrados em engine.ts").toEqual([]);
  });

  it("`delegation.ts` não mantém mapa literal de alvos (verificação estrutural)", () => {
    // A ocorrência legítima em `delegation.ts` é a projeção do registro —
    // `[profile.key, Object.freeze([...effectiveDelegationTargets(...)])]` —, que não nomeia
    // alvo algum. O defeito era um object literal `{ yui: [...], alice: [], schwi: [] }`.
    const source = readFileSync(join(REPO_ROOT, "apps/server/src/core/delegation.ts"), "utf8");
    const sourceFile = parseSource(source, "delegation.ts");
    const offending: string[] = [];

    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const keys = node.properties
          .map((property) =>
            ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)
              ? property.name.text
              : null,
          )
          .filter((name): name is string => name !== null);
        // Um mapa de política tem as três chaves como propriedades.
        if (keys.includes("alice") || keys.includes("schwi")) {
          offending.push(keys.join(","));
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    expect(offending, "mapas literais de alvo encontrados em delegation.ts").toEqual([]);
  });

  it("`DELEGATION_TARGETS` continua exportado e reflete o registro", () => {
    // Compatibilidade: o símbolo é público desde a Etapa 3B. Ele muda de origem, não de nome.
    return import("./delegation.js").then(({ DELEGATION_TARGETS }) => {
      expect([...DELEGATION_TARGETS.yui!]).toEqual([...delegationTargetsFor("yui", CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY)]);
      expect([...DELEGATION_TARGETS.alice!]).toEqual([]);
      expect([...DELEGATION_TARGETS.schwi!]).toEqual([]);
    });
  });
});
