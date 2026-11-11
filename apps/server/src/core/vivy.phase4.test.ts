import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_PROFILE_REGISTRY,
  assistantProfileSchema,
  createAssistantProfileCatalogSchema,
} from "@nexus/assistant-profiles";
import type { AssistantKey, DelegationTaskSpec } from "@nexus/shared";
import {
  canDelegate,
  delegationTargetsFor,
  validateDelegationPlan,
} from "./delegation.js";
import { SERVER_DELEGATION_POLICY } from "./delegation-policy.js";
import { ProviderError } from "../providers/index.js";
import { CoreExecutionError } from "./errors.js";
import { resolveModelCapabilitiesFor } from "./model-preference.js";
import {
  ALICE,
  OWNER_ID,
  SCHWI,
  YUI,
  conversation,
  createHarness,
} from "./test-fixtures.js";
import { MOCK_FREE_MODEL_KEY, createMockProviderAdapter } from "./mock-provider.js";

/**
 * Fase 4 — VIVY no servidor: coordenação, seleção de modelo e conversa ponta a ponta.
 *
 * Escrito ANTES da implementação, por TDD, e pensado para falhar por ausência de comportamento,
 * não por ausência de símbolo: a primeira execução deve mostrar que VIVY não existe no catálogo,
 * que a YUI não a alcança e que nenhum perfil exige capability de modelo.
 */

const VIVY_ID = "00000000-0000-4000-8000-000000000004";
const LIMITS = {
  maxDelegationDepth: 2,
  maxDelegationsPerExecution: 3,
  maxTotalDelegations: 6,
} as const;

