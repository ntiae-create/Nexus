import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CANONICAL_PROFILE_REGISTRY } from "@nexus/assistant-profiles";
import type { AssistantKey } from "@nexus/shared";
import { ProviderError } from "../providers/index.js";
import { CoreExecutionError } from "./errors.js";
import { resolveModelCapabilitiesFor } from "./model-preference.js";
import { MOCK_FREE_MODEL_KEY, createMockProviderAdapter } from "./mock-provider.js";
import { ALICE, OWNER_ID, SCHWI, YUI, conversation, createHarness } from "./test-fixtures.js";

/**
 * Fase 4 — auditoria de seleção: `:free` inegociável, sem fallback silencioso, nada quebrado nas
 * quatro assistentes.
 *
 * Separado de `vivy.phase4.test.ts` de propósito: aquele arquivo prova *a VIVY*; este prova as
 * **regressões** que a chegada dela poderia causar no que já funcionava — política de custo,
 * recusa explícita e comportamento das outras três.
 *
 * O concorrente sem `code` aparece em vários casos porque é ele que torna a exigência observável:
 * com um único modelo `:free` no catálogo, "escolheu o modelo com `code`" e "escolheu o único
 * modelo" são a mesma frase. Uma sabotagem em `resolveModelCapabilitiesFor` passava com o catálogo
 * de um modelo só.
 */

const VIVY_ID = "00000000-0000-4000-8000-000000000004";
const GENERALIST = "nexus/mock-generalist:free";

const withCompetitor = () => [
  {
    key: GENERALIST,
    capabilities: ["chat", "system_prompt", "structured_output"] as const,
    contextWindow: 200_000,
  },
];

async function runFor(
  key: AssistantKey,
  options: Parameters<typeof createMockProviderAdapter>[0],
): Promise<{ error: unknown; model: string | undefined; status: string | undefined }> {
  const harness = createHarness({
    adapter: createMockProviderAdapter(options),
    seedConversation: conversation({ assistantIds: [YUI, ALICE, SCHWI, VIVY_ID] }),
  });
  try {
    const response = await harness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: {
        content: [{ type: "text", text: "olá" }],
        requestId: randomUUID(),
        idempotencyKey: `audit-${key}-${randomUUID()}`,
        assistantKey: key,
      },
    });
    return {
      error: undefined,
      model: harness.adapter.calls[0]?.model,
      status: response.execution.status,
    };
  } catch (thrown: unknown) {
    return { error: thrown, model: harness.adapter.calls[0]?.model, status: undefined };
  }
}

describe("Fase 4 — a política `free_only` não é afrouxada pela exigência de `code`", () => {
  it("um modelo com `code` mas de preço desconhecido NÃO é usado para a VIVY", async () => {
    // O ponto exato: exigir `code` não pode virar desculpa para aceitar um modelo não verificado
    // como gratuito. A capability é um filtro a mais, nunca uma dispensa da política de custo.
    const result = await runFor("vivy", {
      respond: () => "não deveria responder",
      costStatus: "unknown",
      competitorModels: withCompetitor(),
    });

    expect(result.model).toBeUndefined();
    expect(result.error).toBeInstanceOf(ProviderError);
    expect(result.status).toBeUndefined();
  });

  it("o modelo escolhido para a VIVY é `:free` e `free_confirmed`", async () => {
    const harness = createHarness({
      adapter: createMockProviderAdapter({
        respond: () => "ok",
        competitorModels: withCompetitor(),
      }),
      seedConversation: conversation({ assistantIds: [YUI, ALICE, SCHWI, VIVY_ID] }),
    });

    const response = await harness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: {
        content: [{ type: "text", text: "olá" }],
        requestId: randomUUID(),
        idempotencyKey: `vivy-free-${randomUUID()}`,
        assistantKey: "vivy",
      },
    });

    expect(response.modelSelection.modelKey).toBe(MOCK_FREE_MODEL_KEY);
    expect(response.modelSelection.modelKey.endsWith(":free")).toBe(true);
    expect(response.modelSelection.freeEligibility.costStatus).toBe("free_confirmed");
    expect(response.modelSelection.freeEligibility.eligible).toBe(true);
  });
});

