import { describe, expect, it, vi } from "vitest";
import {
  conversationAssistantLabel,
  conversationLabel,
  conversationTimestampLabel,
  createConversationService,
  describeApiError,
  isCoreErrorCode,
  meansSignedOut,
  messageTimestampLabel,
} from "./conversation-service.js";
import type { CoreService } from "./core-service.js";
import { ApiError } from "./api-client.js";
import { ASSISTANT_CATALOG } from "../lib/assistants.js";
import { createIdempotencyKey, createUuid } from "../lib/ids.js";
import {
  ALICE_ID,
  ASSISTANT_MESSAGE_ID,
  CONVERSATION_ID,
  IDEMPOTENCY_KEY,
  makeAssistantMessage,
  makeConversation,
  makeExecutionResponse,
  makeInspection,
  makeRun,
  makeUserMessage,
  REQUEST_ID,
  RUN_ID,
  YUI_ID,
} from "../test-support/core-fixtures.js";
import { TEST_OWNER_ID, TEST_TOKEN } from "../test-support/fakes.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function stubService(overrides: Partial<CoreService> = {}): CoreService {
  const notStubbed = (name: string) => () =>
    Promise.reject(new Error(`unstubbed core service method: ${name}`));
  return {
    listConversations: notStubbed("listConversations") as CoreService["listConversations"],
    getConversation: notStubbed("getConversation") as CoreService["getConversation"],
    createConversation: notStubbed("createConversation") as CoreService["createConversation"],
    listMessages: notStubbed("listMessages") as CoreService["listMessages"],
    sendMessage: notStubbed("sendMessage") as CoreService["sendMessage"],
    listExecutions: notStubbed("listExecutions") as CoreService["listExecutions"],
    getExecution: notStubbed("getExecution") as CoreService["getExecution"],
    cancelExecution: notStubbed("cancelExecution") as CoreService["cancelExecution"],
    ...overrides,
  };
}

const scheduler = (callback: () => void) => callback();

describe("identifiers", () => {
  it("generates v4 UUIDs the contract accepts for requestId", () => {
    for (let index = 0; index < 20; index += 1) {
      expect(createUuid()).toMatch(UUID_PATTERN);
    }
  });

  it("generates a different idempotency key for every message", () => {
    const keys = new Set(Array.from({ length: 50 }, () => createIdempotencyKey("msg")));
    expect(keys.size).toBe(50);
    for (const key of keys) {
      expect(key.length).toBeLessThanOrEqual(200);
      expect(key.startsWith("msg:")).toBe(true);
    }
  });
});

describe("conversation loading", () => {
  it("lists conversations and flags an empty inbox", async () => {
    const service = createConversationService({
      service: stubService({ listConversations: async () => [] }),
      token: TEST_TOKEN,
    });

    const result = await service.list();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.isEmpty).toBe(true);
      expect(result.data.conversations).toEqual([]);
    }
  });

  it("returns the owner conversations without inventing any", async () => {
    const conversation = makeConversation({ title: "Planejamento" });
    const service = createConversationService({
      service: stubService({ listConversations: async () => [conversation] }),
      token: TEST_TOKEN,
    });

    const result = await service.list();

    expect(result.ok && result.data.conversations).toEqual([conversation]);
  });

  it("flags a signed-out result when the server answers 401", async () => {
    const service = createConversationService({
      service: stubService({
        listConversations: async () => {
          throw new ApiError({ kind: "http", status: 401, message: "expired" });
        },
      }),
      token: TEST_TOKEN,
    });

    const result = await service.list();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.signedOut).toBe(true);
      expect(result.message).toContain("sessão expirou");
    }
  });

  it("keeps a network failure as a retryable message, not as an empty list", async () => {
    const service = createConversationService({
      service: stubService({
        listConversations: async () => {
          throw new ApiError({ kind: "network", message: "sem conexão" });
        },
      }),
      token: TEST_TOKEN,
    });

    const result = await service.list();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe("sem conexão");
  });

  it("creates a conversation with the selected assistant uuid", async () => {
    const createConversation = vi.fn(async () => makeConversation({ assistantIds: [ALICE_ID] }));
    const service = createConversationService({
      service: stubService({ createConversation }),
      token: TEST_TOKEN,
    });

    const result = await service.create({ assistant: ASSISTANT_CATALOG[1]! });

    expect(result.ok).toBe(true);
    expect(createConversation).toHaveBeenCalledWith(
      TEST_TOKEN,
      { assistantIds: [ALICE_ID] },
      expect.anything(),
    );
  });

  it("loads a conversation's history in server order", async () => {
    const service = createConversationService({
      service: stubService({
        listMessages: async () => [makeUserMessage(), makeAssistantMessage()],
      }),
      token: TEST_TOKEN,
    });

    const result = await service.history(CONVERSATION_ID);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.map((message) => message.role)).toEqual(["user", "assistant"]);
  });
});