function spec(targetAssistant: string): DelegationTaskSpec {
  return { targetAssistant: targetAssistant as AssistantKey, objective: "tarefa" } as DelegationTaskSpec;
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

describe("Fase 4 — coordenação: VIVY é alvo da YUI e folha para o resto", () => {
  it("YUI passa a alcançar VIVY, preservando ALICE e SCHWI", () => {
    expect([...delegationTargetsFor("yui", CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY)])
      .toEqual(["alice", "schwi", "vivy"]);
    expect(canDelegate("yui", CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY)).toBe(true);
  });

  it("VIVY não coordena ninguém", () => {
    expect(delegationTargetsFor("vivy", CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY))
      .toEqual([]);
    expect(canDelegate("vivy", CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY)).toBe(false);
  });

  it("ALICE e SCHWI continuam folhas", () => {
    for (const key of ["alice", "schwi"] as const) {
      expect(delegationTargetsFor(key, CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY))
        .toEqual([]);
    }
  });

  it("o plano que a YUI declara para VIVY é aceito", () => {
    expect(() =>
      validateDelegationPlan({
        specs: [spec("vivy")],
        chainKeys: ["yui"],
        baseDepth: 0,
        limits: LIMITS,
        policy: SERVER_DELEGATION_POLICY,
      }),
    ).not.toThrow();
  });
});

describe("Fase 4 — auditoria de segurança: VIVY não inicia delegação de jeito nenhum", () => {
  // Cada alvo é testado separadamente. A ordem de validação é ciclo → profundidade →
  // autorização → volume, então os alvos são escolhidos fora da cadeia para que o erro
  // medido seja realmente o de autorização, e não um ciclo disfarçado.
  it("VIVY → YUI: recusado por falta de autoridade, não por ciclo", () => {
    const error = captureError(() =>
      validateDelegationPlan({
        specs: [spec("yui")],
        chainKeys: ["vivy"],
        baseDepth: 0,
        limits: LIMITS,
        policy: SERVER_DELEGATION_POLICY,
      }),
    );
    expect(errorCode(error)).toBe("DELEGATION_NOT_ALLOWED");
  });

  it("VIVY → ALICE: recusado", () => {
    expect(
      errorCode(
        captureError(() =>
          validateDelegationPlan({
            specs: [spec("alice")],
            chainKeys: ["vivy"],
            baseDepth: 0,
            limits: LIMITS,
            policy: SERVER_DELEGATION_POLICY,
          }),
        ),
      ),
    ).toBe("DELEGATION_NOT_ALLOWED");
  });

  it("VIVY → SCHWI: recusado", () => {
    expect(
      errorCode(
        captureError(() =>
          validateDelegationPlan({
            specs: [spec("schwi")],
            chainKeys: ["vivy"],
            baseDepth: 0,
            limits: LIMITS,
            policy: SERVER_DELEGATION_POLICY,
          }),
        ),
      ),
    ).toBe("DELEGATION_NOT_ALLOWED");
  });

  it("VIVY → VIVY: recusado (ciclo de tamanho 1)", () => {
    expect(
      errorCode(
        captureError(() =>
          validateDelegationPlan({
            specs: [spec("vivy")],
            chainKeys: ["vivy"],
            baseDepth: 0,
            limits: LIMITS,
            policy: SERVER_DELEGATION_POLICY,
          }),
        ),
      ),
    ).toBe("DELEGATION_CYCLE_DETECTED");
  });

  it("um plano aninhado de VIVY é recusado: o dono do plano é VIVY, não o alvo", () => {
    // Detalhe do contrato que este teste fixa: `validateDelegationPlan` autoriza contra o **dono do
    // plano** (`chainKeys`), não contra o alvo de cada nó. Um `chainKeys: ["vivy"]` com qualquer
    // sub-plano é, portanto, VIVY tentando coordenar — e ela não tem alvo nenhum, muito menos
    // sub-delegação.
    const nested = [
      {
        ...spec("alice"),
        subDelegations: [spec("schwi")],
      },
    ] as readonly DelegationTaskSpec[];
    expect(
      errorCode(
        captureError(() =>
          validateDelegationPlan({
            specs: nested,
            chainKeys: ["vivy"],
            baseDepth: 0,
            limits: LIMITS,
            policy: SERVER_DELEGATION_POLICY,
          }),
        ),
      ),
    ).toBe("DELEGATION_NOT_ALLOWED");
  });
});

describe("Fase 4 — a VIVY nunca recebe convite para coordenar", () => {
  it("o prompt de sistema da VIVY não oferece coordenação, e o da YUI oferece as quatro menos ela", async () => {
    // A validação recusaria um plano de VIVY (testado acima). Mas um coordenador bem comportado
    // não deve nem ser convidado: se o prompt listasse alvos para ela, o modelo tentaria, o plano
    // seria recusado, e o usuário pagaria uma chamada para receber um erro. Este teste mede o
    // prompt **real** enviado ao provedor.
    const vivyHarness = createHarness({
      adapter: createMockProviderAdapter({ respond: () => "ok" }),
      seedConversation: conversation({ assistantIds: [YUI, ALICE, SCHWI, VIVY_ID] }),
    });
    await vivyHarness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: vivyHarness.conversationId,
      request: {
        content: [{ type: "text", text: "olá" }],
        requestId: randomUUID(),
        idempotencyKey: `vivy-prompt-${randomUUID()}`,
        assistantKey: "vivy",
      },
    });
    const vivySystem = vivyHarness.adapter.calls[0]!.messages.find(
      (message) => message.role === "system",
    )!.content;
    // Nenhuma chave de assistente é oferecida como alvo de delegação.
    expect(vivySystem).not.toMatch(/delegat|delega/i);
    for (const key of ["alice", "schwi", "yui", "vivy"]) {
      expect(vivySystem.toLowerCase()).not.toContain(`"${key}"`);
    }

    // Contraste: a YUI recebe a lista de alvos, com VIVY dentro e sem ela mesma.
    const yuiHarness = createHarness({
      adapter: createMockProviderAdapter({ respond: () => "ok" }),
      seedConversation: conversation({ assistantIds: [YUI, ALICE, SCHWI, VIVY_ID] }),
    });
    await yuiHarness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: yuiHarness.conversationId,
      request: {
        content: [{ type: "text", text: "olá" }],
        requestId: randomUUID(),
        idempotencyKey: `yui-prompt-${randomUUID()}`,
        assistantKey: "yui",
      },
    });
    const yuiSystem = yuiHarness.adapter.calls[0]!.messages.find(
      (message) => message.role === "system",
    )!.content;
    expect(yuiSystem).toMatch(/alice/);
    expect(yuiSystem).toMatch(/schwi/);
    expect(yuiSystem).toMatch(/vivy/);
  });

  it("o envelope de coordenação emitido pela VIVY nunca vira execução filha", async () => {
    // Cenário completo: o modelo responde com um envelope de coordenação pedindo ALICE.
    //
    // Comportamento real do engine, verificado aqui e não presumido: para um perfil sem alvos,
    // `coordinator` é `false` e o envelope **não é interpretado** — o texto é tratado como resposta
    // direta. Não há `DELEGATION_NOT_ALLOWED` porque não há tentativa de delegação: a validação
    // nunca é chamada. O que importa, e é o que este teste fixa, é que nenhuma execução filha é
    // criada e nenhuma chamada extra acontece.
    const harness = createHarness({
      adapter: createMockProviderAdapter({
        respond: () =>
          JSON.stringify({
            kind: "nexus.core.coordination.v1",
            action: "delegate",
            delegations: [{ targetAssistant: "alice", objective: "pesquise", completionCriteria: "ok" }],
          }),
      }),
      seedConversation: conversation({ assistantIds: [YUI, ALICE, SCHWI, VIVY_ID] }),
    });

    const response = await harness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: {
        content: [{ type: "text", text: "delegue para a ALICE" }],
        requestId: randomUUID(),
        idempotencyKey: `vivy-tries-${randomUUID()}`,
        assistantKey: "vivy",
      },
    });

    expect(response.execution.status).toBe("succeeded");
    // Zero delegações e zero execuções filhas: o envelope não foi acatado.
    expect(response.delegations).toEqual([]);
    expect(response.childExecutions).toEqual([]);
    // E nenhuma chamada extra: só a da própria VIVY, sem executar ALICE.
    expect(harness.adapter.calls.length).toBe(1);
  });

  it("a mesma proteção vale para ALICE e SCHWI (regressão das folhas anteriores)", async () => {
    // A Fase 4 não pode ter afrouxado o caminho das folhas que já existiam. Mesmo cenário, mesmo
    // resultado: envelope ignorado, nenhuma execução filha.
    for (const key of ["alice", "schwi"] as const) {
      const harness = createHarness({
        adapter: createMockProviderAdapter({
          respond: () =>
            JSON.stringify({
              kind: "nexus.core.coordination.v1",
              action: "delegate",
              delegations: [
                { targetAssistant: "yui", objective: "organize", completionCriteria: "ok" },
              ],
            }),
          competitorModels: [
            { key: "nexus/mock-generalist:free", capabilities: ["chat", "system_prompt"], contextWindow: 200_000 },
          ],
        }),
        seedConversation: conversation({ assistantIds: [YUI, ALICE, SCHWI, VIVY_ID] }),
      });

      const response = await harness.engine.execute({
        ownerId: OWNER_ID,
        conversationId: harness.conversationId,
        request: {
          content: [{ type: "text", text: "delegue" }],
          requestId: randomUUID(),
          idempotencyKey: `${key}-tries-${randomUUID()}`,
          assistantKey: key,
        },
      });

      expect(response.execution.status, `${key}`).toBe("succeeded");
      expect(response.delegations, `${key}`).toEqual([]);
      expect(response.childExecutions, `${key}`).toEqual([]);
      expect(harness.adapter.calls.length, `${key}`).toBe(1);
    }
  });
});

