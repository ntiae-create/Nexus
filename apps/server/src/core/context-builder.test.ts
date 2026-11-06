import { describe, expect, it } from "vitest";
import type { Message } from "@nexus/shared";
import {
  buildExecutionContext,
  DEFAULT_CONSERVATIVE_CONTEXT_WINDOW,
  estimateTextUnits,
  renderMessagePartsToText,
} from "./context-builder.js";
import { CoreExecutionError } from "./errors.js";
import { OWNER_ID } from "./test-fixtures.js";

const CONVERSATION_ID = "11111111-2222-4333-8444-555555555555";

function message(overrides: Partial<Message> & Pick<Message, "sequence" | "role">): Message {
  return {
    id: crypto.randomUUID(),
    userId: OWNER_ID,
    conversationId: CONVERSATION_ID,
    status: "complete",
    content: [{ type: "text", text: `mensagem ${overrides.sequence}` }],
    formatVersion: 1,
    createdAt: new Date(Date.parse("2026-11-05T12:00:00.000Z") + overrides.sequence * 1000).toISOString(),
    ...overrides,
  } as Message;
}

function build(overrides: Partial<Parameters<typeof buildExecutionContext>[0]> = {}) {
  return buildExecutionContext({
    ownerId: OWNER_ID,
    conversationId: CONVERSATION_ID,
    systemInstructions: "Instruções de sistema imutáveis",
    persistedHistory: [],
    currentInputMessageId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    currentUserContent: "Entrada atual do usuário",
    modelContextWindow: 8_192,
    ...overrides,
  });
}

