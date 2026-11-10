import { describe, expect, it } from "vitest";
import { validateDelegationPlan } from "./delegation.js";
import { SERVER_DELEGATION_POLICY } from "./delegation-policy.js";
import { CoreExecutionError } from "./errors.js";

/**
 * Fase 0 — caracterização da ORDEM DE PRECEDÊNCIA dos erros de delegação.
 *
 * `delegation.test.ts` já cobre cada rejeição isoladamente: ciclo, profundidade, autorização e
 * volume produzem, cada um, seu código. O que não estava protegido é o que acontece quando um
 * plano viola **duas regras ao mesmo tempo** — e é justamente aí que a ordem importa, porque o
 * código reportado é o que fica registrado em auditoria e exibido ao usuário.
 *
 * A ordem documentada em `delegation.ts` é: ciclo → profundidade → autorização → volume.
 * Ela é intencional ("so that reported error codes stay stable and auditable"), então merece
 * caracterização: se alguém reordenar as verificações, os códigos mudam silenciosamente.
 *
 * Os testes são escritos por **precedência relativa**, não por implementação: cada caso monta um
 * plano que viola exatamente duas regras e afirma qual código vence. Não se fixa mensagem.
 */

const limits = {
  maxDelegationDepth: 2,
  maxDelegationsPerExecution: 3,
  maxTotalDelegations: 6,
};

function rejectionOf(
  input: Omit<Parameters<typeof validateDelegationPlan>[0], "policy">,
): string {
  try {
    // A política de produção é fornecida em um só lugar para todos os casos: este arquivo
    // testa **precedência entre as regras**, não a política (coberta à parte).
    validateDelegationPlan({ ...input, policy: SERVER_DELEGATION_POLICY });
  } catch (error) {
    expect(error).toBeInstanceOf(CoreExecutionError);
    return (error as CoreExecutionError).code;
  }
  throw new Error("Expected the delegation plan to be rejected");
}

describe("Fase 0 — precedência dos erros de delegação", () => {
  it("ciclo vence profundidade", () => {
    // Viola as duas: 'yui' já está na cadeia (ciclo) e a profundidade 3 excede o limite 2.
    const code = rejectionOf({
      specs: [{ targetAssistant: "yui", objective: "a" }],
      chainKeys: ["yui"],
      baseDepth: 3,
      limits,
    });
    expect(code).toBe("DELEGATION_CYCLE_DETECTED");
  });

  it("ciclo vence autorização", () => {
    // 'alice' é folha: não pode delegar. Mas antes disso, 'alice' já consta na cadeia.
    const code = rejectionOf({
      specs: [{ targetAssistant: "alice", objective: "a" }],
      chainKeys: ["yui", "alice"],
      baseDepth: 0,
      limits,
    });
    expect(code).toBe("DELEGATION_CYCLE_DETECTED");
  });

  it("ciclo vence volume", () => {
    // Quatro tarefas excedem maxDelegationsPerExecution (3), mas a primeira já é ciclo.
    const code = rejectionOf({
      specs: [
        { targetAssistant: "schwi", objective: "a" },
        { targetAssistant: "schwi", objective: "b" },
        { targetAssistant: "schwi", objective: "c" },
        { targetAssistant: "schwi", objective: "d" },
      ],
      chainKeys: ["yui", "schwi"],
      baseDepth: 0,
      limits: { ...limits, maxDelegationsPerExecution: 1 },
    });
    expect(code).toBe("DELEGATION_CYCLE_DETECTED");
  });

  it("profundidade vence autorização", () => {
    // Viola profundidade e autorização: quem delega é 'alice' (folha), a partir de profundidade
    // acima do limite. A profundidade é verificada antes, então ela vence.
    const code = rejectionOf({
      specs: [{ targetAssistant: "schwi", objective: "a" }],
      chainKeys: ["yui", "alice"],
      baseDepth: 5,
      limits,
    });
    expect(code).toBe("DELEGATION_DEPTH_EXCEEDED");
  });

  it("profundidade vence volume", () => {
    const code = rejectionOf({
      specs: [
        { targetAssistant: "alice", objective: "a" },
        { targetAssistant: "schwi", objective: "b" },
      ],
      chainKeys: ["yui"],
      baseDepth: 9,
      limits: { ...limits, maxTotalDelegations: 1 },
    });
    expect(code).toBe("DELEGATION_DEPTH_EXCEEDED");
  });

  it("autorização vence volume", () => {
    // 'alice' não pode delegar, e o plano também excede o volume. Autorização vem antes.
    const code = rejectionOf({
      specs: [{ targetAssistant: "schwi", objective: "a" }],
      chainKeys: ["yui", "alice"],
      baseDepth: 0,
      limits: { ...limits, maxTotalDelegations: 0 },
    });
    expect(code).toBe("DELEGATION_NOT_ALLOWED");
  });

  it("volume só aparece quando as demais regras passam", () => {
    // Contraprova: plano válido em ciclo/profundidade/autorização, mas grande demais.
    const code = rejectionOf({
      specs: [
        { targetAssistant: "alice", objective: "a" },
        { targetAssistant: "schwi", objective: "b" },
      ],
      chainKeys: ["yui"],
      baseDepth: 0,
      limits: { ...limits, maxDelegationsPerExecution: 1 },
    });
    expect(code).toBe("DELEGATION_LIMIT_EXCEEDED");
  });

  it("não inventa recusa quando o plano é válido", () => {
    // Guard contra falso positivo: a precedência não deve rejeitar um plano legítimo.
    expect(() =>
      validateDelegationPlan({
        specs: [
          { targetAssistant: "alice", objective: "a" },
          { targetAssistant: "schwi", objective: "b" },
        ],
        chainKeys: ["yui"],
        baseDepth: 0,
        limits,
      
        policy: SERVER_DELEGATION_POLICY,
      }),
    ).not.toThrow();
  });

  it("recusa plano sem assistente de origem com INVALID_DELEGATION_CONTRACT", () => {
    // Precede todas as demais: sem origem identificada não há como avaliar autorização.
    const code = rejectionOf({
      specs: [{ targetAssistant: "alice", objective: "a" }],
      chainKeys: [],
      baseDepth: 0,
      limits,
    });
    expect(code).toBe("INVALID_DELEGATION_CONTRACT");
  });
});
