import { describe, expect, it, vi } from "vitest";
import {
  cancelRun,
  describeRunStatus,
  failureCodeOf,
  followExecution,
  isTerminalRunStatus,
  loadAssistantMessageForRun,
  messageText,
  pollDelayFor,
  POLL_DELAYS_MS,
  recoverRunByRequestId,
  sendChatMessage,
} from "./execution-service.js";
import type { CoreService, SendMessageInput } from "./core-service.js";
import { ApiError } from "./api-client.js";
import {
  ASSISTANT_MESSAGE_ID,
  CONVERSATION_ID,
  IDEMPOTENCY_KEY,
  makeAssistantMessage,
  makeExecutionResponse,
  makeInspection,
  makeRun,
  REQUEST_ID,
  RUN_ID,
  TEST_RUN,
} from "../test-support/core-fixtures.js";
import { TEST_TOKEN } from "../test-support/fakes.js";

/**
 * A hand-written `CoreService` stub: no HTTP, no timers of its own, no provider call. Every
 * test states explicitly what the server would answer.
 */
function stubService(overrides: Partial<CoreService> = {}): CoreService {
  const notStubbed = (name: string) => () =>
    Promise.reject(new Error(`unstubbed core service method: ${name}`));

  return {
    listConversations: notStubbed("listConversations") as CoreService["listConversations"],
    listAssistants: notStubbed("listAssistants") as CoreService["listAssistants"],
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

/** Deterministic scheduler: runs callbacks immediately, counting delays. */
function immediateScheduler(delays: number[] = []) {
  return (callback: () => void, delayMs: number) => {
    delays.push(delayMs);
    callback();
  };
}

describe("terminal states and delays", () => {
  it("treats only the four contract statuses as terminal", () => {
    expect(isTerminalRunStatus("succeeded")).toBe(true);
    expect(isTerminalRunStatus("partial")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
    expect(isTerminalRunStatus("queued")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
  });

  it("backs off and then holds a steady, bounded interval", () => {
    expect(POLL_DELAYS_MS[0]!).toBeLessThan(POLL_DELAYS_MS[POLL_DELAYS_MS.length - 1]!);
    expect(pollDelayFor(0)).toBe(POLL_DELAYS_MS[0]);
    expect(pollDelayFor(999)).toBe(POLL_DELAYS_MS[POLL_DELAYS_MS.length - 1]);
    expect(pollDelayFor(-5)).toBe(POLL_DELAYS_MS[0]);
    // Never faster than the first delay: polling cannot become a busy loop.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(pollDelayFor(attempt)).toBeGreaterThanOrEqual(POLL_DELAYS_MS[0]!);
    }
  });

  it("reads the persisted failureCode and explains each terminal state", () => {
    const failed = makeRun({ status: "failed", metadata: { failureCode: "PROVIDER_TIMEOUT" } });
    expect(failureCodeOf(failed)).toBe("PROVIDER_TIMEOUT");
    expect(describeRunStatus(failed)).toContain("PROVIDER_TIMEOUT");
    expect(describeRunStatus(makeRun({ status: "cancelled" }))).toContain("cancelada");
    expect(describeRunStatus(makeRun({ status: "partial" }))).toContain("parcial");
    expect(describeRunStatus(makeRun({ status: "running" }))).toContain("processando");
  });

  it("treats an absent failureCode honestly", () => {
    expect(failureCodeOf(makeRun({ status: "failed", metadata: {} }))).toBeNull();
    expect(describeRunStatus(makeRun({ status: "failed" }))).toContain("Nenhuma resposta");
  });

  it("extracts only text parts of a persisted message", () => {
    const message = makeAssistantMessage({
      content: [
        { type: "text", text: "linha 1" },
        { type: "reference", referenceId: "ref-1", label: "fonte" },
        { type: "text", text: "linha 2" },
      ],
    });
    expect(messageText(message)).toBe("linha 1\nlinha 2");
  });
});

describe("followExecution", () => {
  it("stops as soon as the run succeeds", async () => {
    const getExecution = vi.fn(async () => makeInspection());
    const delays: number[] = [];

    const outcome = await followExecution({
      service: stubService({ getExecution }),
      token: TEST_TOKEN,
      runId: RUN_ID,
      options: { scheduler: immediateScheduler(delays) },
    });

    expect(outcome.kind).toBe("succeeded");
    expect(getExecution).toHaveBeenCalledTimes(1);
    // No delay is spent after a terminal observation.
    expect(delays).toEqual([]);
  });

  it("polls queued → running → succeeded and reports progress", async () => {
    const statuses = ["queued", "running", "succeeded"] as const;
    let index = 0;
    const progress: string[] = [];
    const getExecution = vi.fn(async () =>
      makeInspection({ execution: makeRun({ status: statuses[Math.min(index++, 2)]! }) }),
    );

    const outcome = await followExecution({
      service: stubService({ getExecution }),
      token: TEST_TOKEN,
      runId: RUN_ID,
      options: {
        scheduler: immediateScheduler(),
        onProgress: (run) => progress.push(run.status),
      },
    });

    expect(outcome.kind).toBe("succeeded");
    expect(getExecution).toHaveBeenCalledTimes(3);
    expect(progress).toEqual(["queued", "running", "succeeded"]);
  });

  it("reports partial as a terminal state with a real answer", async () => {
    const outcome = await followExecution({
      service: stubService({
        getExecution: async () => makeInspection({ execution: makeRun({ status: "partial" }) }),
      }),
      token: TEST_TOKEN,
      runId: RUN_ID,
      options: { scheduler: immediateScheduler() },
    });

    expect(outcome.kind).toBe("partial");
  });

  it("reports failed with the persisted failure code, never a fake answer", async () => {
    const outcome = await followExecution({
      service: stubService({
        getExecution: async () =>
          makeInspection({
            execution: makeRun({ status: "failed", metadata: { failureCode: "EMPTY_MODEL_RESPONSE" } }),
          }),
      }),
      token: TEST_TOKEN,
      runId: RUN_ID,
      options: { scheduler: immediateScheduler() },
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.message).toContain("EMPTY_MODEL_RESPONSE");
      expect(outcome.run.finalMessageId).toBeDefined();
    }
  });

  it("reports cancelled and stops polling", async () => {
    const getExecution = vi.fn(async () =>
      makeInspection({ execution: makeRun({ status: "cancelled" }) }),
    );

    const outcome = await followExecution({
      service: stubService({ getExecution }),
      token: TEST_TOKEN,
      runId: RUN_ID,
      options: { scheduler: immediateScheduler() },
    });

    expect(outcome.kind).toBe("cancelled");
    expect(getExecution).toHaveBeenCalledTimes(1);
  });

  it("survives transient network errors while the run keeps running", async () => {
    let call = 0;
    const getExecution = vi.fn(async () => {
      call += 1;
      // Real transport failures arrive as retryable (see `api-client.ts`).
      if (call <= 2) throw new ApiError({ kind: "network", message: "offline", retryable: true });
      return makeInspection({ execution: makeRun({ status: "succeeded" }) });
    });

    const outcome = await followExecution({
      service: stubService({ getExecution }),
      token: TEST_TOKEN,
      runId: RUN_ID,
      options: { scheduler: immediateScheduler(), maxTransientFailures: 3 },
    });

    expect(outcome.kind).toBe("succeeded");
  });

  it("gives up after too many consecutive transient failures", async () => {
    const getExecution = vi.fn(async () => {
      throw new ApiError({ kind: "network", message: "offline", retryable: true });
    });

    const outcome = await followExecution({
      service: stubService({ getExecution }),
      token: TEST_TOKEN,
      runId: RUN_ID,
      options: { scheduler: immediateScheduler(), maxTransientFailures: 2 },
    });

    expect(outcome.kind).toBe("unknown");
    expect(getExecution).toHaveBeenCalledTimes(3);
  });

  it("stops immediately on a non-retryable error", async () => {
    const getExecution = vi.fn(async () => {
      throw new ApiError({ kind: "http", status: 404, message: "gone" });
    });

    const outcome = await followExecution({
      service: stubService({ getExecution }),
      token: TEST_TOKEN,
      runId: RUN_ID,
      options: { scheduler: immediateScheduler() },
    });

    expect(outcome.kind).toBe("unknown");
    expect(getExecution).toHaveBeenCalledTimes(1);
  });

  it("returns unauthorized on 401 so the app can leave the session", async () => {
    const outcome = await followExecution({
      service: stubService({
        getExecution: async () => {
          throw new ApiError({ kind: "http", status: 401, message: "expired" });
        },
      }),
      token: TEST_TOKEN,
      runId: RUN_ID,
      options: { scheduler: immediateScheduler() },
    });

    expect(outcome.kind).toBe("unauthorized");
  });

  it("stops after the attempt budget instead of polling forever", async () => {
    const getExecution = vi.fn(async () =>
      makeInspection({ execution: makeRun({ status: "running" }) }),
    );

    const outcome = await followExecution({
      service: stubService({ getExecution }),
      token: TEST_TOKEN,
      runId: RUN_ID,
      options: { scheduler: immediateScheduler(), maxAttempts: 4 },
    });

    expect(outcome.kind).toBe("unknown");
    expect(getExecution).toHaveBeenCalledTimes(4);
  });

  it("does not issue any request when the signal is already aborted", async () => {
    const getExecution = vi.fn(async () => makeInspection());
    const controller = new AbortController();
    controller.abort();

    const outcome = await followExecution({
      service: stubService({ getExecution }),
      token: TEST_TOKEN,
      runId: RUN_ID,
      options: { signal: controller.signal, scheduler: immediateScheduler() },
    });

    expect(outcome.kind).toBe("aborted");
    expect(getExecution).not.toHaveBeenCalled();
  });
});

describe("sendChatMessage", () => {
  it("returns the persisted input and assistant messages", async () => {
    const outcome = await sendChatMessage({
      service: stubService({ sendMessage: async () => makeExecutionResponse() }),
      token: TEST_TOKEN,
      conversationId: CONVERSATION_ID,
      text: "Olá, YUI",
      assistantKey: "yui",
      requestId: REQUEST_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(outcome.userMessage.id).toBe("33333333-3333-4333-8333-333333333333");
    expect(outcome.assistantMessage.id).toBe(ASSISTANT_MESSAGE_ID);
    expect(outcome.status).toBe("succeeded");
    expect(outcome.run.id).toBe(RUN_ID);
  });

  it("keeps partial distinct from succeeded", async () => {
    const outcome = await sendChatMessage({
      service: stubService({
        sendMessage: async () =>
          makeExecutionResponse({ execution: makeRun({ status: "partial" }) }),
      }),
      token: TEST_TOKEN,
      conversationId: CONVERSATION_ID,
      text: "Olá",
      assistantKey: "yui",
      requestId: REQUEST_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(outcome.status).toBe("partial");
  });

  it("never turns a non-success execution into a delivered answer", async () => {
    await expect(
      sendChatMessage({
        service: stubService({
          sendMessage: async () =>
            makeExecutionResponse({ execution: makeRun({ status: "failed" }) }),
        }),
        token: TEST_TOKEN,
        conversationId: CONVERSATION_ID,
        text: "Olá",
        assistantKey: "yui",
        requestId: REQUEST_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("sends the selected assistant key, never a delegation plan", async () => {
    const sendMessage = vi.fn(
      async (
        _token: string,
        _conversationId: string,
        _body: SendMessageInput,
        _options?: { signal?: AbortSignal },
      ) => makeExecutionResponse(),
    );
    await sendChatMessage({
      service: stubService({ sendMessage }),
      token: TEST_TOKEN,
      conversationId: CONVERSATION_ID,
      text: "Olá",
      assistantKey: "schwi",
      requestId: REQUEST_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    const [, , body] = sendMessage.mock.calls[0]!;
    expect(body.assistantKey).toBe("schwi");
    expect(Object.keys(body)).not.toContain("delegations");
    expect(Object.keys(body)).not.toContain("parameters");
  });
});

describe("recovery and cancellation", () => {
  it("finds the run a requestId produced from persisted state", async () => {
    const run = await recoverRunByRequestId({
      service: stubService({
        listExecutions: async () => [
          makeRun({ id: TEST_RUN, requestId: "99999999-9999-4999-8999-999999999999" }),
          makeRun(),
        ],
      }),
      token: TEST_TOKEN,
      conversationId: CONVERSATION_ID,
      requestId: REQUEST_ID,
    });

    expect(run?.id).toBe(RUN_ID);
  });

  it("returns null when the request was never admitted", async () => {
    const run = await recoverRunByRequestId({
      service: stubService({ listExecutions: async () => [] }),
      token: TEST_TOKEN,
      conversationId: CONVERSATION_ID,
      requestId: REQUEST_ID,
    });

    expect(run).toBeNull();
  });

  it("loads the assistant message referenced by finalMessageId", async () => {
    const message = await loadAssistantMessageForRun({
      service: stubService({
        listMessages: async () => [makeAssistantMessage()],
      }),
      token: TEST_TOKEN,
      conversationId: CONVERSATION_ID,
      run: makeRun(),
    });

    expect(message?.id).toBe(ASSISTANT_MESSAGE_ID);
  });

  it("returns null when the run has no final message (failed/cancelled)", async () => {
    const message = await loadAssistantMessageForRun({
      service: stubService({
        listMessages: async () => [makeAssistantMessage()],
      }),
      token: TEST_TOKEN,
      conversationId: CONVERSATION_ID,
      run: makeRun({ finalMessageId: undefined }),
    });

    expect(message).toBeNull();
  });

  it("reports a successful cancel", async () => {
    const outcome = await cancelRun({
      service: stubService({
        cancelExecution: async () =>
          makeInspection({ execution: makeRun({ status: "cancelled" }) }),
      }),
      token: TEST_TOKEN,
      runId: RUN_ID,
    });

    expect(outcome.kind).toBe("cancelled");
  });

  it("treats an already-finished run as not an error", async () => {
    const outcome = await cancelRun({
      service: stubService({
        cancelExecution: async () => {
          throw new ApiError({
            kind: "http",
            status: 409,
            code: "EXECUTION_ALREADY_TERMINAL",
            message: "already finished",
          });
        },
      }),
      token: TEST_TOKEN,
      runId: RUN_ID,
    });

    expect(outcome.kind).toBe("already_terminal");
  });

  it("surfaces 401 during cancel so the app can log out", async () => {
    const outcome = await cancelRun({
      service: stubService({
        cancelExecution: async () => {
          throw new ApiError({ kind: "http", status: 401, message: "expired" });
        },
      }),
      token: TEST_TOKEN,
      runId: RUN_ID,
    });

    expect(outcome.kind).toBe("unauthorized");
  });

  it("reports a genuine cancel failure", async () => {
    const outcome = await cancelRun({
      service: stubService({
        cancelExecution: async () => {
          throw new ApiError({ kind: "network", message: "offline" });
        },
      }),
      token: TEST_TOKEN,
      runId: RUN_ID,
    });

    expect(outcome.kind).toBe("error");
  });
});