describe("chat session — sending", () => {
  it("returns the reloaded history after a successful send", async () => {
    const listMessages = vi.fn(async () => [makeUserMessage(), makeAssistantMessage()]);
    const service = createConversationService({
      service: stubService({
        sendMessage: async () => makeExecutionResponse(),
        listMessages,
      }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).send({
      requestId: REQUEST_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      assistantKey: "yui",
      text: "Olá, YUI",
    });

    expect(result.kind).toBe("delivered");
    if (result.kind === "delivered") {
      expect(result.status).toBe("succeeded");
      expect(result.messages).toHaveLength(2);
      expect(result.persisted.assistant.id).toBe(ASSISTANT_MESSAGE_ID);
    }
    expect(listMessages).toHaveBeenCalledTimes(1);
  });

  it("keeps the server-returned messages when the history reload fails", async () => {
    const service = createConversationService({
      service: stubService({
        sendMessage: async () => makeExecutionResponse(),
        listMessages: async () => {
          throw new ApiError({ kind: "network", message: "caiu" });
        },
      }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).send({
      requestId: REQUEST_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      assistantKey: "yui",
      text: "Olá",
    });

    expect(result.kind).toBe("delivered");
    if (result.kind === "delivered") {
      // The reload failed, but the persisted pair is still available — nothing is lost.
      expect(result.messages).toBeNull();
      expect(result.persisted.user.id).toBe("33333333-3333-4333-8333-333333333333");
      expect(result.persisted.assistant.id).toBe(ASSISTANT_MESSAGE_ID);
    }
  });

  it("rejects with a specific message when the assistant is not in the conversation", async () => {
    const service = createConversationService({
      service: stubService({
        sendMessage: async () => {
          throw new ApiError({
            kind: "http",
            status: 422,
            code: "ASSISTANT_NOT_IN_CONVERSATION",
            message: "not a participant",
          });
        },
      }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).send({
      requestId: REQUEST_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      assistantKey: "alice",
      text: "Olá",
    });

    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.message).toContain("não participa desta conversa");
  });

  it("turns a 401 into signed_out", async () => {
    const service = createConversationService({
      service: stubService({
        sendMessage: async () => {
          throw new ApiError({ kind: "http", status: 401, message: "expired" });
        },
      }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).send({
      requestId: REQUEST_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      assistantKey: "yui",
      text: "Olá",
    });

    expect(result.kind).toBe("signed_out");
  });
});

describe("chat session — network loss and recovery (idempotency)", () => {
  it("follows the already-admitted run after a transport failure instead of resending", async () => {
    const sendMessage = vi.fn(async () => {
      throw new ApiError({ kind: "network", message: "conexão caiu", retryable: true });
    });
    const listExecutions = vi.fn(async () => [makeRun({ status: "running" })]);
    const getExecution = vi.fn(async () => makeInspection({ execution: makeRun({ status: "succeeded" }) }));

    const service = createConversationService({
      service: stubService({
        sendMessage,
        listExecutions,
        getExecution,
        listMessages: async () => [makeUserMessage(), makeAssistantMessage()],
      }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).send(
      {
        requestId: REQUEST_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        assistantKey: "yui",
        text: "Olá",
      },
      { followOptions: { scheduler } },
    );

    // The message was admitted, so the persisted run is followed — never re-POSTed.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(listExecutions).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("delivered");
  });

  it("recovers an execution that was still running (EXECUTION_IN_PROGRESS)", async () => {
    const sendMessage = vi.fn(async () => {
      throw new ApiError({
        kind: "http",
        status: 409,
        code: "EXECUTION_IN_PROGRESS",
        message: "already running",
        retryable: true,
      });
    });
    const getExecution = vi.fn(async () =>
      makeInspection({ execution: makeRun({ status: "partial" }) }),
    );

    const service = createConversationService({
      service: stubService({
        sendMessage,
        listExecutions: async () => [makeRun({ status: "running" })],
        getExecution,
        listMessages: async () => [makeUserMessage(), makeAssistantMessage()],
      }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).send(
      {
        requestId: REQUEST_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        assistantKey: "yui",
        text: "Olá",
      },
      { followOptions: { scheduler } },
    );

    expect(result.kind).toBe("delivered");
    if (result.kind === "delivered") expect(result.status).toBe("partial");
  });

  it("says the message was not sent when the server never admitted it", async () => {
    const service = createConversationService({
      service: stubService({
        sendMessage: async () => {
          throw new ApiError({ kind: "network", message: "offline", retryable: true });
        },
        listExecutions: async () => [],
      }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).send({
      requestId: REQUEST_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      assistantKey: "yui",
      text: "Olá",
    });

    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.message).toContain("não foi enviada");
  });

  it("stays unknown when even the recovery listing fails", async () => {
    const service = createConversationService({
      service: stubService({
        sendMessage: async () => {
          throw new ApiError({ kind: "network", message: "offline", retryable: true });
        },
        listExecutions: async () => {
          throw new ApiError({ kind: "network", message: "offline" });
        },
      }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).send({
      requestId: REQUEST_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      assistantKey: "yui",
      text: "Olá",
    });

    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.message).toContain("não foi possível confirmar");
      expect(result.runId).toBeNull();
    }
  });

  it("reports a persisted failure without fabricating a reply", async () => {
    const service = createConversationService({
      service: stubService({
        sendMessage: async () => {
          throw new ApiError({ kind: "network", message: "offline", retryable: true });
        },
        listExecutions: async () => [makeRun({ status: "running" })],
        getExecution: async () =>
          makeInspection({
            execution: makeRun({ status: "failed", metadata: { failureCode: "PROVIDER_TIMEOUT" } }),
          }),
        listMessages: async () => [makeUserMessage()],
      }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).send(
      {
        requestId: REQUEST_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        assistantKey: "yui",
        text: "Olá",
      },
      { followOptions: { scheduler } },
    );

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.message).toContain("PROVIDER_TIMEOUT");
      expect(result.messages).toHaveLength(1);
    }
  });

  it("reports a cancelled run as cancelled, with no answer", async () => {
    const service = createConversationService({
      service: stubService({
        sendMessage: async () => {
          throw new ApiError({ kind: "network", message: "offline", retryable: true });
        },
        listExecutions: async () => [makeRun({ status: "running" })],
        getExecution: async () =>
          makeInspection({ execution: makeRun({ status: "cancelled", finalMessageId: undefined }) }),
        listMessages: async () => [makeUserMessage()],
      }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).send(
      {
        requestId: REQUEST_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        assistantKey: "yui",
        text: "Olá",
      },
      { followOptions: { scheduler } },
    );

    expect(result.kind).toBe("cancelled");
  });

  it("cancels through the CORE and reports an already-finished run calmly", async () => {
    const cancelExecution = vi.fn(async () => makeInspection({ execution: makeRun({ status: "cancelled" }) }));
    const service = createConversationService({
      service: stubService({ cancelExecution }),
      token: TEST_TOKEN,
    });

    const outcome = await service.chat(CONVERSATION_ID).cancel(RUN_ID);

    expect(outcome.kind).toBe("cancelled");
    expect(cancelExecution).toHaveBeenCalledWith(TEST_TOKEN, RUN_ID, expect.anything());
  });

  it("follows a run and reloads the history when it terminates", async () => {
    const service = createConversationService({
      service: stubService({
        getExecution: async () => makeInspection({ execution: makeRun({ status: "succeeded" }) }),
        listMessages: async () => [makeUserMessage(), makeAssistantMessage()],
      }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).follow(RUN_ID, { scheduler });

    expect(result.outcome.kind).toBe("succeeded");
    expect(result.messages).toHaveLength(2);
  });

  it("discovers the run id of a message still being sent, by requestId", async () => {
    const service = createConversationService({
      service: stubService({
        listExecutions: async () => [makeRun({ requestId: "99999999-9999-4999-8999-999999999999" }), makeRun()],
      }),
      token: TEST_TOKEN,
    });

    const run = await service.chat(CONVERSATION_ID).findRun(REQUEST_ID, { scheduler });

    expect(run?.id).toBe(RUN_ID);
  });

  it("gives up discovery without throwing when the list keeps failing", async () => {
    const service = createConversationService({
      service: stubService({
        listExecutions: async () => {
          throw new ApiError({ kind: "network", message: "offline" });
        },
      }),
      token: TEST_TOKEN,
    });

    const run = await service.chat(CONVERSATION_ID).findRun(REQUEST_ID, {
      scheduler,
      maxAttempts: 3,
    });

    expect(run).toBeNull();
  });
});

describe("presentation helpers", () => {
  it("names an untitled conversation instead of showing null", () => {
    expect(conversationLabel(makeConversation({ title: null }))).toBe("Conversa sem título");
    expect(conversationLabel(makeConversation({ title: "  " }))).toBe("Conversa sem título");
    expect(conversationLabel(makeConversation({ title: "Pesquisa" }))).toBe("Pesquisa");
  });

  it("lists the participating assistants by name", () => {
    expect(conversationAssistantLabel(makeConversation({ assistantIds: [YUI_ID, ALICE_ID] }))).toBe(
      "YUI · ALICE",
    );
    expect(conversationAssistantLabel(makeConversation({ assistantIds: [] }))).toBe(
      "Sem assistente definido",
    );
  });

  it("formats timestamps and degrades gracefully", () => {
    const conversation = makeConversation({ updatedAt: "2026-02-03T10:11:12.000Z" });
    expect(conversationTimestampLabel(conversation)).not.toBeNull();
    expect(
      conversationTimestampLabel(makeConversation({ updatedAt: "not-a-date" })),
    ).toBeNull();
    expect(
      messageTimestampLabel(makeUserMessage({ createdAt: "2026-02-03T10:11:12.000Z" })),
    ).not.toBeNull();
  });

  it("recognises only codes the contract allows", () => {
    expect(isCoreErrorCode("IDEMPOTENCY_CONFLICT")).toBe(true);
    expect(isCoreErrorCode("NOT_A_CORE_CODE")).toBe(false);
    expect(isCoreErrorCode(null)).toBe(false);
  });

  it("explains provider failures without leaking provider internals", () => {
    const message = describeApiError(
      new ApiError({
        kind: "http",
        status: 502,
        code: "PROVIDER_INVALID_RESPONSE",
        message: "OpenRouter returned 402 for key sk-or-v1-secret",
      }),
    );
    expect(message).toContain("provedor de IA");
    expect(message).not.toContain("sk-or-v1-secret");
    expect(message).not.toContain("OpenRouter");
  });

  it("never echoes an unknown contract message verbatim", () => {
    const message = describeApiError(
      new ApiError({
        kind: "http",
        status: 500,
        code: "SOMETHING_INTERNAL",
        message: "stack trace with /srv/app/internal/path.ts:42",
      }),
    );
    expect(message).not.toContain("/srv/app");
    expect(message).toContain("servidor encontrou um erro");
  });

  it("identifies 401 as a signed-out condition", () => {
    expect(meansSignedOut(new ApiError({ kind: "http", status: 401, message: "x" }))).toBe(true);
    expect(meansSignedOut(new ApiError({ kind: "network", message: "x" }))).toBe(false);
    expect(meansSignedOut(new Error("boom"))).toBe(false);
  });

  it("uses the real owner id from the contract in conversation fixtures", () => {
    expect(makeConversation().userId).toBe(TEST_OWNER_ID);
  });
});