describe("NEXUS CORE context control", () => {
  it("keeps system instructions, history and the current input strictly separated", () => {
    const history = [
      message({ sequence: 0, role: "user", content: [{ type: "text", text: "primeira" }] }),
      message({
        sequence: 1,
        role: "assistant",
        assistantId: "00000000-0000-4000-8000-000000000001",
        content: [{ type: "text", text: "segunda" }],
      }),
    ];
    const built = build({ persistedHistory: history, modelContextWindow: 8_192 });

    expect(built.messages[0]).toEqual({
      role: "system",
      content: "Instruções de sistema imutáveis",
    });
    expect(built.messages.at(-1)).toEqual({
      role: "user",
      content: "Entrada atual do usuário",
    });
    expect(built.messages.slice(1, -1)).toEqual([
      { role: "user", content: "primeira" },
      { role: "assistant", content: "segunda" },
    ]);
    expect(built.report.includedHistoryCount).toBe(2);
    expect(built.includedMessageIds).toEqual([
      history[0]!.id,
      history[1]!.id,
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ]);
  });

  it("uses a conservative fallback when the model context window metadata is absent", () => {
    const built = build({ modelContextWindow: null });
    expect(built.report.usedFallbackWindow).toBe(true);
    expect(built.report.effectiveContextWindow).toBe(DEFAULT_CONSERVATIVE_CONTEXT_WINDOW);

    const invalid = build({ modelContextWindow: 0 });
    expect(invalid.report.usedFallbackWindow).toBe(true);
    expect(invalid.report.effectiveContextWindow).toBe(DEFAULT_CONSERVATIVE_CONTEXT_WINDOW);
  });

  it("never sends unlimited history and reports what was omitted", () => {
    const history = Array.from({ length: 60 }, (_, index) =>
      message({
        sequence: index,
        role: index % 2 === 0 ? "user" : "assistant",
        ...(index % 2 === 1
          ? { assistantId: "00000000-0000-4000-8000-000000000001" }
          : {}),
      }),
    );
    const built = build({ persistedHistory: history, modelContextWindow: 8_192 });

    expect(built.report.includedHistoryCount).toBeLessThanOrEqual(40);
    expect(built.report.omittedHistoryCount).toBeGreaterThan(0);
    expect(built.report.includedHistoryCount + built.report.omittedHistoryCount).toBe(60);
    // The most recent turns are preserved, in chronological order.
    const includedTexts = built.messages.slice(1, -1).map((item) => item.content);
    expect(includedTexts.at(-1)).toBe("mensagem 59");
    expect(includedTexts[0]).toBe(`mensagem ${60 - includedTexts.length}`);
  });

  it("drops whole messages instead of truncating content when the budget is exceeded", () => {
    const bigText = "x".repeat(12_000);
    const history = [
      message({ sequence: 0, role: "user", content: [{ type: "text", text: bigText }] }),
      message({ sequence: 1, role: "user", content: [{ type: "text", text: "recente" }] }),
    ];
    const built = build({ persistedHistory: history, modelContextWindow: 4_096 });

    const historyTexts = built.messages.slice(1, -1).map((item) => item.content);
    expect(historyTexts).toEqual(["recente"]);
    for (const text of historyTexts) {
      expect(text).not.toContain("...");
    }
    expect(built.report.omittedHistoryCount).toBe(1);
  });

  it("rejects assembly when mandatory content cannot fit instead of corrupting it", () => {
    let error: unknown;
    try {
      build({ currentUserContent: "y".repeat(20_000), modelContextWindow: 4_096 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CoreExecutionError);
    expect((error as CoreExecutionError).code).toBe("CONTEXT_LIMIT_EXCEEDED");
    expect((error as CoreExecutionError).details?.usedFallbackWindow).toBe(false);
  });

  it("rejects a cross-owner or cross-conversation message during assembly", () => {
    for (const tampered of [
      message({ sequence: 0, role: "user", userId: "00000000-0000-4000-8000-000000000005" }),
      message({
        sequence: 1,
        role: "user",
        conversationId: "99999999-2222-4333-8444-555555555555",
      }),
    ]) {
      expect(() => build({ persistedHistory: [tampered] })).toThrow(/Cross-owner/);
    }
  });

  it("ignores incomplete, cancelled and non-conversational messages", () => {
    const history: Message[] = [
      message({ sequence: 0, role: "user", status: "failed" }),
      message({ sequence: 1, role: "assistant", status: "pending", assistantId: "00000000-0000-4000-8000-000000000001" }),
      message({ sequence: 2, role: "core" }),
      message({ sequence: 3, role: "user", content: [{ type: "text", text: "válida" }] }),
    ];
    const built = build({ persistedHistory: history });
    expect(built.messages.slice(1, -1)).toEqual([{ role: "user", content: "válida" }]);
    expect(built.report.omittedHistoryCount).toBe(0);
  });

  it("orders history chronologically regardless of input array order", () => {
    const history = [
      message({ sequence: 3, role: "user", content: [{ type: "text", text: "quarta" }] }),
      message({ sequence: 1, role: "user", content: [{ type: "text", text: "segunda" }] }),
      message({ sequence: 2, role: "assistant", assistantId: "00000000-0000-4000-8000-000000000001", content: [{ type: "text", text: "terceira" }] }),
      message({ sequence: 0, role: "user", content: [{ type: "text", text: "primeira" }] }),
    ];
    const built = build({ persistedHistory: history });
    expect(built.messages.slice(1, -1).map((item) => item.content)).toEqual([
      "primeira",
      "segunda",
      "terceira",
      "quarta",
    ]);
  });

  it("reserves the requested output budget inside the effective window", () => {
    const built = build({
      modelContextWindow: 8_192,
      requestedMaxOutputTokens: 2_048,
    });
    expect(built.report.reservedOutputBudget).toBe(2_048);
    expect(built.report.availableInputBudget).toBe(8_192 - 2_048);
    expect(built.report.estimatedInputUnits).toBeLessThanOrEqual(
      built.report.availableInputBudget,
    );
  });

  it("caps an oversized model window and renders reference parts deterministically", () => {
    const built = build({ modelContextWindow: 5_000_000, policy: { maxContextWindowCap: 65_536 } });
    expect(built.report.effectiveContextWindow).toBe(65_536);
    expect(built.report.usedFallbackWindow).toBe(false);

    expect(
      renderMessagePartsToText([
        { type: "text", text: "texto" },
        { type: "reference", referenceId: "conv-1", label: "Conversa anterior" },
        { type: "structured", format: "application/json", data: { a: 1 } },
      ]),
    ).toBe(
      "texto\n[Referência conv-1 (Conversa anterior)]\n[Dados estruturados application/json]",
    );
  });

  it("estimates size monotonically and rejects empty rendered content", () => {
    expect(estimateTextUnits("")).toBe(1);
    expect(estimateTextUnits("a".repeat(300))).toBeGreaterThan(estimateTextUnits("a".repeat(30)));
    expect(() =>
      renderMessagePartsToText([{ type: "text", text: "   " }]),
    ).toThrow(CoreExecutionError);
  });
});
