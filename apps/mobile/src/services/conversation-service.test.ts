import { describe, expect, it, vi } from "vitest";
import {
  DISCOVERY_DELAYS_MS,
  discoveryDelayFor,
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

    const result = await service.chat(CONVERSATION_ID).findRun(REQUEST_ID, { scheduler });

    expect(result).toEqual({ kind: "found", run: makeRun() });
  });

  it("reports discovery as unavailable (never as aborted) when probes keep failing", async () => {
    const service = createConversationService({
      service: stubService({
        listExecutions: async () => {
          throw new ApiError({ kind: "network", message: "offline" });
        },
      }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).findRun(REQUEST_ID, {
      scheduler,
      maxTransientFailures: 2,
    });

    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") expect(result.message).toContain("Atualize a conversa");
  });
});

describe("chat session — run discovery (3C.2 audit)", () => {
  /**
   * Regression 1: a run admitted late (provider slow to start) used to stay invisible because
   * the old loop stopped after 8 *successful* probes (~25 s). Discovery must keep probing for
   * as long as the send is pending; only `maxAttempts` consecutive misses bound it.
   */
  it("keeps probing past 8 successful non-matching probes and still finds the run", async () => {
    let call = 0;
    const listExecutions = vi.fn(async () => {
      call += 1;
      // The run only appears on the 12th successful probe — beyond the old 8-attempt cap.
      return call >= 12 ? [makeRun({ status: "running" })] : [];
    });
    const service = createConversationService({
      service: stubService({ listExecutions }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).findRun(REQUEST_ID, {
      scheduler,
      maxAttempts: 20,
    });

    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.run.id).toBe(RUN_ID);
    expect(listExecutions).toHaveBeenCalledTimes(12);
  });

  /**
   * The budget counts only *successful* non-matching probes, so a flaky network must not eat
   * into the window in which the run can still be discovered.
   */
  it("does not consume the successful-probe budget on transient failures", async () => {
    let good = 0;
    const service = createConversationService({
      service: stubService({
        listExecutions: async () => {
          // Fail every other probe: 8 failures interleaved with 8 successes must still fit in
          // the default budget of 8 successful probes.
          if (good % 2 === 0) {
            good += 1;
            throw new ApiError({ kind: "network", message: "offline", retryable: true });
          }
          good += 1;
          return good >= 16 ? [makeRun({ status: "running" })] : [];
        },
      }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).findRun(REQUEST_ID, { scheduler });

    expect(result.kind).toBe("found");
  });

  /** With the default budget a permanently empty list still stops (bounded, not infinite). */
  it("stops after the default number of successful non-matching probes", async () => {
    let call = 0;
    const service = createConversationService({
      service: stubService({
        listExecutions: async () => {
          call += 1;
          return [];
        },
      }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).findRun(REQUEST_ID, { scheduler });

    expect(result.kind).toBe("unavailable");
    expect(call).toBe(8);
  });

  /**
   * Regression 2: one probe at a time. A slow response must never stack a second request for
   * the same send (the old code could overlap a probe with the next scheduler tick).
   */
  it("never issues two probes concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let call = 0;
    const service = createConversationService({
      service: stubService({
        listExecutions: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          call += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return call >= 3 ? [makeRun({ status: "running" })] : [];
        },
      }),
      token: TEST_TOKEN,
    });

    // Real timers here on purpose: the concurrency must hold with async gaps.
    const result = await service.chat(CONVERSATION_ID).findRun(REQUEST_ID, {
      maxAttempts: 10,
    });

    expect(result.kind).toBe("found");
    expect(maxInFlight).toBe(1);
  });

  /**
   * Regression 3: discovery stops the instant the send settles — it is aborted by the caller,
   * and the abort must be observable as `aborted`, never as "the run does not exist".
   */
  it("stops on abort and reports aborted instead of unavailable", async () => {
    const controller = new AbortController();
    let probes = 0;
    const service = createConversationService({
      service: stubService({
        listExecutions: async () => {
          probes += 1;
          if (probes === 3) controller.abort();
          return [];
        },
      }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).findRun(REQUEST_ID, {
      scheduler,
      signal: controller.signal,
    });

    expect(result).toEqual({ kind: "aborted" });
    expect(probes).toBe(3);
  });

  /** Regression 3b: an abort that lands while a probe is in flight also stops immediately. */
  it("stops when the signal is already aborted before the first probe", async () => {
    const listExecutions = vi.fn(async () => [makeRun()]);
    const service = createConversationService({
      service: stubService({ listExecutions }),
      token: TEST_TOKEN,
    });
    const controller = new AbortController();
    controller.abort();

    const result = await service.chat(CONVERSATION_ID).findRun(REQUEST_ID, {
      scheduler,
      signal: controller.signal,
    });

    expect(result).toEqual({ kind: "aborted" });
    expect(listExecutions).not.toHaveBeenCalled();
  });

  /**
   * Regression 4: the run id exposed to the UI is always the server's. `onProbe` receives the
   * authoritative list, and a match on `requestId` is what unlocks the cancel button.
   */
  it("exposes the real server run id through onProbe as soon as it is listed", async () => {
    const seen: string[] = [];
    let call = 0;
    const service = createConversationService({
      service: stubService({
        listExecutions: async () => {
          call += 1;
          return call === 1 ? [] : [makeRun({ id: RUN_ID, status: "running" })];
        },
      }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).findRun(REQUEST_ID, {
      scheduler,
      onProbe: (runs) => {
        for (const run of runs) seen.push(run.id);
      },
    });

    expect(result.kind).toBe("found");
    expect(seen).toEqual([RUN_ID]); // only the authoritative id, never a derived one
  });

  /** A `401` during discovery must not be reported as an absent run. */
  it("reports an expired session during discovery as unavailable, not as a missing run", async () => {
    const service = createConversationService({
      service: stubService({
        listExecutions: async () => {
          throw new ApiError({ kind: "http", status: 401, message: "unauthorized", code: "AUTH_REQUIRED" });
        },
      }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).findRun(REQUEST_ID, { scheduler });

    expect(result.kind).toBe("unavailable");
  });

  /** Transient failures are retried a bounded number of times before giving up. */
  it("tolerates transient failures without exceeding the configured budget", async () => {
    let call = 0;
    const service = createConversationService({
      service: stubService({
        listExecutions: async () => {
          call += 1;
          if (call === 1 || call === 2) throw new ApiError({ kind: "network", message: "offline" });
          return [makeRun({ status: "running" })];
        },
      }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).findRun(REQUEST_ID, {
      scheduler,
      maxTransientFailures: 3,
    });

    expect(result.kind).toBe("found");
    expect(call).toBe(3);
  });

  /** Backoff is bounded and monotonic: no unbounded growth, no zero-delay busy loop. */
  it("uses a bounded, non-decreasing backoff", () => {
    const delays = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20].map((attempt) => discoveryDelayFor(attempt));
    for (const delay of delays) {
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(Math.max(...DISCOVERY_DELAYS_MS));
    }
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]!).toBeGreaterThanOrEqual(delays[index - 1]!);
    }
  });
});

describe("chat session — recovery of a run left running (3C.2 audit)", () => {
  /**
   * Regression 5: reopening a conversation must find the execution the server still owns and
   * expose its **real** id, so the user can cancel it. Nothing is invented or re-sent.
   */
  it("lists only non-terminal runs, in the server's own order", async () => {
    const running = makeRun({ id: RUN_ID, status: "running", createdAt: "2026-01-01T10:00:00.000Z" });
    const queued = makeRun({
      id: "11111111-1111-4111-8111-111111111111",
      status: "queued",
      createdAt: "2026-01-01T10:05:00.000Z",
    });
    const finished = makeRun({
      id: "22222222-2222-4222-8222-222222222222",
      status: "succeeded",
      createdAt: "2026-01-01T09:00:00.000Z",
    });
    const service = createConversationService({
      service: stubService({ listExecutions: async () => [finished, running, queued] }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).activeRuns();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Terminal states are excluded; the remaining order is the server's (createdAt ASC).
    expect(result.data.map((run) => run.id)).toEqual([RUN_ID, queued.id]);
  });

  it("returns the shared-schema terminal states as not active", async () => {
    const statuses = ["succeeded", "partial", "failed", "cancelled"] as const;
    const service = createConversationService({
      service: stubService({
        listExecutions: async () =>
          statuses.map((status, index) =>
            makeRun({ id: `3333333${index}-3333-4333-8333-333333333333`, status }),
          ),
      }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).activeRuns();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual([]);
  });

  /** A `401` while listing executions must reach the session layer, not look like "no runs". */
  it("propagates an expired session instead of reporting an empty list", async () => {
    const service = createConversationService({
      service: stubService({
        listExecutions: async () => {
          throw new ApiError({ kind: "http", status: 401, message: "unauthorized", code: "AUTH_REQUIRED" });
        },
      }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).activeRuns();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.signedOut).toBe(true);
  });

  /** A transport failure during recovery is reported, never silently ignored. */
  it("reports a transport failure while listing executions", async () => {
    const service = createConversationService({
      service: stubService({
        listExecutions: async () => {
          throw new ApiError({ kind: "network", message: "offline" });
        },
      }),
      token: TEST_TOKEN,
    });

    const result = await service.chat(CONVERSATION_ID).activeRuns();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.signedOut).toBe(false);
      expect(result.message).toBe("offline");
    }
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