describe("Fase 4 — sem fallback silencioso para modelo incompatível", () => {
  it("modelo único sem `code` → erro explícito, nenhuma chamada ao provedor", async () => {
    const result = await runFor("vivy", {
      respond: () => "não deveria responder",
      capabilities: ["chat", "system_prompt", "structured_output"],
    });

    expect(result.model).toBeUndefined();
    expect(result.error).toBeInstanceOf(ProviderError);
    expect((result.error as ProviderError).code).toBe("MODEL_UNAVAILABLE");
    expect((result.error as ProviderError).details).toMatchObject({
      requiredCapabilities: ["chat", "code"],
      paidFallbackAllowed: false,
    });
  });

  it("o erro não é degradado para `PROVIDER_MODEL_UNAVAILABLE` dentro de uma execução aceita", async () => {
    // Sem `catch` silencioso: a execução não termina com status de sucesso. O `run` pode ser
    // registrado como falho na persistência, mas a resposta **não** sai como `succeeded`.
    const result = await runFor("vivy", {
      respond: () => "não deveria responder",
      capabilities: ["chat"],
    });
    expect(result.status).not.toBe("succeeded");
    expect(result.status).toBeUndefined();
  });

  it("capability exigida ausente derruba até um concorrente com contexto enorme", async () => {
    // Nenhum dos dois tem `code`. O maior contexto não é critério suficiente.
    const result = await runFor("vivy", {
      respond: () => "não deveria responder",
      capabilities: ["chat", "system_prompt"],
      competitorModels: [
        { key: GENERALIST, capabilities: ["chat", "reasoning"], contextWindow: 1_000_000 },
      ],
    });
    expect((result.error as ProviderError).code).toBe("MODEL_UNAVAILABLE");
  });

  it("as três assistentes anteriores não passaram a exigir `code`", async () => {
    // Se alguém aplicasse a exigência a toda execução — em vez de derivá-la do perfil —, ALICE e
    // SCHWI perderiam modelos compatíveis sem que nenhum teste de VIVY falhasse.
    for (const key of ["yui", "alice", "schwi"] as const) {
      expect(resolveModelCapabilitiesFor(CANONICAL_PROFILE_REGISTRY.getByKey(key)!)).toEqual([
        "chat",
      ]);
    }
    expect(resolveModelCapabilitiesFor(CANONICAL_PROFILE_REGISTRY.getByKey("vivy")!)).toEqual([
      "chat",
      "code",
    ]);
  });
});

describe("Fase 4 — as quatro assistentes executam", () => {
  it("cada uma responde, e só a VIVY é servida por um modelo com `code`", async () => {
    for (const key of ["yui", "alice", "schwi", "vivy"] as const) {
      const harness = createHarness({
        adapter: createMockProviderAdapter({
          respond: () => `Resposta de ${key}.`,
          competitorModels: withCompetitor(),
        }),
        seedConversation: conversation({ assistantIds: [YUI, ALICE, SCHWI, VIVY_ID] }),
      });

      const response = await harness.engine.execute({
        ownerId: OWNER_ID,
        conversationId: harness.conversationId,
        request: {
          content: [{ type: "text", text: "olá" }],
          requestId: randomUUID(),
          idempotencyKey: `all-four-${key}-${randomUUID()}`,
          assistantKey: key,
        },
      });

      expect(response.execution.status, `${key} não respondeu`).toBe("succeeded");
      expect(harness.adapter.calls.length, `${key} fez chamadas demais`).toBe(1);

      const usedModel = harness.adapter.calls[0]!.model;
      const descriptor = harness.adapter.models.find((entry) => entry.key === usedModel)!;
      if (key === "vivy") {
        expect(descriptor.capabilities, "VIVY sem `code`").toContain("code");
        expect(usedModel).toBe(MOCK_FREE_MODEL_KEY);
      } else {
        expect(usedModel, `${key} não deveria exigir code`).toBe(GENERALIST);
      }
    }
  });

  it("o `assistantKey` de VIVY é aceito pelo contrato e o de uma chave inválida não", async () => {
    const harness = createHarness({
      adapter: createMockProviderAdapter({ respond: () => "ok" }),
      seedConversation: conversation({ assistantIds: [YUI, ALICE, SCHWI, VIVY_ID] }),
    });

    // Chave inexistente continua sendo erro de contrato — a Fase 4 não abriu a enumeração.
    const error = await harness.engine
      .execute({
        ownerId: OWNER_ID,
        conversationId: harness.conversationId,
        request: {
          content: [{ type: "text", text: "olá" }],
          requestId: randomUUID(),
          idempotencyKey: `invalid-key-${randomUUID()}`,
          assistantKey: "vivy2" as AssistantKey,
        },
      })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CoreExecutionError);
  });

  it("VIVY não recebe ferramentas: nenhuma execução tenta avaliar permissão de tool", async () => {
    // `tools: []` é a expressão de "somente chat". Este teste garante que a fase não introduziu um
    // caminho de execução de ferramenta ao lado da conversa.
    const vivy = CANONICAL_PROFILE_REGISTRY.getByKey("vivy")!;
    expect(vivy.tools).toEqual([]);
    for (const profile of CANONICAL_PROFILE_REGISTRY.list()) {
      expect(profile.tools.filter((tool) => tool.enabledByDefault)).toEqual([]);
    }
  });
});
