import { describe, expect, it } from "vitest";
import {
  getAssistantProfileByKey,
  listAssistantProfiles,
  type AssistantProfile,
} from "@nexus/assistant-profiles";
import {
  assistantKeySchema,
  coreExecutionRequestSchema,
  delegationTaskSpecSchema,
  initialAssistantKeySchema,
} from "@nexus/shared";
import { canDelegate, delegationTargetsFor, validateDelegationPlan } from "./delegation.js";
import { CoreExecutionError } from "./errors.js";
import { assistantKeyOf, resolveCanonicalAssistantProfile } from "./instructions.js";

/**
 * Fase 1 — separação entre identificador e catálogo inicial (G1, G3).
 *
 * Regra desta suíte: os testes afirmam **capacidade** e **comportamento preservado**, nunca a
 * forma da implementação.
 *
 * O que muda nesta fase é o que o sistema *consegue expressar*: um identificador de assistente
 * deixa de ser a enumeração fechada de três literais e passa a ser uma forma validável, cuja
 * existência é decidida pelo registro. O que **não** muda é o que o sistema *faz*: as três
 * chaves continuam válidas, combinações incoerentes continuam recusadas, e a delegação continua
 * exatamente como estava (Fase 3).
 *
 * Nota de escopo: nenhum teste aqui cria uma quarta assistente. O que se prova é que a
 * *identidade* não a impede — a criação é decisão de dados das fases seguintes.
 */

const THREE_KEYS = ["yui", "alice", "schwi"] as const;

/** Chave bem formada que nenhum perfil registrado possui. */
const UNREGISTERED_KEY = "delta";

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("Fase 1 — identificador versus catálogo (G1)", () => {
  it("o schema de identificador aceita chaves fora do catálogo inicial", () => {
    // Núcleo da fase: a forma não conhece o catálogo. Antes, `assistantKeySchema` não existia e
    // todo contrato herdava `z.enum(["yui","alice","schwi"])`.
    for (const key of ["yui", "alice", "schwi", UNREGISTERED_KEY, "assistente-4", "a1"]) {
      expect(assistantKeySchema.safeParse(key).success, `deveria aceitar '${key}'`).toBe(true);
    }
  });

  it("o schema de identificador rejeita formas inválidas", () => {
    for (const key of ["YUI", "Yui", "-yui", "yui_1", "yui assistente", "", "a", "x".repeat(33)]) {
      expect(assistantKeySchema.safeParse(key).success, `deveria rejeitar '${key}'`).toBe(false);
    }
  });

  it("o catálogo inicial continua congelado e explícito", () => {
    // Compatibilidade: o alias continua sendo a enumeração das três chaves. A fase separa os
    // conceitos, não apaga o catálogo.
    expect(initialAssistantKeySchema.options).toEqual([...THREE_KEYS]);
    expect(listAssistantProfiles().map((profile) => profile.key)).toEqual([...THREE_KEYS]);
  });

  it("o contrato público continua aceitando as três chaves", () => {
    const base = {
      content: [{ type: "text" as const, text: "Olá" }],
      requestId: "0b6f5a5e-4f4f-4a2e-9b8f-1b2c3d4e5f60",
      idempotencyKey: "client-key-1",
    };
    for (const key of THREE_KEYS) {
      expect(
        coreExecutionRequestSchema.safeParse({ ...base, assistantKey: key }).success,
        `contrato deveria aceitar '${key}'`,
      ).toBe(true);
    }
  });
});

