import { describe, expect, it } from "vitest";
import { createCoreService, EXECUTION_TIMEOUT_MS } from "./core-service.js";
import { ApiError } from "./api-client.js";
import {
  createRecordingFetch,
  createTestClient,
  errorBody,
  jsonResponse,
  TEST_TOKEN,
} from "../test-support/fakes.js";
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
  USER_MESSAGE_ID,
  YUI_ID,
} from "../test-support/core-fixtures.js";

function setup(handler: Parameters<typeof createRecordingFetch>[0]) {
  const { fetchImpl, calls } = createRecordingFetch(handler);
  const service = createCoreService(createTestClient(fetchImpl));
  return { service, calls };
}

describe("core service — conversations", () => {
  it("lists conversations from the real envelope and forwards the Bearer token", async () => {
    const conversation = makeConversation({ title: "Planejamento" });
    const { service, calls } = setup(() => jsonResponse(200, { conversations: [conversation] }));

    const result = await service.listConversations(TEST_TOKEN);

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(CONVERSATION_ID);
    expect(result[0]!.assistantIds).toEqual([YUI_ID]);
    expect(calls[0]!.url).toContain("/v1/conversations");
    expect(calls[0]!.init.method).toBe("GET");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TEST_TOKEN}`,
    );
  });

  it("returns an empty array for an owner with no conversations", async () => {
    const { service } = setup(() => jsonResponse(200, { conversations: [] }));
    await expect(service.listConversations(TEST_TOKEN)).resolves.toEqual([]);
  });

  it("rejects a malformed conversation list instead of rendering unknown fields", async () => {
    const { service } = setup(() =>
      jsonResponse(200, { conversations: [{ id: "not-a-uuid", title: "x" }] }),
    );

    await expect(service.listConversations(TEST_TOKEN)).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("creates a conversation with the canonical assistant uuid", async () => {
    const created = makeConversation({ assistantIds: [ALICE_ID] });
    const { service, calls } = setup(() => jsonResponse(201, { conversation: created }));

    const conversation = await service.createConversation(TEST_TOKEN, {
      assistantIds: [ALICE_ID],
      title: "Pesquisa",
    });

    expect(conversation.assistantIds).toEqual([ALICE_ID]);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ assistantIds: [ALICE_ID], title: "Pesquisa" });
  });

  it("omits optional fields instead of sending undefined values", async () => {
    const { service, calls } = setup(() =>
      jsonResponse(201, { conversation: makeConversation() }),
    );

    await service.createConversation(TEST_TOKEN, { assistantIds: [YUI_ID] });

    expect(calls[0]!.body).toEqual({ assistantIds: [YUI_ID] });
    expect(Object.keys(calls[0]!.body as object)).not.toContain("title");
  });

  it("maps a 401 to an error the session layer can act on", async () => {
    const { service } = setup(() => jsonResponse(401, errorBody("UNAUTHORIZED", "expired")));

    const error = await service.listConversations(TEST_TOKEN).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).meansSessionInvalid).toBe(true);
  });
});

describe("core service — messages", () => {
  it("loads the persisted history with the afterSequence query", async () => {
    const messages = [makeUserMessage(), makeAssistantMessage()];
    const { service, calls } = setup(() => jsonResponse(200, { messages }));

    const result = await service.listMessages(TEST_TOKEN, CONVERSATION_ID, { afterSequence: 1 });

    expect(result.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(calls[0]!.url).toContain(`/v1/conversations/${CONVERSATION_ID}/messages?afterSequence=1`);
  });

  it("encodes the conversation id in the path", async () => {
    const { service, calls } = setup(() => jsonResponse(200, { messages: [] }));

    await service.listMessages(TEST_TOKEN, "weird/../id");

    expect(calls[0]!.url).toContain("/v1/conversations/weird%2F..%2Fid/messages");
  });

  it("sends idempotencyKey, requestId and assistantKey in the exact contract shape", async () => {
    const { service, calls } = setup(() => jsonResponse(201, makeExecutionResponse()));

    await service.sendMessage(TEST_TOKEN, CONVERSATION_ID, {
      content: [{ type: "text", text: "Olá, YUI" }],
      requestId: REQUEST_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      assistantKey: "yui",
    });

    expect(calls[0]!.body).toEqual({
      content: [{ type: "text", text: "Olá, YUI" }],
      requestId: REQUEST_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      assistantKey: "yui",
    });
    // No provider, model or price field is ever sent by the client.
    expect(Object.keys(calls[0]!.body as object).sort()).toEqual([
      "assistantKey",
      "content",
      "idempotencyKey",
      "requestId",
    ]);
  });

  it("raises the timeout budget for an execution to exceed the server's 60s provider limit", async () => {
    const { service } = setup(() => jsonResponse(201, makeExecutionResponse()));

    const started = Date.now();
    await service.sendMessage(TEST_TOKEN, CONVERSATION_ID, {
      content: [{ type: "text", text: "Olá" }],
      requestId: REQUEST_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      assistantKey: "yui",
    });

    expect(Date.now() - started).toBeLessThan(EXECUTION_TIMEOUT_MS);
    expect(EXECUTION_TIMEOUT_MS).toBeGreaterThan(60_000);
  });

  it("returns the persisted assistant message, never a locally built one", async () => {
    const { service } = setup(() => jsonResponse(201, makeExecutionResponse()));

    const response = await service.sendMessage(TEST_TOKEN, CONVERSATION_ID, {
      content: [{ type: "text", text: "Olá" }],
      requestId: REQUEST_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      assistantKey: "yui",
    });

    expect(response.assistantMessage.id).toBe(ASSISTANT_MESSAGE_ID);
    expect(response.inputMessage.id).toBe(USER_MESSAGE_ID);
    expect(response.execution.id).toBe(RUN_ID);
  });

  it("rejects an execution body that does not match the contract", async () => {
    const { service } = setup(() => jsonResponse(201, { execution: { id: RUN_ID } }));

    await expect(
      service.sendMessage(TEST_TOKEN, CONVERSATION_ID, {
        content: [{ type: "text", text: "Olá" }],
        requestId: REQUEST_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        assistantKey: "yui",
      }),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("keeps the CORE error code so the UI can explain it specifically", async () => {
    const { service } = setup(() =>
      jsonResponse(422, errorBody("ASSISTANT_NOT_IN_CONVERSATION", "not a participant")),
    );

    const error = await service
      .sendMessage(TEST_TOKEN, CONVERSATION_ID, {
        content: [{ type: "text", text: "Olá" }],
        requestId: REQUEST_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        assistantKey: "alice",
      })
      .catch((caught: unknown) => caught);

    expect((error as ApiError).code).toBe("ASSISTANT_NOT_IN_CONVERSATION");
    expect((error as ApiError).status).toBe(422);
  });
});

describe("core service — executions", () => {
  it("lists the conversation executions", async () => {
    const { service, calls } = setup(() =>
      jsonResponse(200, { executions: [makeRun(), makeRun({ id: "22222222-2222-4222-8222-999999999999" })] }),
    );

    const runs = await service.listExecutions(TEST_TOKEN, CONVERSATION_ID);

    expect(runs).toHaveLength(2);
    expect(calls[0]!.url).toContain(`/v1/conversations/${CONVERSATION_ID}/executions`);
  });

  it("reads a single execution inspection", async () => {
    const { service, calls } = setup(() => jsonResponse(200, makeInspection()));

    const inspection = await service.getExecution(TEST_TOKEN, RUN_ID);

    expect(inspection.execution.id).toBe(RUN_ID);
    expect(calls[0]!.url).toContain(`/v1/executions/${RUN_ID}`);
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("cancels through POST /cancel without a body", async () => {
    const { service, calls } = setup(() =>
      jsonResponse(200, makeInspection({ execution: makeRun({ status: "cancelled" }) })),
    );

    const inspection = await service.cancelExecution(TEST_TOKEN, RUN_ID);

    expect(inspection.execution.status).toBe("cancelled");
    expect(calls[0]!.url).toContain(`/v1/executions/${RUN_ID}/cancel`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBeUndefined();
  });
});

describe("core service — security invariants", () => {
  it("never sends the token in the body or the URL", async () => {
    const { service, calls } = setup(() => jsonResponse(200, { conversations: [] }));

    await service.listConversations(TEST_TOKEN);

    expect(calls[0]!.url).not.toContain(TEST_TOKEN);
    expect(JSON.stringify(calls[0]!.body ?? {})).not.toContain(TEST_TOKEN);
  });

  it("does not attach an Authorization header when no token is provided", async () => {
    const { service, calls } = setup(() => jsonResponse(200, { conversations: [] }));

    await service.listConversations("");

    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