describe("Fase 4 — exigência de capability de modelo (`code`)", () => {
  it("VIVY exige `code`; as demais não exigem nada além de chat", () => {
    expect(resolveModelCapabilitiesFor(CANONICAL_PROFILE_REGISTRY.getByKey("vivy")!)).toEqual([
      "chat",
      "code",
    ]);
    for (const key of ["yui", "alice", "schwi"] as const) {
      expect(resolveModelCapabilitiesFor(CANONICAL_PROFILE_REGISTRY.getByKey(key)!)).toEqual([
        "chat",
      ]);
    }
  });

  it("a lista é deduplicada e inclui `chat` uma única vez", () => {
    const capabilities = resolveModelCapabilitiesFor(
      CANONICAL_PROFILE_REGISTRY.getByKey("vivy")!,
    );
    expect(new Set(capabilities).size).toBe(capabilities.length);
    expect(capabilities.filter((capability) => capability === "chat")).toHaveLength(1);
  });

  it("`modelPreference` recusa capability de modelo que não existe", () => {
    // A distinção do pedido: `capabilities` do perfil são texto livre do catálogo;
    // `modelPreference.requiredCapabilities` é `modelCapabilitySchema`, enum fechado.
    const vivy = CANONICAL_PROFILE_REGISTRY.getByKey("vivy")!;
    const tampered = { ...vivy, modelPreference: { requiredCapabilities: ["telepathy"] } };
    expect(assistantProfileSchema.safeParse(tampered).success).toBe(false);
  });

  it("`modelPreference` é obrigatório: um perfil sem ele não valida", () => {
    const vivy = CANONICAL_PROFILE_REGISTRY.getByKey("vivy")!;
    const { modelPreference: _omitted, ...withoutPreference } = vivy;
    expect(assistantProfileSchema.safeParse(withoutPreference).success).toBe(false);
  });

  it("`modelPreference` recusa campos desconhecidos (strict)", () => {
    const vivy = CANONICAL_PROFILE_REGISTRY.getByKey("vivy")!;
    const tampered = {
      ...vivy,
      modelPreference: { requiredCapabilities: ["code"], model: "openai/gpt" },
    };
    expect(assistantProfileSchema.safeParse(tampered).success).toBe(false);
  });
});

