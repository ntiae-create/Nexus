import { describe, expect, it } from "vitest";
import {
  COORDINATION_ENVELOPE_KIND,
  coreExecutionResponseSchema,
} from "@nexus/shared";
import { createMockProviderAdapter } from "./mock-provider.js";
import { ProviderError } from "../providers/index.js";
import { CoreExecutionError } from "./errors.js";
import {
  ALICE,
  OWNER_ID,
  OTHER_OWNER_ID,
  SCHWI,
  YUI,
  conversation,
  createHarness,
  runSummaries,
} from "./test-fixtures.js";

const randomRequestId = () => crypto.randomUUID();

function envelope(delegations: Array<{ target: "alice" | "schwi"; objective: string }>): string {
  return JSON.stringify({
    kind: COORDINATION_ENVELOPE_KIND,
    action: "delegate",
    delegations: delegations.map((item) => ({
      targetAssistant: item.target,
      objective: item.objective,
      completionCriteria: "resposta objetiva",
    })),
  });
}

async function expectCoreError(
  promise: Promise<unknown>,
  code: string,
): Promise<CoreExecutionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CoreExecutionError);
    expect((error as CoreExecutionError).code).toBe(code);
    return error as CoreExecutionError;
  }
  throw new Error(`Expected CoreExecutionError ${code} but the call succeeded`);
}

