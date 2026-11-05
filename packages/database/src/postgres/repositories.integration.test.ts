import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  messageSchema,
  type AppendAssistantMessage,
  type CoreRun,
  type ProviderSelection,
  type RunResult,
  type RunStep,
  type SendMessage,
  type ToolEvent,
} from "@nexus/shared";
import type { NexusRepositories, OwnerTransactionContext } from "../contracts.js";
import {
  createPostgresDatabase,
  INTERNAL_POOL,
  type PostgresNexusDatabase,
} from "./index.js";

const url = process.env.NEXUS_DATABASE_URL;
const describeIfPostgres = url ? describe : describe.skip;

const OWNER_ID = "00000000-0000-4000-8000-000000000004";
const OTHER_OWNER_ID = "00000000-0000-4000-8000-000000000005";
const YUI = "00000000-0000-4000-8000-000000000001";
const ALICE = "00000000-0000-4000-8000-000000000002";
const PROVIDER = "50000000-0000-4000-8000-000000000001";
const MODEL_GLOBAL = "60000000-0000-4000-8000-000000000001";
const MODEL_ASSISTANT = "60000000-0000-4000-8000-000000000002";
const MODEL_CONVERSATION = "60000000-0000-4000-8000-000000000003";

const ownerContext: OwnerTransactionContext = {
  ownerId: OWNER_ID,
  actor: { type: "owner" },
};
const otherOwnerContext: OwnerTransactionContext = {
  ownerId: OTHER_OWNER_ID,
  actor: { type: "owner" },
};

const userInput = (label: string): SendMessage => ({
  content: [{ type: "text", text: label }],
  requestId: randomUUID(),
  idempotencyKey: `${label}-${randomUUID()}`,
  metadata: { source: "postgres-integration" },
});

const assistantInput = (label: string, runId?: string): AppendAssistantMessage => ({
  ...userInput(label),
  assistantId: YUI,
  runId,
});

const manual = (modelId: string): ProviderSelection => ({
  mode: "manual",
  providerId: PROVIDER,
  modelId,
});