describe("Fase 4 — tentativas de contornar o catálogo canônico", () => {
  it("um perfil VIVY adulterado não entra no catálogo", () => {
    const vivy = CANONICAL_PROFILE_REGISTRY.getByKey("vivy")!;

    // Tentativa 1: dar a VIVY autoridade de coordenação por configuração.
    const coordinator = {
      ...vivy,
      coordination: { canCoordinate: true, delegateTo: ["alice"] },
    };
    // Isoladamente válido (o schema do perfil não sabe do catálogo), mas o catálogo com duas
    // VIVYs recusa por chave repetida — que é o vetor real de adulteração.
    expect(createAssistantProfileCatalogSchema().safeParse([vivy, coordinator]).success).toBe(false);

    // Tentativa 2: acrescentar ferramenta a VIVY.
    const withTool = {
      ...vivy,
      tools: [
        {
          toolId: "code.run",
          category: "technical",
          description: "Execução de código.",
          allowed: true,
          requiresUserAuthorization: true,
          enabledByDefault: false,
          paidUseRequiresExplicitAuthorization: true,
        },
      ],
    };
    // O schema permite a forma, mas a fase proíbe a decisão: o catálogo canônico tem tools vazio.
    expect(assistantProfileSchema.safeParse(withTool).success).toBe(true);
    expect(vivy.tools).toEqual([]);

    // Tentativa 3: duplicar a chave para sequestrar o identificador.
    expect(
      createAssistantProfileCatalogSchema().safeParse([vivy, { ...vivy, id: randomUUID() }]).success,
    ).toBe(false);
  });

  it("a chave `vivy` não aparece como condicional em código de produção", () => {
    // A VIVY entra por dado. Se a chave aparecesse em código, uma quinta assistente exigiria
    // cirurgia — exatamente o acoplamento que as Fases 1–3 removeram.
    // Só o servidor. `packages/shared/src/schemas/assistants.ts` fica de fora de propósito: é o
    // contrato onde a chave é declarada (decisão aprovada), não um ponto de decisão de comportamento.
    const files = [
      "apps/server/src/core/delegation.ts",
      "apps/server/src/core/engine.ts",
      "apps/server/src/core/instructions.ts",
      "apps/server/src/core/model-preference.ts",
    ];
    return Promise.all(
      files.map(async (file) => {
        const { readFileSync } = await import("node:fs");
        const { dirname, join, resolve } = await import("node:path");
        const { fileURLToPath } = await import("node:url");
        const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
        const source = readFileSync(join(root, file), "utf8");
        // Se a chave aparecesse aqui, uma quinta assistente exigiria cirurgia.
        return expect(source, `${file} menciona vivy`).not.toMatch(/"vivy"/);
      }),
    );
  });
});

