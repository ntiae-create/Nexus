import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CoreExecutionError } from "./errors.js";
import { defineDelegationPolicy } from "./delegation-policy.js";
import { createHarness, OWNER_ID } from "./test-fixtures.js";
import { createMockProviderAdapter } from "./mock-provider.js";

const OWNER = OWNER_ID;

/**
 * Fase 3 (G2) — a política chega ao **caminho real do engine**, não só às funções puras.
 *
 * Motivo deste arquivo: o teste de coerência entre prompt e validação (`delegation-policy.
 * hardening.phase3.test.ts`, caso 6) exercita `delegationTargetsFor` e `validateDelegationPlan`
 * diretamente. Uma sabotagem de revisão mostrou que ele **não** detecta o engine passar políticas
 * diferentes para os dois pontos — porque o engine não estava no caminho testado. Aqui o motor é
 * construído de verdade, com um provedor roteirizado, e a política é injetada por ele.
 *
 * O que se prova:
 *  - a política injetada no motor governa os alvos oferecidos no prompt de coordenação;
 *  - a mesma política governa a autorização da execução (o plano recusado é o mesmo que o prompt
 *    não ofereceu);
 *  - uma política inválida impede a construção do motor, e não falha no meio de uma conversa.
 */

const BLOCK_ALICE = defineDelegationPolicy({
  id: "test-engine-blocks-alice",
  maxTargetsPerCoordinator: 10,
  allowsTarget: ({ target }) => target.key !== "alice",
});

describe("Fase 3 — o engine aplica a política injetada nos dois pontos", () => {
  it("uma política inválida falha na construção do motor, não em execução", () => {
    expect(() =>
      createHarness({
        adapter: createMockProviderAdapter({ respond: () => "ok" }),
        delegationPolicy: {
          id: "invalida",
          maxTargetsPerCoordinator: Number.NaN,
          allowsTarget: () => true,
        } as never,
      }),
    ).toThrow(/maxTargetsPerCoordinator/);
  });

  it("o prompt de coordenação recebe os alvos da política injetada", async () => {
    const harness = createHarness({
      adapter: createMockProviderAdapter({ respond: () => "ok" }),
      delegationPolicy: BLOCK_ALICE,
    });

    // O prompt vai ao provedor; é a superfície observável do que o coordenador "pode" fazer.
    await harness.engine.execute({
      ownerId: OWNER,
      conversationId: harness.conversationId,
      request: {
        content: [{ type: "text", text: "planeje algo" }],
        requestId: randomUUID(),
        idempotencyKey: `engine-policy-${randomUUID()}`,
        assistantKey: "yui",
      },
    }).catch(() => undefined);

    const systemPrompts = harness.adapter.calls
      .flatMap((call) => call.messages)
      .filter((message) => message.role === "system")
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");

    // ALICE está bloqueada pela política: não pode ser oferecida ao coordenador.
    //
    // A asserção recorta a **linha de alvos autorizados** em vez de procurar o nome no prompt
    // inteiro: "alice" aparece legitimamente em outros trechos (histórico, identidade), e uma
    // busca global acusaria esses usos por acidente.
    const authorizedLine = systemPrompts
      .split("\n")
      .find((line) => line.includes("outro assistente autorizado"));
    expect(authorizedLine, "prompt de coordenação não encontrado").toBeDefined();
    expect(authorizedLine).toContain("schwi");
    expect(authorizedLine).not.toContain("alice");
  });

  it("a mesma política recusa o plano que o prompt não ofereceu", async () => {
    // O modelo tenta delegar para ALICE mesmo sem ela estar no prompt. Se a validação usasse
    // outra política (a padrão), o plano passaria — e teríamos a divergência que o endurecimento
    // existe para impedir.
    const harness = createHarness({
      adapter: createMockProviderAdapter({
        respond: () =>
          JSON.stringify({
            kind: "nexus.core.coordination.v1",
            action: "delegate",
            delegations: [
              { targetAssistant: "alice", objective: "pesquise", completionCriteria: "ok" },
            ],
          }),
      }),
      delegationPolicy: BLOCK_ALICE,
    });

    const error = await harness.engine
      .execute({
        ownerId: OWNER,
        conversationId: harness.conversationId,
        request: {
          content: [{ type: "text", text: "planeje algo" }],
          requestId: randomUUID(),
          idempotencyKey: `engine-policy-${randomUUID()}`,
          assistantKey: "yui",
        },
      })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CoreExecutionError);
    expect((error as CoreExecutionError).code).toBe("DELEGATION_NOT_ALLOWED");
    expect(JSON.stringify((error as CoreExecutionError).details)).toContain("alice");
  });
});
