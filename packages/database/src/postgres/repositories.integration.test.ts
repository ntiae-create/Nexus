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

  it("rejects appendStep, recordToolEvent, and recordResult across all terminal execution states", async () => {
    const terminalStatuses = ["succeeded", "partial", "failed", "cancelled"] as const;

    for (const terminalStatus of terminalStatuses) {
      const fixture = await transact(async (repos) => {
        const startedAt = new Date().toISOString();
        const createdRun = await repos.executions.create({
          id: randomUUID(),
          userId: OWNER_ID,
          conversationId: executionConversationId,
          requestId: randomUUID(),
          idempotencyKey: `terminal-guard-${terminalStatus}-${randomUUID()}`,
          status: "running",
          assistantIds: [YUI, ALICE],
          trace: [{ assistantId: YUI, assistantKey: "yui", configVersion: "1.0.0" }],
          inputMessageId: executionInputMessageId,
          startedAt,
          createdAt: startedAt,
          formatVersion: 1,
        });

        const stepWithResult = await repos.executions.appendStep({
          id: randomUUID(),
          userId: OWNER_ID,
          runId: createdRun.id,
          order: 0,
          assistant: { assistantId: YUI, assistantKey: "yui", configVersion: "1.0.0" },
          status: "succeeded",
          objective: `Initial step before ${terminalStatus}`,
          inputReferenceIds: [executionInputMessageId],
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        const unlinkedStep = await repos.executions.appendStep({
          id: randomUUID(),
          userId: OWNER_ID,
          runId: createdRun.id,
          order: 1,
          assistant: { assistantId: ALICE, assistantKey: "alice", configVersion: "1.0.0" },
          status: "running",
          objective: `Unlinked step before ${terminalStatus}`,
          inputReferenceIds: [executionInputMessageId],
          startedAt,
        });
        const initialEvent = await repos.executions.recordToolEvent({
          id: randomUUID(),
          userId: OWNER_ID,
          runId: createdRun.id,
          stepId: stepWithResult.id,
          tool: "terminal-probe",
          eventType: "completed",
          status: "succeeded",
          normalizedData: { phase: "before-close", terminalStatus },
          references: [],
          origin: "integration-test",
          occurredAt: new Date().toISOString(),
          formatVersion: 1,
        });
        const initialResult = await repos.executions.recordResult({
          id: randomUUID(),
          userId: OWNER_ID,
          runId: createdRun.id,
          stepId: stepWithResult.id,
          status: "succeeded",
          content: [{ type: "text", data: { text: `before-${terminalStatus}` } }],
          references: [],
          formatVersion: 1,
          createdAt: new Date().toISOString(),
        });

        const finishedAt = new Date().toISOString();
        let closedRun: CoreRun;
        if (terminalStatus === "succeeded") {
          const finalMsg = await repos.messages.appendAssistant(
            executionConversationId,
            assistantInput(`terminal-final-${terminalStatus}`, createdRun.id),
          );
          closedRun = await repos.executions.complete(createdRun.id, {
            finalMessageId: finalMsg.id,
            finishedAt,
          });
        } else if (terminalStatus === "failed") {
          closedRun = await repos.executions.fail(createdRun.id, { finishedAt });
        } else {
          closedRun = await repos.executions.update({
            ...createdRun,
            status: terminalStatus,
            finishedAt,
          });
        }

        return {
          closedRun,
          unlinkedStepId: unlinkedStep.id,
          stepsBefore: await repos.executions.listSteps(createdRun.id),
          eventsBefore: await repos.executions.listToolEvents(createdRun.id),
          resultsBefore: await repos.executions.listResults(createdRun.id),
          initialEventId: initialEvent.id,
          initialResultId: initialResult.id,
        };
      });

      expect(fixture.closedRun.status).toBe(terminalStatus);

      const rejectedStepId = randomUUID();
      const rejectedEventId = randomUUID();
      const rejectedUnlinkedResultId = randomUUID();
      const rejectedLinkedResultId = randomUUID();

      await expect(
        transact((repos) =>
          repos.executions.appendStep({
            id: rejectedStepId,
            userId: OWNER_ID,
            runId: fixture.closedRun.id,
            order: 2,
            assistant: { assistantId: YUI, assistantKey: "yui", configVersion: "1.0.0" },
            status: "pending",
            objective: "Should fail on terminal run",
            inputReferenceIds: [],
          }),
        ),
      ).rejects.toThrow(/Terminal executions are immutable/);

      await expect(
        transact((repos) =>
          repos.executions.recordToolEvent({
            id: rejectedEventId,
            userId: OWNER_ID,
            runId: fixture.closedRun.id,
            stepId: fixture.unlinkedStepId,
            tool: "late-tool",
            eventType: "late",
            status: "requested",
            normalizedData: { late: true },
            references: [],
            origin: "integration-test",
            occurredAt: new Date().toISOString(),
            formatVersion: 1,
          }),
        ),
      ).rejects.toThrow(/Terminal executions are immutable/);

      await expect(
        transact((repos) =>
          repos.executions.recordResult({
            id: rejectedUnlinkedResultId,
            userId: OWNER_ID,
            runId: fixture.closedRun.id,
            status: "succeeded",
            content: [{ type: "text", data: { text: "late unlinked result" } }],
            references: [],
            formatVersion: 1,
            createdAt: new Date().toISOString(),
          }),
        ),
      ).rejects.toThrow(/Terminal executions are immutable/);

      await expect(
        transact((repos) =>
          repos.executions.recordResult({
            id: rejectedLinkedResultId,
            userId: OWNER_ID,
            runId: fixture.closedRun.id,
            stepId: fixture.unlinkedStepId,
            status: "succeeded",
            content: [{ type: "text", data: { text: "late linked result" } }],
            references: [],
            formatVersion: 1,
            createdAt: new Date().toISOString(),
          }),
        ),
      ).rejects.toThrow(/Terminal executions are immutable/);

      // Verify persisted state in PostgreSQL via repositories and raw SQL counts.
      const after = await transact(async (repos) => ({
        run: await repos.executions.getById(fixture.closedRun.id),
        steps: await repos.executions.listSteps(fixture.closedRun.id),
        events: await repos.executions.listToolEvents(fixture.closedRun.id),
        results: await repos.executions.listResults(fixture.closedRun.id),
      }));
      expect(after.run).toEqual(fixture.closedRun);
      expect(after.steps).toEqual(fixture.stepsBefore);
      expect(after.events).toEqual(fixture.eventsBefore);
      expect(after.results).toEqual(fixture.resultsBefore);

      const rawClient = await internalPool.connect();
      try {
        await rawClient.query("BEGIN");
        await rawClient.query("SELECT set_config('nexus.owner_id', $1, true)", [OWNER_ID]);
        await rawClient.query("SELECT set_config('nexus.actor_type', 'owner', true)");
        const counts = await rawClient.query<{
          steps_count: number;
          events_count: number;
          results_count: number;
          unlinked_result_id: string | null;
        }>(
          `SELECT
             (SELECT count(*)::int FROM nexus.run_steps WHERE run_id = $1) AS steps_count,
             (SELECT count(*)::int FROM nexus.tool_events WHERE run_id = $1) AS events_count,
             (SELECT count(*)::int FROM nexus.run_results WHERE run_id = $1) AS results_count,
             (SELECT result_id::text FROM nexus.run_steps WHERE id = $2) AS unlinked_result_id`,
          [fixture.closedRun.id, fixture.unlinkedStepId],
        );
        expect(counts.rows[0]).toEqual({
          steps_count: 2,
          events_count: 1,
          results_count: 1,
          unlinked_result_id: null,
        });
        await rawClient.query("COMMIT");
      } catch (error) {
        await rawClient.query("ROLLBACK");
        throw error;
      } finally {
        rawClient.release();
      }
    }
  }, 20_000);

  it("enforces authenticated owner matching on appendStep, recordToolEvent, and recordResult", async () => {
    const targetRun = await transact(async (repos) => {
      const now = new Date().toISOString();
      return repos.executions.create({
        id: randomUUID(),
        userId: OWNER_ID,
        conversationId: executionConversationId,
        requestId: randomUUID(),
        idempotencyKey: `owner-guard-${randomUUID()}`,
        status: "running",
        assistantIds: [YUI],
        trace: [{ assistantId: YUI, assistantKey: "yui", configVersion: "1.0.0" }],
        inputMessageId: executionInputMessageId,
        startedAt: now,
        createdAt: now,
        formatVersion: 1,
      });
    });

    await expect(
      transact(
        (repos) =>
          repos.executions.appendStep({
            id: randomUUID(),
            userId: OTHER_OWNER_ID,
            runId: targetRun.id,
            order: 0,
            assistant: { assistantId: YUI, assistantKey: "yui", configVersion: "1.0.0" },
            status: "pending",
            objective: "Unauthorized step",
            inputReferenceIds: [],
          }),
        otherOwnerContext,
      ),
    ).rejects.toThrow(/Execution not found or not accessible/);

    await expect(
      transact((repos) =>
        repos.executions.recordToolEvent({
          id: randomUUID(),
          userId: OTHER_OWNER_ID,
          runId: targetRun.id,
          tool: "unauthorized-tool",
          eventType: "attempt",
          status: "requested",
          normalizedData: {},
          references: [],
          origin: "integration-test",
          occurredAt: new Date().toISOString(),
          formatVersion: 1,
        }),
      ),
    ).rejects.toThrow(/Execution owner does not match the payload/);

    await expect(
      transact((repos) =>
        repos.executions.recordResult({
          id: randomUUID(),
          userId: OTHER_OWNER_ID,
          runId: targetRun.id,
          status: "succeeded",
          content: [{ type: "text", data: { text: "mismatched user" } }],
          references: [],
          formatVersion: 1,
          createdAt: new Date().toISOString(),
        }),
      ),
    ).rejects.toThrow(/Execution owner does not match the payload/);

    const persisted = await transact(async (repos) => ({
      steps: await repos.executions.listSteps(targetRun.id),
      events: await repos.executions.listToolEvents(targetRun.id),
      results: await repos.executions.listResults(targetRun.id),
    }));
    expect(persisted).toEqual({ steps: [], events: [], results: [] });
  });

  it("keeps recordResult atomic without orphan results and preserves transaction usability when errors are caught", async () => {
    const setup = await transact(async (repos) => {
      const now = new Date().toISOString();
      const primaryRun = await repos.executions.create({
        id: randomUUID(),
        userId: OWNER_ID,
        conversationId: executionConversationId,
        requestId: randomUUID(),
        idempotencyKey: `atomic-primary-${randomUUID()}`,
        status: "running",
        assistantIds: [YUI, ALICE],
        trace: [{ assistantId: YUI, assistantKey: "yui", configVersion: "1.0.0" }],
        inputMessageId: executionInputMessageId,
        startedAt: now,
        createdAt: now,
        formatVersion: 1,
      });
      const secondaryRun = await repos.executions.create({
        id: randomUUID(),
        userId: OWNER_ID,
        conversationId: executionConversationId,
        requestId: randomUUID(),
        idempotencyKey: `atomic-secondary-${randomUUID()}`,
        status: "running",
        assistantIds: [ALICE],
        trace: [{ assistantId: ALICE, assistantKey: "alice", configVersion: "1.0.0" }],
        inputMessageId: executionInputMessageId,
        startedAt: now,
        createdAt: now,
        formatVersion: 1,
      });

      const stepOne = await repos.executions.appendStep({
        id: randomUUID(),
        userId: OWNER_ID,
        runId: primaryRun.id,
        order: 0,
        assistant: { assistantId: YUI, assistantKey: "yui", configVersion: "1.0.0" },
        status: "succeeded",
        objective: "Primary step one",
        inputReferenceIds: [executionInputMessageId],
        startedAt: now,
        finishedAt: now,
      });
      const foreignStep = await repos.executions.appendStep({
        id: randomUUID(),
        userId: OWNER_ID,
        runId: secondaryRun.id,
        order: 0,
        assistant: { assistantId: ALICE, assistantKey: "alice", configVersion: "1.0.0" },
        status: "running",
        objective: "Foreign step on another run",
        inputReferenceIds: [executionInputMessageId],
        startedAt: now,
      });
      const firstResult = await repos.executions.recordResult({
        id: randomUUID(),
        userId: OWNER_ID,
        runId: primaryRun.id,
        stepId: stepOne.id,
        status: "succeeded",
        content: [{ type: "text", data: { text: "first linked result" } }],
        references: [],
        formatVersion: 1,
        createdAt: now,
      });

      return { primaryRun, secondaryRun, stepOne, foreignStep, firstResult };
    });

    const missingStepResultId = randomUUID();
    const foreignStepResultId = randomUUID();
    const duplicateLinkResultId = randomUUID();

    // Standalone rejections first.
    await expect(
      transact((repos) =>
        repos.executions.recordResult({
          id: missingStepResultId,
          userId: OWNER_ID,
          runId: setup.primaryRun.id,
          stepId: randomUUID(),
          status: "succeeded",
          content: [{ type: "text", data: { text: "missing step" } }],
          references: [],
          formatVersion: 1,
          createdAt: new Date().toISOString(),
        }),
      ),
    ).rejects.toThrow(/Execution step not found in this execution/);

    await expect(
      transact((repos) =>
        repos.executions.recordResult({
          id: foreignStepResultId,
          userId: OWNER_ID,
          runId: setup.primaryRun.id,
          stepId: setup.foreignStep.id,
          status: "succeeded",
          content: [{ type: "text", data: { text: "step from another run" } }],
          references: [],
          formatVersion: 1,
          createdAt: new Date().toISOString(),
        }),
      ),
    ).rejects.toThrow(/Execution step not found in this execution/);

    await expect(
      transact((repos) =>
        repos.executions.recordResult({
          id: duplicateLinkResultId,
          userId: OWNER_ID,
          runId: setup.primaryRun.id,
          stepId: setup.stepOne.id,
          status: "succeeded",
          content: [{ type: "text", data: { text: "second result for same step" } }],
          references: [],
          formatVersion: 1,
          createdAt: new Date().toISOString(),
        }),
      ),
    ).rejects.toThrow(/Execution step is already linked to a different result/);

    // Now catch link failures inside ONE transaction and continue writing and committing!
    const caughtMissingResultId = randomUUID();
    const caughtForeignResultId = randomUUID();
    const caughtSecondResultId = randomUUID();

    const recoveredInSameTx = await transact(async (repos) => {
      const stepTwo = await repos.executions.appendStep({
        id: randomUUID(),
        userId: OWNER_ID,
        runId: setup.primaryRun.id,
        order: 1,
        assistant: { assistantId: ALICE, assistantKey: "alice", configVersion: "1.0.0" },
        status: "succeeded",
        objective: "Primary step two before caught failures",
        inputReferenceIds: [executionInputMessageId],
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });

      const caughtErrors: string[] = [];

      try {
        await repos.executions.recordResult({
          id: caughtMissingResultId,
          userId: OWNER_ID,
          runId: setup.primaryRun.id,
          stepId: randomUUID(),
          status: "succeeded",
          content: [{ type: "text", data: { text: "caught missing step" } }],
          references: [],
          formatVersion: 1,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        caughtErrors.push((error as Error).message);
      }

      try {
        await repos.executions.recordResult({
          id: caughtForeignResultId,
          userId: OWNER_ID,
          runId: setup.primaryRun.id,
          stepId: setup.foreignStep.id,
          status: "succeeded",
          content: [{ type: "text", data: { text: "caught foreign step" } }],
          references: [],
          formatVersion: 1,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        caughtErrors.push((error as Error).message);
      }

      try {
        await repos.executions.recordResult({
          id: caughtSecondResultId,
          userId: OWNER_ID,
          runId: setup.primaryRun.id,
          stepId: setup.stepOne.id,
          status: "succeeded",
          content: [{ type: "text", data: { text: "caught duplicate step result" } }],
          references: [],
          formatVersion: 1,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        caughtErrors.push((error as Error).message);
      }

      // Also catch a database-level primary key conflict on run_results to prove savepoint recovery.
      try {
        await repos.executions.recordResult({
          id: setup.firstResult.id,
          userId: OWNER_ID,
          runId: setup.primaryRun.id,
          status: "succeeded",
          content: [{ type: "text", data: { text: "duplicate result primary key" } }],
          references: [],
          formatVersion: 1,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        caughtErrors.push((error as Error).message);
      }

      // Continue using the SAME transaction after catching all failures.
      const validSecondResult = await repos.executions.recordResult({
        id: randomUUID(),
        userId: OWNER_ID,
        runId: setup.primaryRun.id,
        stepId: stepTwo.id,
        status: "succeeded",
        content: [{ type: "text", data: { text: "valid step two result after caught errors" } }],
        references: [],
        formatVersion: 1,
        createdAt: new Date().toISOString(),
      });
      const postCatchEvent = await repos.executions.recordToolEvent({
        id: randomUUID(),
        userId: OWNER_ID,
        runId: setup.primaryRun.id,
        stepId: stepTwo.id,
        tool: "post-catch-probe",
        eventType: "verified",
        status: "succeeded",
        normalizedData: { recoveredTransaction: true },
        references: [],
        origin: "integration-test",
        occurredAt: new Date().toISOString(),
        formatVersion: 1,
      });
      const finalMsg = await repos.messages.appendAssistant(
        executionConversationId,
        assistantInput("atomic-recovery-final", setup.primaryRun.id),
      );
      const completedRun = await repos.executions.complete(setup.primaryRun.id, {
        finalMessageId: finalMsg.id,
        finishedAt: new Date().toISOString(),
      });

      return {
        caughtErrors,
        stepTwo,
        validSecondResult,
        postCatchEvent,
        completedRun,
      };
    });

    expect(recoveredInSameTx.caughtErrors).toHaveLength(4);
    expect(recoveredInSameTx.caughtErrors[0]).toMatch(/Execution step not found in this execution/);
    expect(recoveredInSameTx.caughtErrors[1]).toMatch(/Execution step not found in this execution/);
    expect(recoveredInSameTx.caughtErrors[2]).toMatch(
      /Execution step is already linked to a different result/,
    );

    const persisted = await transact(async (repos) => ({
      primaryRun: await repos.executions.getById(setup.primaryRun.id),
      primarySteps: await repos.executions.listSteps(setup.primaryRun.id),
      primaryResults: await repos.executions.listResults(setup.primaryRun.id),
      primaryEvents: await repos.executions.listToolEvents(setup.primaryRun.id),
      secondarySteps: await repos.executions.listSteps(setup.secondaryRun.id),
      secondaryResults: await repos.executions.listResults(setup.secondaryRun.id),
    }));

    expect(persisted.primaryRun?.status).toBe("succeeded");
    expect(persisted.primaryResults).toEqual([
      setup.firstResult,
      recoveredInSameTx.validSecondResult,
    ]);
    expect(persisted.primarySteps).toEqual([
      { ...setup.stepOne, resultId: setup.firstResult.id },
      { ...recoveredInSameTx.stepTwo, resultId: recoveredInSameTx.validSecondResult.id },
    ]);
    expect(persisted.primaryEvents).toEqual([recoveredInSameTx.postCatchEvent]);
    expect(persisted.secondarySteps).toEqual([setup.foreignStep]);
    expect(persisted.secondaryResults).toEqual([]);

    const rejectedIds = [
      missingStepResultId,
      foreignStepResultId,
      duplicateLinkResultId,
      caughtMissingResultId,
      caughtForeignResultId,
      caughtSecondResultId,
    ];
    const rawClient = await internalPool.connect();
    try {
      await rawClient.query("BEGIN");
      await rawClient.query("SELECT set_config('nexus.owner_id', $1, true)", [OWNER_ID]);
      await rawClient.query("SELECT set_config('nexus.actor_type', 'owner', true)");
      const orphanCheck = await rawClient.query<{
        rejected_persisted: number;
        total_primary_results: number;
        unlinked_step_results: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM nexus.run_results WHERE id = ANY($1::uuid[])) AS rejected_persisted,
           (SELECT count(*)::int FROM nexus.run_results WHERE run_id = $2) AS total_primary_results,
           (SELECT count(*)::int
            FROM nexus.run_results AS r
            LEFT JOIN nexus.run_steps AS s
              ON s.run_id = r.run_id AND s.id = r.step_id AND s.result_id = r.id
            WHERE r.run_id = $2 AND r.step_id IS NOT NULL AND s.id IS NULL) AS unlinked_step_results`,
        [rejectedIds, setup.primaryRun.id],
      );
      expect(orphanCheck.rows[0]).toEqual({
        rejected_persisted: 0,
        total_primary_results: 2,
        unlinked_step_results: 0,
      });
      await rawClient.query("COMMIT");
    } catch (error) {
      await rawClient.query("ROLLBACK");
      throw error;
    } finally {
      rawClient.release();
    }
  }, 20_000);

  it("serializes concurrent completion and writes on the same execution without post-closure persistence", async () => {
    // Part 1: Deterministic row-lock barrier proving SELECT ... FOR UPDATE blocks
    // concurrent appendStep, recordToolEvent, and recordResult while complete() commits.
    const barrierSetup = await transact(async (repos) => {
      const now = new Date().toISOString();
      const targetRun = await repos.executions.create({
        id: randomUUID(),
        userId: OWNER_ID,
        conversationId: executionConversationId,
        requestId: randomUUID(),
        idempotencyKey: `concurrent-barrier-${randomUUID()}`,
        status: "running",
        assistantIds: [YUI, ALICE],
        trace: [{ assistantId: YUI, assistantKey: "yui", configVersion: "1.0.0" }],
        inputMessageId: executionInputMessageId,
        startedAt: now,
        createdAt: now,
        formatVersion: 1,
      });
      const existingStep = await repos.executions.appendStep({
        id: randomUUID(),
        userId: OWNER_ID,
        runId: targetRun.id,
        order: 0,
        assistant: { assistantId: YUI, assistantKey: "yui", configVersion: "1.0.0" },
        status: "running",
        objective: "Pre-existing step before concurrent close",
        inputReferenceIds: [executionInputMessageId],
        startedAt: now,
      });
      const finalMsg = await repos.messages.appendAssistant(
        executionConversationId,
        assistantInput("concurrent-barrier-final", targetRun.id),
      );
      return { targetRun, existingStep, finalMessageId: finalMsg.id };
    });

    let notifyRunLocked!: () => void;
    const runLocked = new Promise<void>((resolve) => {
      notifyRunLocked = resolve;
    });
    let allowCloseCommit!: () => void;
    const closeCommitGate = new Promise<void>((resolve) => {
      allowCloseCommit = resolve;
    });

    const closingPromise = transact(async (repos) => {
      const closed = await repos.executions.complete(barrierSetup.targetRun.id, {
        finalMessageId: barrierSetup.finalMessageId,
        finishedAt: new Date().toISOString(),
      });
      notifyRunLocked();
      await closeCommitGate;
      return closed;
    });

    await runLocked;

    const contendingStepId = randomUUID();
    const contendingEventId = randomUUID();
    const contendingResultId = randomUUID();

    const contendingStepPromise = transact((repos) =>
      repos.executions.appendStep({
        id: contendingStepId,
        userId: OWNER_ID,
        runId: barrierSetup.targetRun.id,
        order: 1,
        assistant: { assistantId: ALICE, assistantKey: "alice", configVersion: "1.0.0" },
        status: "pending",
        objective: "Contending step while close holds FOR UPDATE",
        inputReferenceIds: [],
      }),
    );
    const contendingEventPromise = transact((repos) =>
      repos.executions.recordToolEvent({
        id: contendingEventId,
        userId: OWNER_ID,
        runId: barrierSetup.targetRun.id,
        stepId: barrierSetup.existingStep.id,
        tool: "contending-tool",
        eventType: "contending",
        status: "requested",
        normalizedData: { contending: true },
        references: [],
        origin: "integration-test",
        occurredAt: new Date().toISOString(),
        formatVersion: 1,
      }),
    );
    const contendingResultPromise = transact((repos) =>
      repos.executions.recordResult({
        id: contendingResultId,
        userId: OWNER_ID,
        runId: barrierSetup.targetRun.id,
        stepId: barrierSetup.existingStep.id,
        status: "succeeded",
        content: [{ type: "text", data: { text: "contending result" } }],
        references: [],
        formatVersion: 1,
        createdAt: new Date().toISOString(),
      }),
    );

    // Give the three contending transactions time to reach SELECT ... FOR UPDATE on PostgreSQL.
    await new Promise((resolve) => setTimeout(resolve, 60));
    allowCloseCommit();

    const closedBarrierRun = await closingPromise;
    expect(closedBarrierRun.status).toBe("succeeded");
    await expect(contendingStepPromise).rejects.toThrow(/Terminal executions are immutable/);
    await expect(contendingEventPromise).rejects.toThrow(/Terminal executions are immutable/);
    await expect(contendingResultPromise).rejects.toThrow(/Terminal executions are immutable/);

    const barrierPersisted = await transact(async (repos) => ({
      run: await repos.executions.getById(barrierSetup.targetRun.id),
      steps: await repos.executions.listSteps(barrierSetup.targetRun.id),
      events: await repos.executions.listToolEvents(barrierSetup.targetRun.id),
      results: await repos.executions.listResults(barrierSetup.targetRun.id),
    }));
    expect(barrierPersisted.run?.status).toBe("succeeded");
    expect(barrierPersisted.steps).toEqual([barrierSetup.existingStep]);
    expect(barrierPersisted.events).toEqual([]);
    expect(barrierPersisted.results).toEqual([]);

    // Part 2: Uncoordinated concurrent races across succeeded, partial, failed, and cancelled.
    const raceStatuses = [
      "succeeded",
      "partial",
      "failed",
      "cancelled",
      "succeeded",
      "failed",
    ] as const;

    for (const [round, targetStatus] of raceStatuses.entries()) {
      const fixture = await transact(async (repos) => {
        const startedAt = new Date().toISOString();
        const raceRun = await repos.executions.create({
          id: randomUUID(),
          userId: OWNER_ID,
          conversationId: executionConversationId,
          requestId: randomUUID(),
          idempotencyKey: `concurrent-race-${round}-${randomUUID()}`,
          status: "running",
          assistantIds: [YUI, ALICE],
          trace: [{ assistantId: YUI, assistantKey: "yui", configVersion: "1.0.0" }],
          inputMessageId: executionInputMessageId,
          startedAt,
          createdAt: startedAt,
          formatVersion: 1,
        });
        const preSteps = await Promise.all([
          repos.executions.appendStep({
            id: randomUUID(),
            userId: OWNER_ID,
            runId: raceRun.id,
            order: 0,
            assistant: { assistantId: YUI, assistantKey: "yui", configVersion: "1.0.0" },
            status: "running",
            objective: "Pre-step 0",
            inputReferenceIds: [],
            startedAt,
          }),
        ]);
        const preStepTwo = await repos.executions.appendStep({
          id: randomUUID(),
          userId: OWNER_ID,
          runId: raceRun.id,
          order: 1,
          assistant: { assistantId: ALICE, assistantKey: "alice", configVersion: "1.0.0" },
          status: "running",
          objective: "Pre-step 1",
          inputReferenceIds: [],
          startedAt,
        });
        const finalMsg = await repos.messages.appendAssistant(
          executionConversationId,
          assistantInput(`race-final-${round}`, raceRun.id),
        );
        return {
          raceRun,
          stepZeroId: preSteps[0].id,
          stepOneId: preStepTwo.id,
          finalMessageId: finalMsg.id,
        };
      });

      let commitOrder = 0;
      let closeCommitIndex = -1;
      const acceptedWriteCommitIndices: number[] = [];

      const closeOp = transact(async (repos) => {
        let closed: CoreRun;
        if (targetStatus === "succeeded") {
          closed = await repos.executions.complete(fixture.raceRun.id, {
            finalMessageId: fixture.finalMessageId,
          });
        } else if (targetStatus === "failed") {
          closed = await repos.executions.fail(fixture.raceRun.id);
        } else {
          const current = await repos.executions.getById(fixture.raceRun.id);
          closed = await repos.executions.update({
            ...current!,
            status: targetStatus,
            finishedAt: new Date().toISOString(),
          });
        }
        closeCommitIndex = ++commitOrder;
        return closed;
      });

      const stepInputs: RunStep[] = [2, 3].map((order) => ({
        id: randomUUID(),
        userId: OWNER_ID,
        runId: fixture.raceRun.id,
        order,
        assistant: { assistantId: YUI, assistantKey: "yui", configVersion: "1.0.0" },
        status: "succeeded",
        objective: `Race step ${order}`,
        inputReferenceIds: [],
      }));

      const eventInputs: ToolEvent[] = [0, 1].map((idx) => ({
        id: randomUUID(),
        userId: OWNER_ID,
        runId: fixture.raceRun.id,
        stepId: fixture.stepZeroId,
        tool: `race-tool-${idx}`,
        eventType: "invoked",
        status: "succeeded",
        normalizedData: { idx },
        references: [],
        origin: "integration-test",
        occurredAt: new Date().toISOString(),
        formatVersion: 1,
      }));

      const resultInputs: RunResult[] = [fixture.stepZeroId, fixture.stepOneId].map(
        (stepId, idx) => ({
          id: randomUUID(),
          userId: OWNER_ID,
          runId: fixture.raceRun.id,
          stepId,
          status: "succeeded",
          content: [{ type: "text", data: { text: `race-result-${idx}` } }],
          references: [],
          formatVersion: 1,
          createdAt: new Date().toISOString(),
        }),
      );

      const stepOutcomes = stepInputs.map((step) =>
        transact(async (repos) => {
          const saved = await repos.executions.appendStep(step);
          acceptedWriteCommitIndices.push(++commitOrder);
          return saved;
        }),
      );
      const eventOutcomes = eventInputs.map((event) =>
        transact(async (repos) => {
          const saved = await repos.executions.recordToolEvent(event);
          acceptedWriteCommitIndices.push(++commitOrder);
          return saved;
        }),
      );
      const resultOutcomes = resultInputs.map((result) =>
        transact(async (repos) => {
          const saved = await repos.executions.recordResult(result);
          acceptedWriteCommitIndices.push(++commitOrder);
          return saved;
        }),
      );

      const [closedOutcome, ...writeSettled] = await Promise.allSettled([
        closeOp,
        ...stepOutcomes,
        ...eventOutcomes,
        ...resultOutcomes,
      ]);

      expect(closedOutcome.status).toBe("fulfilled");
      expect(closeCommitIndex).toBeGreaterThan(0);

      // Every write that acquired FOR UPDATE on nexus.core_runs after closure was rejected;
      // every write that fulfilled acquired FOR UPDATE strictly before closure.
      for (const writeCommitIdx of acceptedWriteCommitIndices) {
        expect(writeCommitIdx).toBeLessThan(closeCommitIndex);
      }
      for (const settled of writeSettled) {
        if (settled.status === "rejected") {
          expect(String(settled.reason)).toMatch(/Terminal executions are immutable/);
        }
      }

      const settledSteps = writeSettled.slice(0, stepInputs.length);
      const settledEvents = writeSettled.slice(
        stepInputs.length,
        stepInputs.length + eventInputs.length,
      );
      const settledResults = writeSettled.slice(stepInputs.length + eventInputs.length);

      const fulfilledStepIds = settledSteps
        .filter((item): item is PromiseFulfilledResult<RunStep> => item.status === "fulfilled")
        .map((item) => item.value.id);
      const fulfilledEventIds = settledEvents
        .filter((item): item is PromiseFulfilledResult<ToolEvent> => item.status === "fulfilled")
        .map((item) => item.value.id);
      const fulfilledResultIds = settledResults
        .filter((item): item is PromiseFulfilledResult<RunResult> => item.status === "fulfilled")
        .map((item) => item.value.id);

      const persisted = await transact(async (repos) => ({
        run: await repos.executions.getById(fixture.raceRun.id),
        steps: await repos.executions.listSteps(fixture.raceRun.id),
        events: await repos.executions.listToolEvents(fixture.raceRun.id),
        results: await repos.executions.listResults(fixture.raceRun.id),
      }));

      expect(persisted.run?.status).toBe(targetStatus);
      expect(
        persisted.steps
          .map((item) => item.id)
          .filter((id) => id !== fixture.stepZeroId && id !== fixture.stepOneId)
          .sort(),
      ).toEqual([...fulfilledStepIds].sort());
      expect(persisted.events.map((item) => item.id).sort()).toEqual(
        [...fulfilledEventIds].sort(),
      );
      expect(persisted.results.map((item) => item.id).sort()).toEqual(
        [...fulfilledResultIds].sort(),
      );
    }
  }, 30_000);

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