describe("Fase 4 — conversa ponta a ponta com VIVY", () => {
  it("a VIVY responde com o modelo que declara `code`, mesmo existindo um concorrente maior", async () => {
    // O concorrente tem contexto maior, então **ganharia** a ordenação automática
    // (`compareAutomaticCandidates`) se a capability não fosse exigida. Sem ele, este teste
    // passaria mesmo com a exigência desligada: com um único modelo no catálogo, "selecionar o
    // modelo com `code`" e "selecionar o único modelo" seriam indistinguíveis. Foi uma sabotagem
    // que revelou isso.
    const harness = createHarness({
      adapter: createMockProviderAdapter({
        respond: () => "Resposta da VIVY.",
        competitorModels: [
          {
            key: "nexus/mock-generalist:free",
            capabilities: ["chat", "system_prompt", "structured_output"],
            contextWindow: 200_000,
          },
        ],
      }),
      seedConversation: conversation({ id: randomUUID(), assistantIds: [YUI, ALICE, SCHWI, VIVY_ID] }),
    });

    const response = await harness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: {
        content: [{ type: "text", text: "Como estruturo este componente?" }],
        requestId: randomUUID(),
        idempotencyKey: `vivy-chat-${randomUUID()}`,
        assistantKey: "vivy",
        assistantId: VIVY_ID,
      },
    });

    expect(response.execution.status).toBe("succeeded");
    expect(response.modelSelection.modelKey).toBe(MOCK_FREE_MODEL_KEY);
    expect(response.assistantMessage.role).toBe("assistant");

    // A seleção foi feita com `code`: o modelo efetivamente usado declara essa capability — e
    // **não** é o concorrente de contexto maior.
    expect(harness.adapter.calls.length).toBe(1);
    expect(harness.adapter.models).toHaveLength(2);
    const usedKey = harness.adapter.calls[0]!.model;
    expect(usedKey).toBe(MOCK_FREE_MODEL_KEY);
    expect(usedKey).not.toBe("nexus/mock-generalist:free");
    const used = harness.adapter.models.find((entry) => entry.key === usedKey);
    expect(used?.capabilities).toContain("code");
    // E o modelo escolhido é o que de fato respondeu, não apenas o que foi pedido.
    expect(response.modelSelection.modelKey).toBe(usedKey);
  });

  it("um modelo `:free` sem `code` é recusado, sem downgrade silencioso", async () => {
    // Catálogo de modelos sem a capability exigida: a resposta tem de ser explícita.
    const harness = createHarness({
      adapter: createMockProviderAdapter({
        respond: () => "não deveria ser chamado",
        capabilities: ["chat", "system_prompt"],
      }),
      seedConversation: conversation({ assistantIds: [YUI, ALICE, SCHWI, VIVY_ID] }),
    });

    const error = await harness.engine
      .execute({
        ownerId: OWNER_ID,
        conversationId: harness.conversationId,
        request: {
          content: [{ type: "text", text: "olá" }],
          requestId: randomUUID(),
          idempotencyKey: `vivy-no-code-${randomUUID()}`,
          assistantKey: "vivy",
        },
      })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    // O contrato real: a seleção lança `ProviderError` com `MODEL_UNAVAILABLE` (é o mesmo código
    // que `engine.test.ts` já fixa para ausência de modelo elegível). Nada de resposta vinda de um
    // modelo sem `code`.
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("MODEL_UNAVAILABLE");
    expect(harness.adapter.calls.length).toBe(0);
    expect((error as ProviderError).details).toMatchObject({
      requiredCapabilities: ["chat", "code"],
      paidFallbackAllowed: false,
    });
  });

  it("YUI delega para VIVY e a execução filha usa o modelo com `code`", async () => {
    const harness = createHarness({
      adapter: createMockProviderAdapter({
        respond: ({ invocation }) =>
          invocation === 1
            ? JSON.stringify({
                kind: "nexus.core.coordination.v1",
                action: "delegate",
                delegations: [
                  {
                    targetAssistant: "vivy",
                    objective: "estruturar o componente",
                    completionCriteria: "plano de componente",
                  },
                ],
              })
            : "Plano do componente.",
        // O concorrente sem `code` e com contexto maior ganharia a ordenação automática. Ele
        // existe para que a porta dos fundos seja observável: se a sub-execução voltasse a pedir
        // `["chat"]` fixo, a VIVY seria servida por este modelo e o teste quebraria. Com um único
        // modelo no catálogo, a sabotagem passava despercebida.
        competitorModels: [
          {
            key: "nexus/mock-generalist:free",
            capabilities: ["chat", "system_prompt", "structured_output"],
            contextWindow: 200_000,
          },
        ],
      }),
      seedConversation: conversation({ assistantIds: [YUI, ALICE, SCHWI, VIVY_ID] }),
    });

    const response = await harness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: {
        content: [{ type: "text", text: "Preciso de um componente de UI." }],
        requestId: randomUUID(),
        idempotencyKey: `yui-to-vivy-${randomUUID()}`,
        assistantKey: "yui",
      },
    });

    expect(response.execution.status).toBe("succeeded");
    expect(response.childExecutions).toHaveLength(1);
    // Três chamadas: planejamento da YUI, execução da VIVY e síntese da YUI. O índice 1 é
    // a execução delegada — é ela que tem de estar num modelo com `code`.
    expect(harness.adapter.calls.length).toBe(3);
    const child = harness.adapter.calls[1]!;
    expect(child.model).toBe(MOCK_FREE_MODEL_KEY);
    const childModel = harness.adapter.models.find((entry) => entry.key === child.model);
    expect(childModel?.capabilities).toContain("code");

    // Contraste no mesmo cenário: o nó raiz (YUI) e a síntese final não exigem `code` e por isso
    // usam o concorrente de contexto maior. A diferença entre as chamadas é o que mostra que a
    // exigência vem do perfil de destino, não do catálogo de modelos.
    expect(harness.adapter.calls[0]!.model).toBe("nexus/mock-generalist:free");
    expect(harness.adapter.calls[2]!.model).toBe("nexus/mock-generalist:free");
  });

  it("ALICE e SCHWI continuam funcionando com a seleção antiga (`chat`)", async () => {
    for (const key of ["alice", "schwi"] as const) {
      const harness = createHarness({
        // Com o mesmo concorrente no catálogo, ALICE e SCHWI — que não exigem `code` — devem
        // escolher o modelo de contexto maior. É o contraste que prova que a diferença de escolha
        // vem da exigência do perfil, não do mock.
        adapter: createMockProviderAdapter({
          respond: () => `Resposta de ${key}.`,
          competitorModels: [
            {
              key: "nexus/mock-generalist:free",
              capabilities: ["chat", "system_prompt", "structured_output"],
              contextWindow: 200_000,
            },
          ],
        }),
      });
      const response = await harness.engine.execute({
        ownerId: OWNER_ID,
        conversationId: harness.conversationId,
        request: {
          content: [{ type: "text", text: "olá" }],
          requestId: randomUUID(),
          idempotencyKey: `${key}-still-works-${randomUUID()}`,
          assistantKey: key,
        },
      });
      expect(response.execution.status, `${key} regrediu`).toBe("succeeded");
      expect(harness.adapter.calls.length).toBe(1);
      // Sem exigência de `code`, o critério é o de sempre: contexto maior vence.
      expect(harness.adapter.calls[0]!.model).toBe("nexus/mock-generalist:free");
    }
  });
});