describe("NEXUS CORE execution engine", () => {
  it("scenario 1: executes a normal request end-to-end and persists the real provider answer", async () => {
    const adapter = createMockProviderAdapter({
      respond: ({ invocation }) => `Resposta real do provedor #${invocation}`,
    });
    const harness = createHarness({ adapter });

    const response = await harness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: {
        content: [{ type: "text", text: "Como organizo minha semana?" }],
        requestId: randomRequestId(),
        idempotencyKey: "normal-1",
        assistantKey: "yui",
      },
    });

    expect(coreExecutionResponseSchema.safeParse(response).success).toBe(true);
    expect(response.replayed).toBe(false);
    expect(response.execution.status).toBe("succeeded");
    expect(response.assistantMessage.content).toEqual([
      { type: "text", text: "Resposta real do provedor #1" },
    ]);
    expect(response.assistantMessage.assistantId).toBe(YUI);
    expect(response.execution.finalMessageId).toBe(response.assistantMessage.id);
    expect(response.inputMessage.content).toEqual([
      { type: "text", text: "Como organizo minha semana?" },
    ]);
    expect(response.steps).toHaveLength(1);
    expect(response.steps[0]!.status).toBe("succeeded");
    expect(response.results).toHaveLength(1);
    expect(response.modelSelection.modelKey).toContain(":free");
    expect(response.modelSelection.freeEligibility.costStatus).toBe("free_confirmed");
    expect(harness.calls()).toBe(1);

    // System instructions come from the frozen YUI profile, not from the client.
    const [call] = adapter.calls;
    expect(call!.messages[0]!.role).toBe("system");
    expect(call!.messages[0]!.content).toContain("YUI");
    expect(call!.messages.at(-1)).toEqual({
      role: "user",
      content: "Como organizo minha semana?",
    });

    const snapshot = harness.db.snapshot();
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.results[0]!.content).toEqual([
      { type: "text", data: { text: "Resposta real do provedor #1" } },
    ]);
  });

  it("scenario 2: executes with each of YUI, ALICE and SCHWI preserving their own identity", async () => {
    for (const [key, id, expectedName] of [
      ["yui", YUI, "YUI"],
      ["alice", ALICE, "ALICE"],
      ["schwi", SCHWI, "SCHWI"],
    ] as const) {
      const adapter = createMockProviderAdapter({
        respond: () => `Resposta de ${expectedName}`,
      });
      const harness = createHarness({ adapter });
      const response = await harness.engine.execute({
        ownerId: OWNER_ID,
        conversationId: harness.conversationId,
        request: {
          content: [{ type: "text", text: "Olá" }],
          requestId: randomRequestId(),
          idempotencyKey: `assistant-${key}`,
          assistantKey: key,
        },
      });

      expect(response.execution.assistantIds).toEqual([id]);
      expect(response.assistantMessage.assistantId).toBe(id);
      expect(response.execution.trace).toEqual([
        { assistantId: id, assistantKey: key, configVersion: "1.0.0" },
      ]);
      const system = adapter.calls[0]!.messages[0]!.content;
      expect(system).toContain(`Identidade ativa no NEXUS CORE: ${expectedName}`);
      expect(system).toContain(`(chave: ${key}`);
      // No cross-assistant instruction takeover.
      const otherNames = ["YUI", "ALICE", "SCHWI"].filter((name) => name !== expectedName);
      for (const other of otherNames) {
        expect(system).not.toContain(`Identidade ativa no NEXUS CORE: ${other}`);
      }
    }
  });

  it("scenario 3: recovers persisted conversation context in chronological order", async () => {
    const adapter = createMockProviderAdapter({ respond: () => "ok" });
    const harness = createHarness({
      adapter,
      history: [
        { role: "user", text: "Primeira pergunta" },
        { role: "assistant", text: "Primeira resposta" },
        { role: "user", text: "Segunda pergunta" },
        { role: "assistant", text: "Segunda resposta" },
      ],
    });

    const response = await harness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: {
        content: [{ type: "text", text: "Terceira pergunta" }],
        requestId: randomRequestId(),
        idempotencyKey: "context-1",
        assistantKey: "yui",
      },
    });

    const messages = adapter.calls[0]!.messages;
    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(messages.slice(1).map((message) => message.content)).toEqual([
      "Primeira pergunta",
      "Primeira resposta",
      "Segunda pergunta",
      "Segunda resposta",
      "Terceira pergunta",
    ]);
    expect(response.contextReport.includedHistoryCount).toBe(4);
    expect(response.contextReport.omittedHistoryCount).toBe(0);
    expect(response.contextReport.usedFallbackWindow).toBe(false);
  });

  it("scenario 4: isolates conversations and users at the engine boundary", async () => {
    const adapter = createMockProviderAdapter({ respond: () => "ok" });
    const harness = createHarness({ adapter, history: [{ role: "user", text: "segredo A" }] });
    const otherConversation = conversation({ assistantIds: [YUI] });
    harness.db.seedConversation(otherConversation);

    // Conversation without the requested assistant.
    await expectCoreError(
      harness.engine.execute({
        ownerId: OWNER_ID,
        conversationId: otherConversation.id,
        request: {
          content: [{ type: "text", text: "oi" }],
          requestId: randomRequestId(),
          idempotencyKey: "iso-1",
          assistantKey: "alice",
        },
      }),
      "ASSISTANT_NOT_IN_CONVERSATION",
    );

    // Another user's conversation is indistinguishable from a missing one.
    await expectCoreError(
      harness.engine.execute({
        ownerId: OTHER_OWNER_ID,
        conversationId: harness.conversationId,
        request: {
          content: [{ type: "text", text: "oi" }],
          requestId: randomRequestId(),
          idempotencyKey: "iso-2",
          assistantKey: "yui",
        },
      }),
      "CONVERSATION_NOT_FOUND",
    );
    expect(adapter.calls).toHaveLength(0);
    const persisted = harness.db.snapshot().messages;
    expect(
      persisted.some((message) => message.metadata?.requestId === "iso-2"),
    ).toBe(false);
  });

  it("scenario 5: resolves provider/model through Etapa 3A selection and records the metadata", async () => {
    const adapter = createMockProviderAdapter({
      modelKey: "qwen/qwen3-coder:free",
      contextWindow: 65_536,
    });
    const harness = createHarness({ adapter });

    const response = await harness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: {
        content: [{ type: "text", text: "escolha de modelo" }],
        requestId: randomRequestId(),
        idempotencyKey: "selection-1",
        assistantKey: "yui",
        parameters: { temperature: 0.2, maxOutputTokens: 256 },
      },
    });

    expect(response.modelSelection).toMatchObject({
      resolvedScope: "global",
      providerKey: "openrouter",
      modelKey: "qwen/qwen3-coder:free",
      contextWindow: 65_536,
    });
    expect(response.contextReport.reservedOutputBudget).toBe(256);
    expect(adapter.calls[0]!.parameters).toEqual({ temperature: 0.2, maxOutputTokens: 256 });
    expect(response.execution.metadata?.paidFallbackUsed).toBe(false);
    expect(response.execution.metadata?.modelKey).toBe("qwen/qwen3-coder:free");
  });

  it("scenario 6: blocks paid and unverifiable models without falling back or calling the provider", async () => {
    for (const costStatus of ["paid", "unknown"] as const) {
      const adapter = createMockProviderAdapter({ costStatus });
      const harness = createHarness({ adapter });

      await expect(
        harness.engine.execute({
          ownerId: OWNER_ID,
          conversationId: harness.conversationId,
          request: {
            content: [{ type: "text", text: "modelo bloqueado" }],
            requestId: randomRequestId(),
            idempotencyKey: `blocked-${costStatus}`,
            assistantKey: "yui",
          },
        }),
      ).rejects.toBeInstanceOf(ProviderError);

      expect(adapter.calls).toHaveLength(0);
      const runs = harness.db.snapshot().runs;
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("failed");
      expect(runs[0]!.finalMessageId).toBeUndefined();
      const messages = harness.db.snapshot().messages;
      expect(messages.filter((message) => message.role === "assistant")).toHaveLength(0);
      expect(String(runs[0]!.metadata?.failureCode)).toMatch(
        /^PROVIDER_(PAID_MODEL_BLOCKED|UNVERIFIED_PRICING_BLOCKED|MODEL_UNAVAILABLE)$/,
      );
    }
  });

  it("scenario 7: surfaces provider timeout and upstream failure without fabricating a reply", async () => {
    const failing = createMockProviderAdapter({
      respond: () => {
        throw new ProviderError("TIMEOUT", "Provider call exceeded the execution timeout", {
          providerKey: "openrouter",
        });
      },
    });
    const harness = createHarness({ adapter: failing });

    const error = await harness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: {
        content: [{ type: "text", text: "timeout" }],
        requestId: randomRequestId(),
        idempotencyKey: "timeout-1",
        assistantKey: "yui",
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("TIMEOUT");
    const snapshot = harness.db.snapshot();
    expect(snapshot.runs[0]!.status).toBe("failed");
    expect(snapshot.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
    expect(snapshot.results).toHaveLength(0);
  });

  it("scenario 7b: an aborted caller signal is reported as cancellation, not as a fake answer", async () => {
    const adapter = createMockProviderAdapter({
      respond: async ({ call }) => {
        // Simulate an in-flight provider call that observes the abort.
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (call.signal?.aborted) {
          throw new ProviderError("CANCELLED", "aborted", { providerKey: "openrouter" });
        }
        return "nunca deve chegar";
      },
    });
    const harness = createHarness({ adapter });
    const controller = new AbortController();
    const pending = harness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: {
        content: [{ type: "text", text: "cancele" }],
        requestId: randomRequestId(),
        idempotencyKey: "abort-1",
        assistantKey: "yui",
      },
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending.catch((error: unknown) => error as CoreExecutionError);

    expect(result).toBeInstanceOf(CoreExecutionError);
    expect((result as CoreExecutionError).code).toBe("EXECUTION_CANCELLED");
    const snapshot = harness.db.snapshot();
    expect(snapshot.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
  });

  it("scenario 8: cancels an execution and rejects mutations on terminal executions", async () => {
    const adapter = createMockProviderAdapter({ respond: () => "resposta" });
    const harness = createHarness({ adapter });
    const response = await harness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: {
        content: [{ type: "text", text: "vou cancelar" }],
        requestId: randomRequestId(),
        idempotencyKey: "cancel-1",
        assistantKey: "yui",
      },
    });

    await expectCoreError(
      harness.engine.cancel(OWNER_ID, response.execution.id),
      "EXECUTION_ALREADY_TERMINAL",
    );

    // A queued execution can be cancelled and becomes immutable afterwards.
    const queuedConversation = conversation();
    harness.db.seedConversation(queuedConversation);
    const message = harness.db.seedMessage({
      id: crypto.randomUUID(),
      userId: OWNER_ID,
      conversationId: queuedConversation.id,
      sequence: 0,
      role: "user",
      status: "complete",
      content: [{ type: "text", text: "pendente" }],
      formatVersion: 1,
      createdAt: "2026-11-05T12:00:00.000Z",
    });
    const queuedRun = await harness.db.withOwnerTransaction(
      { ownerId: OWNER_ID, actor: { type: "owner" } },
      (repos) =>
        repos.executions.create({
          id: crypto.randomUUID(),
          userId: OWNER_ID,
          conversationId: queuedConversation.id,
          requestId: randomRequestId(),
          idempotencyKey: `core:${queuedConversation.id}:queued-1`,
          status: "queued",
          assistantIds: [YUI],
          trace: [{ assistantId: YUI, assistantKey: "yui", configVersion: "1.0.0" }],
          inputMessageId: message.id,
          createdAt: "2026-11-05T12:00:00.000Z",
          formatVersion: 1,
        }),
    );

    const cancelled = await harness.engine.cancel(OWNER_ID, queuedRun.id);
    expect(cancelled.execution.status).toBe("cancelled");
    expect(cancelled.execution.finishedAt).toBeDefined();

    await expectCoreError(
      harness.engine.cancel(OWNER_ID, queuedRun.id),
      "EXECUTION_ALREADY_TERMINAL",
    );

    // The cancelled idempotency key cannot be reused to produce a fabricated answer.
    const reused = await harness.engine
      .execute({
        ownerId: OWNER_ID,
        conversationId: queuedConversation.id,
        request: {
          content: [{ type: "text", text: "pendente" }],
          requestId: randomRequestId(),
          idempotencyKey: "queued-1",
          assistantKey: "yui",
        },
      })
      .catch((error: unknown) => error as CoreExecutionError);
    expect(reused).toBeInstanceOf(CoreExecutionError);
    expect((reused as CoreExecutionError).code).toBe("EXECUTION_CANCELLED");

    // Terminal executions reject further mutation attempts.
    await expect(
      harness.db.withOwnerTransaction({ ownerId: OWNER_ID, actor: { type: "owner" } }, (repos) =>
        repos.executions.fail(queuedRun.id),
      ),
    ).rejects.toThrow(/Terminal executions are immutable/);
  });

  it("scenario 9: persists input/output messages, steps and results consistently", async () => {
    const adapter = createMockProviderAdapter({ respond: () => "conteúdo persistido" });
    const harness = createHarness({ adapter });
    const response = await harness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: {
        content: [{ type: "text", text: "persistir" }],
        requestId: randomRequestId(),
        idempotencyKey: "persist-1",
        assistantKey: "yui",
      },
    });

    const snapshot = harness.db.snapshot();
    expect(snapshot.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(snapshot.messages.map((message) => message.sequence)).toEqual([0, 1]);
    expect(snapshot.messages[1]!.runId).toBe(response.execution.id);
    expect(snapshot.runs[0]!.inputMessageId).toBe(response.inputMessage.id);
    expect(snapshot.runs[0]!.finalMessageId).toBe(response.assistantMessage.id);
    expect(snapshot.steps[0]!.runId).toBe(response.execution.id);
    expect(snapshot.steps[0]!.resultId).toBe(response.results[0]!.id);
    expect(snapshot.results[0]!.stepId).toBe(snapshot.steps[0]!.id);
    expect(response.results[0]!.status).toBe("succeeded");
  });

  it("scenario 10: YUI delegates to ALICE and returns the structured outcome", async () => {
    const adapter = createMockProviderAdapter({
      respond: ({ systemContent }) => {
        if (systemContent.includes("ALICE")) return "Análise da ALICE com evidências";
        if (systemContent.includes("Modo de síntese coordenadora")) {
          return "Síntese da YUI incorporando a análise da ALICE";
        }
        return envelope([{ target: "alice", objective: "analisar fontes" }]);
      },
    });
    const harness = createHarness({ adapter });
    const response = await harness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: {
        content: [{ type: "text", text: "Pesquise e analise" }],
        requestId: randomRequestId(),
        idempotencyKey: "delegate-alice",
        assistantKey: "yui",
      },
    });

    expect(response.execution.status).toBe("succeeded");
    expect(response.delegations).toHaveLength(1);
    const [delegation] = response.delegations;
    expect(delegation!.assistant.assistantKey).toBe("alice");
    expect(delegation!.assistant.assistantId).toBe(ALICE);
    expect(delegation!.objective).toBe("analisar fontes");
    expect(delegation!.outputText).toBe("Análise da ALICE com evidências");
    expect(delegation!.parentRunId).toBe(response.execution.id);
    expect(delegation!.delegationDepth).toBe(1);

    expect(response.childExecutions).toHaveLength(1);
    const child = response.childExecutions[0]!;
    expect(child.parentRunId).toBe(response.execution.id);
    expect(child.parentStepId).toBe(delegation!.parentStepId);
    expect(child.delegationDepth).toBe(1);
    expect(child.assistantIds).toEqual([ALICE]);
    expect(child.conversationId).toBe(harness.conversationId);

    expect(response.assistantMessage.assistantId).toBe(YUI);
    expect(response.assistantMessage.content).toEqual([
      { type: "text", text: "Síntese da YUI incorporando a análise da ALICE" },
    ]);
    expect(response.execution.trace.map((item) => item.assistantKey)).toEqual([
      "yui",
      "alice",
      "yui",
    ]);

    // The ALICE system prompt is ALICE's own frozen profile.
    const aliceCall = adapter.calls.find((call) =>
      call.messages[0]!.content.includes("ALICE"),
    );
    expect(aliceCall).toBeDefined();
    expect(aliceCall!.messages[0]!.content).toContain("Identidade ativa no NEXUS CORE: ALICE");
    expect(aliceCall!.messages[0]!.content).not.toContain("Identidade ativa no NEXUS CORE: YUI");
  });

  it("scenario 11: YUI delegates to SCHWI through an explicit client plan", async () => {
    const adapter = createMockProviderAdapter({
      respond: ({ systemContent }) => {
        if (systemContent.includes("SCHWI")) return "Plano lógico da SCHWI";
        if (systemContent.includes("Modo de síntese coordenadora")) return "Resposta final da YUI";
        return envelope([{ target: "schwi", objective: "planejar etapas" }]);
      },
    });
    const harness = createHarness({ adapter });
    const response = await harness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: {
        content: [{ type: "text", text: "Planeje a solução" }],
        requestId: randomRequestId(),
        idempotencyKey: "delegate-schwi",
        assistantKey: "yui",
        delegations: [{ targetAssistant: "schwi", objective: "planejar etapas" }],
      },
    });

    expect(response.delegations).toHaveLength(1);
    expect(response.delegations[0]!.assistant).toMatchObject({
      assistantId: SCHWI,
      assistantKey: "schwi",
    });
    expect(response.delegations[0]!.outputText).toBe("Plano lógico da SCHWI");
    expect(response.assistantMessage.content).toEqual([
      { type: "text", text: "Resposta final da YUI" },
    ]);
  });

  it("scenario 12: returns the delegated result to the coordinator execution", async () => {
    const adapter = createMockProviderAdapter({
      respond: ({ systemContent, userContents }) => {
        if (systemContent.includes("ALICE")) return "evidência coletada";
        if (systemContent.includes("Modo de síntese coordenadora")) {
          const prompt = userContents.join("\n");
          expect(prompt).toContain("evidência coletada");
          expect(prompt).toContain("Delegação 1 — ALICE");
          return "síntese final";
        }
        return envelope([{ target: "alice", objective: "coletar evidência" }]);
      },
    });
    const harness = createHarness({ adapter });
    const response = await harness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: {
        content: [{ type: "text", text: "colete e sintetize" }],
        requestId: randomRequestId(),
        idempotencyKey: "synthesis-1",
        assistantKey: "yui",
      },
    });

    expect(response.execution.status).toBe("succeeded");
    expect(response.assistantMessage.content).toEqual([{ type: "text", text: "síntese final" }]);
    const snapshot = harness.db.snapshot();
    const rootRun = snapshot.runs.find((run) => run.id === response.execution.id)!;
    expect(rootRun.finalMessageId).toBe(response.assistantMessage.id);
    expect(rootRun.trace.map((item) => item.assistantKey)).toEqual(["yui", "alice", "yui"]);
    expect(rootRun.assistantIds).toEqual([YUI, ALICE]);
    const synthesisStep = response.steps.find((step) => step.metadata?.phase === "synthesis");
    expect(synthesisStep).toBeDefined();
    expect(synthesisStep!.status).toBe("succeeded");
  });

  it("scenario 13: a delegated assistant failure is explicit and produces a partial execution", async () => {
    const adapter = createMockProviderAdapter({
      respond: ({ systemContent }) => {
        if (systemContent.includes("SCHWI")) {
          throw new ProviderError("UNAVAILABLE", "schwi upstream unavailable", {
            providerKey: "openrouter",
          });
        }
        if (systemContent.includes("ALICE")) return "Análise da ALICE";
        if (systemContent.includes("Modo de síntese coordenadora")) {
          return "Síntese com limitação declarada";
        }
        return envelope([
          { target: "alice", objective: "analisar" },
          { target: "schwi", objective: "planejar" },
        ]);
      },
    });
    const harness = createHarness({ adapter });
    const response = await harness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: {
        content: [{ type: "text", text: "peça ajuda à SCHWI" }],
        requestId: randomRequestId(),
        idempotencyKey: "delegated-failure",
        assistantKey: "yui",
      },
    });

    expect(response.execution.status).toBe("partial");
    expect(response.delegations).toHaveLength(1);
    expect(response.delegations[0]!.assistant.assistantKey).toBe("alice");
    expect(response.childExecutions).toHaveLength(2);
    const failedChild = response.childExecutions.find((child) => child.status === "failed");
    expect(failedChild).toBeDefined();
    expect(failedChild!.metadata?.failureCode).toBe("PROVIDER_UNAVAILABLE");
    expect(response.assistantMessage.content).toEqual([
      { type: "text", text: "Síntese com limitação declarada" },
    ]);
    expect(response.execution.metadata?.delegatedFailureCount).toBe(1);
  });

  it("scenario 14: blocks delegation cycles before any provider call", async () => {
    const adapter = createMockProviderAdapter({ respond: () => "não deveria executar" });
    const harness = createHarness({ adapter });

    const error = await expectCoreError(
      harness.engine.execute({
        ownerId: OWNER_ID,
        conversationId: harness.conversationId,
        request: {
          content: [{ type: "text", text: "ciclo" }],
          requestId: randomRequestId(),
          idempotencyKey: "cycle-1",
          assistantKey: "yui",
          delegations: [{ targetAssistant: "yui", objective: "auto delegação" }],
        },
      }),
      "DELEGATION_CYCLE_DETECTED",
    );
    expect(error.details?.targetAssistant).toBe("yui");

    // A non-coordinator cannot delegate at all.
    await expectCoreError(
      harness.engine.execute({
        ownerId: OWNER_ID,
        conversationId: harness.conversationId,
        request: {
          content: [{ type: "text", text: "alice delega" }],
          requestId: randomRequestId(),
          idempotencyKey: "cycle-2",
          assistantKey: "alice",
          delegations: [{ targetAssistant: "schwi", objective: "x" }],
        },
      }),
      "DELEGATION_NOT_ALLOWED",
    );
    expect(adapter.calls).toHaveLength(0);
  });

  it("scenario 15: enforces the delegation depth limit", async () => {
    const adapter = createMockProviderAdapter({ respond: () => "não deveria executar" });
    const harness = createHarness({ adapter });

    const deepSpec = {
      targetAssistant: "alice" as const,
      objective: "nível 1",
      subDelegations: [
        {
          targetAssistant: "schwi" as const,
          objective: "nível 2",
          subDelegations: [
            { targetAssistant: "alice" as const, objective: "nível 3" },
          ],
        },
      ],
    };

    const error = await expectCoreError(
      harness.engine.execute({
        ownerId: OWNER_ID,
        conversationId: harness.conversationId,
        request: {
          content: [{ type: "text", text: "profundidade" }],
          requestId: randomRequestId(),
          idempotencyKey: "depth-1",
          assistantKey: "yui",
          delegations: [deepSpec],
        },
      }),
      "DELEGATION_DEPTH_EXCEEDED",
    );
    expect(Number(error.details?.requestedDepth)).toBeGreaterThan(
      Number(error.details?.maxDelegationDepth),
    );
    expect(adapter.calls).toHaveLength(0);
  });

  it("scenario 16: enforces the per-execution delegation count limit", async () => {
    const adapter = createMockProviderAdapter({ respond: () => "não deveria executar" });
    const harness = createHarness({
      adapter,
      limits: { maxDelegationsPerExecution: 1 },
    });

    const error = await expectCoreError(
      harness.engine.execute({
        ownerId: OWNER_ID,
        conversationId: harness.conversationId,
        request: {
          content: [{ type: "text", text: "muitas delegações" }],
          requestId: randomRequestId(),
          idempotencyKey: "count-1",
          assistantKey: "yui",
          delegations: [
            { targetAssistant: "alice", objective: "a" },
            { targetAssistant: "schwi", objective: "b" },
          ],
        },
      }),
      "DELEGATION_LIMIT_EXCEEDED",
    );
    expect(error.details?.maxDelegationsPerExecution).toBe(1);
    expect(adapter.calls).toHaveLength(0);
  });

  it("scenario 17: deduplicates concurrent requests with the same idempotency key", async () => {
    const adapter = createMockProviderAdapter({
      respond: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return "resposta única";
      },
    });
    const harness = createHarness({ adapter });
    const request = {
      content: [{ type: "text" as const, text: "duplicado" }],
      requestId: randomRequestId(),
      idempotencyKey: "dedupe-1",
      assistantKey: "yui" as const,
    };

    const [first, second] = await Promise.allSettled([
      harness.engine.execute({ ownerId: OWNER_ID, conversationId: harness.conversationId, request }),
      harness.engine.execute({ ownerId: OWNER_ID, conversationId: harness.conversationId, request }),
    ]);

    const fulfilled = [first, second].filter((item) => item.status === "fulfilled");
    const rejected = [first, second].filter((item) => item.status === "rejected");
    expect(fulfilled.length + rejected.length).toBe(2);
    for (const rejection of rejected) {
      expect((rejection as PromiseRejectedResult).reason).toBeInstanceOf(CoreExecutionError);
      expect((rejection as PromiseRejectedResult).reason.code).toBe("EXECUTION_IN_PROGRESS");
    }
    expect(fulfilled).toHaveLength(1);
    expect(adapter.calls).toHaveLength(1);

    const snapshot = harness.db.snapshot();
    expect(snapshot.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(snapshot.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(snapshot.runs).toHaveLength(1);

    // A later retry replays the persisted execution instead of calling the provider again.
    const replay = await harness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.execution.id).toBe(snapshot.runs[0]!.id);
    expect(adapter.calls).toHaveLength(1);
  });

  it("scenario 17b: rejects idempotency reuse with a different payload", async () => {
    const adapter = createMockProviderAdapter({ respond: () => "ok" });
    const harness = createHarness({ adapter });
    const base = {
      requestId: randomRequestId(),
      idempotencyKey: "conflict-1",
      assistantKey: "yui" as const,
    };
    await harness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: { ...base, content: [{ type: "text", text: "primeiro" }] },
    });

    await expectCoreError(
      harness.engine.execute({
        ownerId: OWNER_ID,
        conversationId: harness.conversationId,
        request: {
          ...base,
          requestId: randomRequestId(),
          content: [{ type: "text", text: "diferente" }],
        },
      }),
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("scenario 17c: recovers the original failure when the same requestId is replayed", async () => {
    const adapter = createMockProviderAdapter({ respond: () => "ok" });
    const harness = createHarness({ adapter });
    harness.db.injectFault("messages.appendAssistant", 1);

    const requestId = randomRequestId();
    const failed = await harness.engine
      .execute({
        ownerId: OWNER_ID,
        conversationId: harness.conversationId,
        request: {
          content: [{ type: "text", text: "falha e repetição" }],
          requestId,
          idempotencyKey: "replay-failure-1",
          assistantKey: "yui",
        },
      })
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(CoreExecutionError);
    expect((failed as CoreExecutionError).code).toBe("PERSISTENCE_FAILED");

    // Reusing the same requestId is the same client operation: no new rows, no
    // fabricated answer, and an explicit terminal outcome.
    const replayed = await harness.engine
      .execute({
        ownerId: OWNER_ID,
        conversationId: harness.conversationId,
        request: {
          content: [{ type: "text", text: "falha e repetição" }],
          requestId,
          idempotencyKey: "replay-failure-1-retry",
          assistantKey: "yui",
        },
      })
      .catch((error: unknown) => error as CoreExecutionError);
    expect(replayed).toBeInstanceOf(CoreExecutionError);
    expect(["EXECUTION_ALREADY_TERMINAL", "IDEMPOTENCY_CONFLICT"]).toContain(
      (replayed as CoreExecutionError).code,
    );
    const snapshot = harness.db.snapshot();
    expect(snapshot.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
    expect(snapshot.runs).toHaveLength(1);
  });

  it("scenario 18: rejects cross-user access attempts without leaking data", async () => {
    const adapter = createMockProviderAdapter({ respond: () => "ok" });
    const harness = createHarness({ adapter });
    const response = await harness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: {
        content: [{ type: "text", text: "privado" }],
        requestId: randomRequestId(),
        idempotencyKey: "cross-1",
        assistantKey: "yui",
      },
    });

    await expectCoreError(
      harness.engine.inspect(OTHER_OWNER_ID, response.execution.id),
      "EXECUTION_NOT_FOUND",
    );
    await expectCoreError(
      harness.engine.cancel(OTHER_OWNER_ID, response.execution.id),
      "EXECUTION_NOT_FOUND",
    );
    await expectCoreError(
      harness.engine.getConversation(OTHER_OWNER_ID, harness.conversationId),
      "CONVERSATION_NOT_FOUND",
    );
    await expectCoreError(
      harness.engine.listMessages(OTHER_OWNER_ID, harness.conversationId),
      "CONVERSATION_NOT_FOUND",
    );
    expect(await harness.engine.listConversations(OTHER_OWNER_ID)).toEqual([]);

    const ownerInspection = await harness.engine.inspect(OWNER_ID, response.execution.id);
    expect(ownerInspection.execution.id).toBe(response.execution.id);

    // Every transaction used the authenticated owner as the RLS context.
    expect(harness.db.transactions.every((context) => context.actor.type === "owner")).toBe(true);
    expect(
      harness.db.transactions.some((context) => context.ownerId === OTHER_OWNER_ID),
    ).toBe(true);
  });

  it("scenario 19: rolls back and records a failed state when persistence fails", async () => {
    const adapter = createMockProviderAdapter({ respond: () => "resposta que não pode ser salva" });
    const harness = createHarness({ adapter });
    harness.db.injectFault("messages.appendAssistant", 1);

    const error = await harness.engine
      .execute({
        ownerId: OWNER_ID,
        conversationId: harness.conversationId,
        request: {
          content: [{ type: "text", text: "falha de persistência" }],
          requestId: randomRequestId(),
          idempotencyKey: "persist-fail-1",
          assistantKey: "yui",
        },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CoreExecutionError);
    expect((error as CoreExecutionError).code).toBe("PERSISTENCE_FAILED");

    const snapshot = harness.db.snapshot();
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]!.status).toBe("failed");
    expect(snapshot.runs[0]!.finalMessageId).toBeUndefined();
    expect(snapshot.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
    expect(snapshot.results).toHaveLength(0);

    // A retry is possible and does not duplicate the input message.
    const retried = await harness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: {
        content: [{ type: "text", text: "falha de persistência" }],
        requestId: randomRequestId(),
        idempotencyKey: "persist-fail-1-retry",
        assistantKey: "yui",
      },
    });
    expect(retried.execution.status).toBe("succeeded");
  });

  it("scenario 20: no error path ever produces or persists a fictitious response", async () => {
    const scenarios: Array<{
      name: string;
      adapter: ReturnType<typeof createMockProviderAdapter>;
      request?: { content: Array<{ type: "text"; text: string }> };
      expectedCodes: string[];
    }> = [
      {
        name: "empty model response",
        adapter: createMockProviderAdapter({ respond: () => "   " }),
        expectedCodes: ["EMPTY_MODEL_RESPONSE"],
      },
      {
        name: "upstream error",
        adapter: createMockProviderAdapter({
          respond: () => {
            throw new ProviderError("UPSTREAM_ERROR", "boom", { providerKey: "openrouter" });
          },
        }),
        expectedCodes: ["PROVIDER_UPSTREAM_ERROR"],
      },
      {
        name: "invalid provider response",
        adapter: createMockProviderAdapter({
          respond: () => {
            throw new ProviderError("INVALID_RESPONSE", "malformed", {
              providerKey: "openrouter",
            });
          },
        }),
        expectedCodes: ["PROVIDER_INVALID_RESPONSE"],
      },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const harness = createHarness({ adapter: scenario.adapter });
      const error = await harness.engine
        .execute({
          ownerId: OWNER_ID,
          conversationId: harness.conversationId,
          request: {
            content: [{ type: "text", text: `cenário ${scenario.name}` }],
            requestId: randomRequestId(),
            idempotencyKey: `no-fictitious-${index}`,
            assistantKey: "yui",
          },
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeDefined();
      const snapshot = harness.db.snapshot();
      expect(snapshot.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
      expect(snapshot.results).toHaveLength(0);
      expect(snapshot.runs[0]!.finalMessageId).toBeUndefined();
      expect(snapshot.runs[0]!.status).toBe("failed");
      expect(snapshot.runs[0]!.metadata?.failureCode).toBeDefined();
    }
  });

  it("exposes inspection data including child executions and contexts for the owner", async () => {
    const adapter = createMockProviderAdapter({
      respond: ({ systemContent }) => {
        if (systemContent.includes("ALICE")) return "saída ALICE";
        if (systemContent.includes("Modo de síntese coordenadora")) return "final";
        return envelope([{ target: "alice", objective: "revisar" }]);
      },
    });
    const harness = createHarness({ adapter });
    const response = await harness.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: {
        content: [{ type: "text", text: "inspecionar" }],
        requestId: randomRequestId(),
        idempotencyKey: "inspect-1",
        assistantKey: "yui",
      },
    });

    const inspection = await harness.engine.inspect(OWNER_ID, response.execution.id);
    expect(inspection.childExecutions).toHaveLength(1);
    expect(inspection.steps.length).toBeGreaterThanOrEqual(3);
    expect(
      runSummaries(inspection.childExecutions)[0],
    ).toMatchObject({ status: "succeeded", delegationDepth: 1 });
    expect(await harness.engine.listExecutions(OWNER_ID, harness.conversationId)).toHaveLength(2);
  });
});