describeIfPostgres("PostgreSQL 17 repositories: persistence and integrity", () => {
  let db: PostgresNexusDatabase;
  let internalPool: Pool;
  let messageConversationId: string;
  let secondConversationId: string;
  let executionConversationId: string;
  let preferenceConversationB: string;
  let executionInputMessageId: string;
  let run: CoreRun;

  const transact = <T>(
    operation: (repositories: NexusRepositories) => Promise<T>,
    context: OwnerTransactionContext = ownerContext,
  ): Promise<T> => db.withOwnerTransaction(context, operation);

  beforeAll(async () => {
    db = createPostgresDatabase({
      connectionString: url!,
      max: 16,
      applicationName: "nexus-stage-2b-integration",
      connectionTimeoutMillis: 5_000,
    });
    internalPool = (db as unknown as { [INTERNAL_POOL]: Pool })[INTERNAL_POOL];
    const version = await internalPool.query<{ server_version_num: string }>(
      "SHOW server_version_num",
    );
    expect(Math.floor(Number(version.rows[0]!.server_version_num) / 10_000)).toBe(17);

    const conversations = await transact(async (repos) => {
      const first = await repos.conversations.create({
        title: "2B messages",
        assistantIds: [YUI, ALICE],
      });
      const second = await repos.conversations.create({
        title: "2B isolation",
        assistantIds: [YUI],
      });
      const execution = await repos.conversations.create({
        title: "2B executions",
        assistantIds: [YUI, ALICE],
      });
      const preferenceB = await repos.conversations.create({
        title: "2B preferences B",
        assistantIds: [ALICE],
      });
      return [first.id, second.id, execution.id, preferenceB.id] as const;
    });
    [messageConversationId, secondConversationId, executionConversationId, preferenceConversationB] = conversations;
  }, 20_000);

  afterAll(async () => {
    await db.close();
  });

  it("persists user and assistant authorship and recovers the complete ordered history", async () => {
    const { user, assistant, history, tail } = await transact(async (repos) => {
      const user = await repos.messages.append(messageConversationId, userInput("user-author"));
      const assistant = await repos.messages.appendAssistant(
        messageConversationId,
        assistantInput("assistant-author"),
      );
      const history = await repos.messages.list(messageConversationId);
      const tail = await repos.messages.list(messageConversationId, user.sequence);
      return { user, assistant, history, tail };
    });

    expect(user.role).toBe("user");
    expect(user.assistantId).toBeUndefined();
    expect(assistant.role).toBe("assistant");
    expect(assistant.assistantId).toBe(YUI);
    expect(messageSchema.parse(user)).toEqual(user);
    expect(messageSchema.parse(assistant)).toEqual(assistant);
    expect(history).toEqual([user, assistant]);
    expect(tail).toEqual([assistant]);

    await expect(
      transact((repos) =>
        repos.messages.append(messageConversationId, {
          ...userInput("spoofed-author"),
          assistantId: YUI,
        }),
      ),
    ).rejects.toThrow(/cannot claim assistant authorship/);
    expect(await transact((repos) => repos.messages.list(messageConversationId))).toEqual(history);
  });

  it("returns the original message on retries and rejects idempotency payload conflicts", async () => {
    const input = userInput("idempotent-retry");
    const first = await transact((repos) => repos.messages.append(messageConversationId, input));
    const retry = await transact((repos) =>
      repos.messages.append(messageConversationId, { ...input, requestId: randomUUID() }),
    );
    expect(retry).toEqual(first);

    await expect(
      transact((repos) =>
        repos.messages.append(messageConversationId, {
          ...input,
          requestId: randomUUID(),
          content: [{ type: "text", text: "different payload" }],
        }),
      ),
    ).rejects.toThrow(/Idempotency key conflict/);

    const history = await transact((repos) => repos.messages.list(messageConversationId));
    expect(history.filter((message) => message.id === first.id)).toHaveLength(1);
  });

  it("deduplicates simultaneous retries with the same idempotencyKey", async () => {
    const input = userInput("simultaneous-retry");
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        transact((repos) => repos.messages.append(messageConversationId, input)),
      ),
    );
    expect(new Set(results.map((message) => message.id)).size).toBe(1);
    expect(new Set(results.map((message) => message.sequence)).size).toBe(1);

    const history = await transact((repos) => repos.messages.list(messageConversationId));
    expect(history.filter((message) => message.id === results[0]!.id)).toHaveLength(1);
  }, 20_000);

  it("assigns a unique contiguous sequence under concurrent sends in one conversation", async () => {
    const inputs = Array.from({ length: 16 }, (_, index) => userInput(`concurrent-${index}`));
    const appended = await Promise.all(
      inputs.map((input) =>
        transact((repos) => repos.messages.append(messageConversationId, input)),
      ),
    );
    const history = await transact((repos) => repos.messages.list(messageConversationId));
    const appendedIds = new Set(appended.map((message) => message.id));
    const persisted = history.filter((message) => appendedIds.has(message.id));

    expect(persisted).toHaveLength(inputs.length);
    expect(new Set(persisted.map((message) => message.sequence)).size).toBe(inputs.length);
    expect(history.map((message) => message.sequence)).toEqual(
      Array.from({ length: history.length }, (_, index) => index),
    );
    expect(persisted.map((message) => message.sequence)).toEqual(
      [...persisted.map((message) => message.sequence)].sort((a, b) => a - b),
    );
  }, 20_000);

  it("scopes idempotency by conversation and enforces owner isolation and rollback", async () => {
    const key = `shared-key-${randomUUID()}`;
    const firstInput = { ...userInput("scope-a"), idempotencyKey: key };
    const secondInput = { ...userInput("scope-b"), idempotencyKey: key };
    const first = await transact((repos) => repos.messages.append(messageConversationId, firstInput));
    const second = await transact((repos) => repos.messages.append(secondConversationId, secondInput));
    expect(second.id).not.toBe(first.id);
    expect(second.conversationId).toBe(secondConversationId);

    expect(
      await transact((repos) => repos.messages.list(messageConversationId), otherOwnerContext),
    ).toEqual([]);
    await expect(
      transact(
        (repos) => repos.messages.append(messageConversationId, userInput("unauthorized")),
        otherOwnerContext,
      ),
    ).rejects.toThrow(/not found or not accessible/);

    const before = await transact((repos) => repos.messages.list(messageConversationId));
    await expect(
      transact(async (repos) => {
        await repos.messages.append(messageConversationId, userInput("must-roll-back"));
        throw new Error("forced-message-rollback");
      }),
    ).rejects.toThrow("forced-message-rollback");
    expect(await transact((repos) => repos.messages.list(messageConversationId))).toEqual(before);
  });

  it("creates and retrieves executions with assistantIds, trace and every timestamp", async () => {
    const created = await transact(async (repos) => {
      const input = await repos.messages.append(
        executionConversationId,
        userInput("execution-input"),
      );
      executionInputMessageId = input.id;
      const value: CoreRun = {
        id: randomUUID(),
        userId: OWNER_ID,
        conversationId: executionConversationId,
        requestId: randomUUID(),
        idempotencyKey: `run-${randomUUID()}`,
        status: "queued",
        assistantIds: [YUI, ALICE],
        trace: [
          { assistantId: YUI, assistantKey: "yui", configVersion: "1.0.0" },
          { assistantId: ALICE, assistantKey: "alice", configVersion: "1.0.0" },
        ],
        inputMessageId: input.id,
        createdAt: new Date().toISOString(),
        formatVersion: 1,
      };
      const created = await repos.executions.create(value);
      const recovered = await repos.executions.getById(value.id);
      return { value, created, recovered };
    });

    run = created.recovered!;
    expect(created.created).toEqual(created.value);
    expect(created.recovered).toEqual(created.value);
    expect(run.assistantIds).toEqual([YUI, ALICE]);
    expect(run.trace).toHaveLength(2);
  });

  it("updates executions and faithfully recovers steps, results and tool events", async () => {
    const updated = await transact(async (repos) => {
      const running = await repos.executions.update({
        ...run,
        status: "running",
        startedAt: new Date().toISOString(),
      });
      const stepValue: RunStep = {
        id: randomUUID(),
        userId: OWNER_ID,
        runId: run.id,
        order: 0,
        assistant: { assistantId: YUI, assistantKey: "yui", configVersion: "1.0.0" },
        status: "succeeded",
        objective: "Persist a complete execution step",
        inputReferenceIds: [executionInputMessageId],
        startedAt: running.startedAt,
        finishedAt: new Date().toISOString(),
        metadata: { attempt: 1 },
      };
      const step = await repos.executions.appendStep(stepValue);
      const resultValue: RunResult = {
        id: randomUUID(),
        userId: OWNER_ID,
        runId: run.id,
        stepId: step.id,
        status: "succeeded",
        content: [{ type: "text", data: { text: "persisted result" } }],
        references: [{
          id: "source-1",
          uri: "https://example.com/source",
          title: "Source",
          sourceType: "integration-test",
          retrievedAt: new Date().toISOString(),
          metadata: { reliable: true },
        }],
        formatVersion: 1,
        createdAt: new Date().toISOString(),
        metadata: { complete: true },
      };
      const result = await repos.executions.recordResult(resultValue);
      const eventValue: ToolEvent = {
        id: randomUUID(),
        userId: OWNER_ID,
        runId: run.id,
        stepId: step.id,
        tool: "persistence-probe",
        eventType: "recorded",
        status: "succeeded",
        normalizedData: { persisted: true, count: 1 },
        references: [],
        origin: "integration-test",
        occurredAt: new Date().toISOString(),
        formatVersion: 1,
        metadata: { nested: { preserved: true } },
      };
      const event = await repos.executions.recordToolEvent(eventValue);
      return {
        running,
        stepValue,
        step,
        resultValue,
        result,
        eventValue,
        event,
        steps: await repos.executions.listSteps(run.id),
        results: await repos.executions.listResults(run.id),
        events: await repos.executions.listToolEvents(run.id),
        recovered: await repos.executions.getById(run.id),
      };
    });

    run = updated.recovered!;
    expect(updated.running.status).toBe("running");
    expect(updated.step).toEqual(updated.stepValue);
    expect(updated.result).toEqual(updated.resultValue);
    expect(updated.event).toEqual(updated.eventValue);
    expect(updated.steps).toEqual([{ ...updated.stepValue, resultId: updated.result.id }]);
    expect(updated.results).toEqual([updated.resultValue]);
    expect(updated.events).toEqual([updated.eventValue]);
    expect(run.assistantIds).toEqual([YUI, ALICE]);
    expect(run.trace).toHaveLength(2);
  });

  it("completes executions transactionally and preserves their final message and trace", async () => {
    const completed = await transact(async (repos) => {
      const finalMessage = await repos.messages.appendAssistant(
        executionConversationId,
        assistantInput("execution-final", run.id),
      );
      const completed = await repos.executions.complete(run.id, {
        finalMessageId: finalMessage.id,
        finishedAt: new Date().toISOString(),
      });
      return { finalMessage, completed, recovered: await repos.executions.getById(run.id) };
    });

    run = completed.recovered!;
    expect(completed.finalMessage.role).toBe("assistant");
    expect(completed.finalMessage.runId).toBe(run.id);
    expect(completed.completed).toEqual(run);
    expect(run.status).toBe("succeeded");
    expect(run.finalMessageId).toBe(completed.finalMessage.id);
    expect(run.startedAt).toBeDefined();
    expect(run.finishedAt).toBeDefined();
    expect(run.assistantIds).toEqual([YUI, ALICE]);
    expect(run.trace).toHaveLength(2);

    await expect(
      transact((repos) => repos.executions.update({ ...run, status: "running" })),
    ).rejects.toThrow(/Terminal executions are immutable/);
    expect(await transact((repos) => repos.executions.getById(run.id))).toEqual(run);
  });

  it("records execution failure and rejects cross-conversation references", async () => {
    const failed = await transact(async (repos) => {
      const value: CoreRun = {
        id: randomUUID(),
        userId: OWNER_ID,
        conversationId: executionConversationId,
        requestId: randomUUID(),
        idempotencyKey: `failed-${randomUUID()}`,
        status: "queued",
        assistantIds: [ALICE],
        trace: [{ assistantId: ALICE, assistantKey: "alice", configVersion: "1.0.0" }],
        inputMessageId: executionInputMessageId,
        createdAt: new Date().toISOString(),
        formatVersion: 1,
      };
      await repos.executions.create(value);
      const failed = await repos.executions.fail(value.id, {
        finishedAt: new Date().toISOString(),
      });
      return { failed, recovered: await repos.executions.getById(value.id) };
    });
    expect(failed.recovered).toEqual(failed.failed);
    expect(failed.failed.status).toBe("failed");
    expect(failed.failed.startedAt).toBe(failed.failed.finishedAt);
    expect(failed.failed.assistantIds).toEqual([ALICE]);

    const foreignMessage = await transact((repos) => repos.messages.list(messageConversationId));
    await expect(
      transact((repos) =>
        repos.executions.create({
          id: randomUUID(),
          userId: OWNER_ID,
          conversationId: executionConversationId,
          requestId: randomUUID(),
          idempotencyKey: `cross-conversation-${randomUUID()}`,
          status: "queued",
          assistantIds: [YUI],
          trace: [],
          inputMessageId: foreignMessage[0]!.id,
          createdAt: new Date().toISOString(),
          formatVersion: 1,
        }),
      ),
    ).rejects.toThrow();

    expect(
      await transact((repos) => repos.executions.getById(run.id), otherOwnerContext),
    ).toBeNull();
  });

  it("rolls back a partially created execution and its participants", async () => {
    const runId = randomUUID();
    await expect(
      transact(async (repos) => {
        await repos.executions.create({
          id: runId,
          userId: OWNER_ID,
          conversationId: executionConversationId,
          requestId: randomUUID(),
          idempotencyKey: `rollback-${randomUUID()}`,
          status: "queued",
          assistantIds: [YUI, ALICE],
          trace: [{ assistantId: YUI, assistantKey: "yui", configVersion: "1.0.0" }],
          inputMessageId: executionInputMessageId,
          createdAt: new Date().toISOString(),
          formatVersion: 1,
        });
        throw new Error("forced-execution-rollback");
      }),
    ).rejects.toThrow("forced-execution-rollback");
    expect(await transact((repos) => repos.executions.getById(runId))).toBeNull();
    expect(await transact((repos) => repos.executions.listSteps(runId))).toEqual([]);
  });

  it("uses canonical preference tables and enforces conversation, assistant, global precedence", async () => {
    const fixture = await transact(async (repos) => {
      const conversation = await repos.conversations.create({
        title: "2B preferences A",
        assistantIds: [YUI, ALICE],
        providerPreference: manual(MODEL_CONVERSATION),
      });
      await repos.providerPreferences.setGlobal(manual(MODEL_GLOBAL));
      // The suite is repeatable against the same disposable database.
      await repos.providerPreferences.clearAssistant(ALICE);
      await repos.providerPreferences.setAssistant(YUI, manual(MODEL_ASSISTANT));
      await repos.providerPreferences.setConversation(conversation.id, manual(MODEL_CONVERSATION));
      return {
        conversation,
        conversationWinner: await repos.providerPreferences.resolve({
          assistantId: ALICE,
          conversationId: conversation.id,
        }),
        assistantWinner: await repos.providerPreferences.resolve({ assistantId: YUI }),
        globalWinner: await repos.providerPreferences.resolve({ assistantId: ALICE }),
      };
    });

    expect(fixture.conversation.providerPreference).toEqual(manual(MODEL_CONVERSATION));
    expect(fixture.conversation.metadata).toEqual({});
    expect(fixture.conversationWinner).toEqual(manual(MODEL_CONVERSATION));
    expect(fixture.assistantWinner).toEqual(manual(MODEL_ASSISTANT));
    expect(fixture.globalWinner).toEqual(manual(MODEL_GLOBAL));

    const fallbacks = await transact(async (repos) => {
      await repos.providerPreferences.setConversation(fixture.conversation.id, { mode: "automatic" });
      const explicitAutomatic = await repos.providerPreferences.resolve({
        assistantId: YUI,
        conversationId: fixture.conversation.id,
      });
      await repos.providerPreferences.clearConversation(fixture.conversation.id);
      const assistant = await repos.providerPreferences.resolve({
        assistantId: YUI,
        conversationId: fixture.conversation.id,
      });
      await repos.providerPreferences.clearAssistant(YUI);
      const global = await repos.providerPreferences.resolve({
        assistantId: YUI,
        conversationId: fixture.conversation.id,
      });
      const all = await repos.providerPreferences.getAll();
      return { explicitAutomatic, assistant, global, all };
    });
    expect(fallbacks.explicitAutomatic).toEqual({ mode: "automatic" });
    expect(fallbacks.assistant).toEqual(manual(MODEL_ASSISTANT));
    expect(fallbacks.global).toEqual(manual(MODEL_GLOBAL));
    expect(fallbacks.all.global.userId).toBe(OWNER_ID);
    expect(fallbacks.all.byConversation.some((item) => item.conversationId === fixture.conversation.id)).toBe(false);

    const rawClient = await internalPool.connect();
    try {
      await rawClient.query("BEGIN");
      await rawClient.query("SELECT set_config('nexus.owner_id', $1, true)", [OWNER_ID]);
      await rawClient.query("SELECT set_config('nexus.actor_type', 'owner', true)");
      const raw = await rawClient.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM nexus.conversations WHERE id = $1",
        [fixture.conversation.id],
      );
      expect(raw.rows[0]!.metadata).not.toHaveProperty("providerPreference");
      await rawClient.query("COMMIT");
    } catch (error) {
      await rawClient.query("ROLLBACK");
      throw error;
    } finally {
      rawClient.release();
    }
  });

  it("retains all scopes during concurrent preference updates without mixed selections", async () => {
    const preferenceA = await transact(async (repos) => {
      const conversations = await repos.conversations.list();
      const conversation = conversations.find((item) => item.title === "2B preferences A");
      if (!conversation) throw new Error("Preference fixture A is missing");
      return conversation;
    });

    await Promise.all([
      transact((repos) => repos.providerPreferences.setGlobal(manual(MODEL_GLOBAL))),
      transact((repos) => repos.providerPreferences.setAssistant(YUI, manual(MODEL_ASSISTANT))),
      transact((repos) => repos.providerPreferences.setAssistant(ALICE, manual(MODEL_CONVERSATION))),
      transact((repos) => repos.providerPreferences.setConversation(preferenceA.id, manual(MODEL_CONVERSATION))),
      transact((repos) => repos.providerPreferences.setConversation(preferenceConversationB, manual(MODEL_ASSISTANT))),
    ]);

    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        transact((repos) =>
          repos.providerPreferences.setConversation(
            preferenceA.id,
            manual(index % 2 === 0 ? MODEL_ASSISTANT : MODEL_CONVERSATION),
          ),
        ),
      ),
    );

    const persisted = await transact(async (repos) => ({
      all: await repos.providerPreferences.getAll(),
      winnerA: await repos.providerPreferences.resolve({
        assistantId: YUI,
        conversationId: preferenceA.id,
      }),
      winnerB: await repos.providerPreferences.resolve({
        assistantId: ALICE,
        conversationId: preferenceConversationB,
      }),
      conversationA: await repos.conversations.getById(preferenceA.id),
    }));

    expect(persisted.all.global.selection).toEqual(manual(MODEL_GLOBAL));
    expect(persisted.all.byAssistant).toEqual(expect.arrayContaining([
      expect.objectContaining({ assistantId: YUI, selection: manual(MODEL_ASSISTANT) }),
      expect.objectContaining({ assistantId: ALICE, selection: manual(MODEL_CONVERSATION) }),
    ]));
    expect(persisted.all.byConversation).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: preferenceA.id }),
      expect.objectContaining({ conversationId: preferenceConversationB, selection: manual(MODEL_ASSISTANT) }),
    ]));
    expect([manual(MODEL_ASSISTANT), manual(MODEL_CONVERSATION)]).toContainEqual(persisted.winnerA);
    expect(persisted.winnerB).toEqual(manual(MODEL_ASSISTANT));
    expect(persisted.conversationA?.providerPreference).toEqual(persisted.winnerA);
    expect(persisted.conversationA?.metadata).toEqual({});
  }, 20_000);
});