describe("Fase 1 — validação contra o registro, não contra o enum (G3)", () => {
  it("assistantKeyOf aceita cada perfil do registro", () => {
    for (const profile of listAssistantProfiles()) {
      expect(assistantKeyOf(profile)).toBe(profile.key);
    }
  });

  it("assistantKeyOf rejeita perfil cuja chave não resolve para o próprio perfil", () => {
    // Comportamento preservado: um objeto de perfil não pode reivindicar uma chave alheia.
    const forged: AssistantProfile = { ...getAssistantProfileByKey("alice")!, key: UNREGISTERED_KEY };
    const error = captureError(() => assistantKeyOf(forged));
    expect(error).toBeInstanceOf(CoreExecutionError);
    expect((error as CoreExecutionError).code).toBe("ASSISTANT_NOT_FOUND");
  });

  it("assistantKeyOf rejeita perfil cuja chave tem forma inválida", () => {
    const malformed: AssistantProfile = { ...getAssistantProfileByKey("alice")!, key: "ALICE" };
    const error = captureError(() => assistantKeyOf(malformed));
    expect(error).toBeInstanceOf(CoreExecutionError);
    expect((error as CoreExecutionError).code).toBe("ASSISTANT_NOT_FOUND");
  });

  it("chave desconhecida resolvida pelo registro dá ASSISTANT_NOT_FOUND", () => {
    const error = captureError(() =>
      resolveCanonicalAssistantProfile({ assistantKey: UNREGISTERED_KEY }),
    );
    expect(error).toBeInstanceOf(CoreExecutionError);
    expect((error as CoreExecutionError).code).toBe("ASSISTANT_NOT_FOUND");
  });

  it("chave com forma inválida também dá ASSISTANT_NOT_FOUND", () => {
    // O erro observável é o mesmo do caso anterior: distinguir "malformada" de "inexistente"
    // vazaria informação sobre o catálogo para o cliente.
    const error = captureError(() => resolveCanonicalAssistantProfile({ assistantKey: "NOT A KEY" }));
    expect(error).toBeInstanceOf(CoreExecutionError);
    expect((error as CoreExecutionError).code).toBe("ASSISTANT_NOT_FOUND");
  });

  it("id e key incoerentes continuam recusados com o mesmo erro", () => {
    const alice = getAssistantProfileByKey("alice")!;
    const error = captureError(() =>
      resolveCanonicalAssistantProfile({ assistantId: alice.id, assistantKey: "yui" }),
    );
    expect(error).toBeInstanceOf(CoreExecutionError);
    expect((error as CoreExecutionError).code).toBe("ASSISTANT_NOT_FOUND");
  });

  it("resolver por id ou por chave devolve o mesmo perfil", () => {
    for (const profile of listAssistantProfiles()) {
      expect(resolveCanonicalAssistantProfile({ assistantId: profile.id }).key).toBe(profile.key);
      expect(resolveCanonicalAssistantProfile({ assistantKey: profile.key }).id).toBe(profile.id);
    }
  });

  it("ausência de identificador continua sendo erro, nunca escolha de padrão", () => {
    const error = captureError(() => resolveCanonicalAssistantProfile({}));
    expect(error).toBeInstanceOf(CoreExecutionError);
    expect((error as CoreExecutionError).code).toBe("ASSISTANT_NOT_FOUND");
  });
});

describe("Fase 1 — fronteira de escopo: delegação intacta (Fase 3)", () => {
  it("a política de delegação continua exatamente a mesma", () => {
    // Fase 1 muda o TIPO da chave, não a política. Derivar DELEGATION_TARGETS dos perfis é
    // Fase 3 (G2); este teste congela a política atual para provar que não avançamos.
    expect([...delegationTargetsFor("yui")]).toEqual(["alice", "schwi"]);
    expect(delegationTargetsFor("alice")).toEqual([]);
    expect(delegationTargetsFor("schwi")).toEqual([]);
    expect(canDelegate("yui")).toBe(true);
    expect(canDelegate("alice")).toBe(false);
    expect(canDelegate("schwi")).toBe(false);
  });

  it("um identificador fora do catálogo não delega e não quebra", () => {
    // O tipo passou a aceitar a chave; a política responde com "nenhum alvo". Antes do tipo
    // novo, esta chamada nem poderia ser escrita.
    expect(delegationTargetsFor(UNREGISTERED_KEY)).toEqual([]);
    expect(canDelegate(UNREGISTERED_KEY)).toBe(false);
  });

  it("delegar para um identificador fora do catálogo é recusado pela política", () => {
    const error = captureError(() =>
      validateDelegationPlan({
        specs: [{ targetAssistant: UNREGISTERED_KEY, objective: "tarefa" }],
        chainKeys: ["yui"],
        baseDepth: 0,
        limits: { maxDelegationDepth: 1, maxDelegationsPerExecution: 3, maxTotalDelegations: 6 },
      }),
    );
    expect(error).toBeInstanceOf(CoreExecutionError);
    expect((error as CoreExecutionError).code).toBe("DELEGATION_NOT_ALLOWED");
  });

  it("YUI continua delegando para ALICE e SCHWI", () => {
    const limits = { maxDelegationDepth: 1, maxDelegationsPerExecution: 3, maxTotalDelegations: 6 };
    expect(() =>
      validateDelegationPlan({
        specs: [
          { targetAssistant: "alice", objective: "pesquisar" },
          { targetAssistant: "schwi", objective: "planejar" },
        ],
        chainKeys: ["yui"],
        baseDepth: 0,
        limits,
      }),
    ).not.toThrow();
  });

  it("o contrato de delegação aceita a forma da chave e recusa forma inválida", () => {
    // Fase 1: `targetAssistant` é forma-validado, e a autorização de QUEM pode receber a tarefa
    // continua na política acima.
    expect(delegationTaskSpecSchema.safeParse({ targetAssistant: "alice", objective: "x" }).success).toBe(true);
    expect(
      delegationTaskSpecSchema.safeParse({ targetAssistant: UNREGISTERED_KEY, objective: "x" }).success,
    ).toBe(true);
    expect(
      delegationTaskSpecSchema.safeParse({ targetAssistant: "Alice!", objective: "x" }).success,
    ).toBe(false);
  });
});
