import { describe, expect, it } from "vitest";
import type { NexusRepositories, PostgresNexusDatabase } from "@nexus/database";
import { createServerDatabase } from "../database.js";
import { ProviderError } from "../providers/index.js";
import { ExecutionCancellationRegistry } from "./cancellation-registry.js";
import { ExecutionCancellationWatcher } from "./cancellation-watcher.js";
import { NexusCoreEngine } from "./engine.js";
import { CoreExecutionError } from "./errors.js";
import { createMockProviderAdapter, createMockProviderRuntime } from "./mock-provider.js";

const url = process.env.NEXUS_DATABASE_URL;
const describeIfPostgres = url ? describe : describe.skip;

const OWNER_ID = "00000000-0000-4000-8000-000000000004";
const YUI_ID = "00000000-0000-4000-8000-000000000001";
const ALICE_ID = "00000000-0000-4000-8000-000000000002";

function raceGate(gate: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return gate;
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    gate.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error as Error);
      },
    );
  });
}

/**
 * Two engines with *independent* in-memory registries and their own database
 * pools, sharing only the PostgreSQL cluster — the serverless topology where the
 * execution and the cancellation request land on different instances.
 */
function createInstance(
  connectionString: string,
  adapter: ReturnType<typeof createMockProviderAdapter>,
  label: string,
) {
  const db: PostgresNexusDatabase = createServerDatabase({
    connectionString,
    applicationName: `nexus-cancel-${label}`,
    max: 4,
  });
  const registry = new ExecutionCancellationRegistry();
  const engine = new NexusCoreEngine({
    database: db,
    providers: createMockProviderRuntime(adapter),
    registry,
    cancellationWatcher: new ExecutionCancellationWatcher({
      database: db,
      pollIntervalMs: 25,
      minProbeIntervalMs: 0,
    }),
  });
  return { db, engine, registry };
}

describeIfPostgres("NEXUS CORE cancellation across instances (PostgreSQL 17)", () => {
  it("instance B cancels while instance A waits on the provider; A aborts from persisted state", async () => {
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const adapter = createMockProviderAdapter({
      respond: async ({ call }) => {
        started();
        try {
          await raceGate(gate, call.signal);
        } catch {
          throw new ProviderError("CANCELLED", "aborted", { providerKey: "openrouter" });
        }
        if (call.signal?.aborted) {
          throw new ProviderError("CANCELLED", "aborted", { providerKey: "openrouter" });
        }
        return "resposta que não deveria ser persistida";
      },
    });

    const instanceA = createInstance(url!, adapter, "a");
    const instanceB = createInstance(url!, adapter, "b");

    try {
      expect(instanceA.registry).not.toBe(instanceB.registry);

      const conversation = await instanceA.engine.createConversation(OWNER_ID, {
        title: "Cancelamento entre instâncias",
        assistantIds: ["00000000-0000-4000-8000-000000000001"],
      });
      await instanceA.db.withOwnerTransaction(
        { ownerId: OWNER_ID, actor: { type: "owner" } },
        async (repos) => {
          await repos.providerPreferences.setConversation(conversation.id, {
            mode: "automatic",
          });
        },
      );

      const execution = instanceA.engine.execute({
        ownerId: OWNER_ID,
        conversationId: conversation.id,
        request: {
          content: [{ type: "text", text: "tarefa longa entre instâncias" }],
          requestId: crypto.randomUUID(),
          idempotencyKey: `cancel-x-${crypto.randomUUID()}`,
          assistantKey: "yui",
        },
      });

      await startedPromise;

      const runs = await instanceA.engine.listExecutions(OWNER_ID, conversation.id);
      expect(runs).toHaveLength(1);
      const runId = runs[0]!.id;

      // Cancellation is issued by a different instance.
      const cancelled = await instanceB.engine.cancel(OWNER_ID, runId);
      expect(cancelled.execution.status).toBe("cancelled");

      const outcome = await execution.catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(CoreExecutionError);
      expect((outcome as CoreExecutionError).code).toBe("EXECUTION_CANCELLED");

      // The persisted terminal state is authoritative and carries no fake answer.
      const inspection = await instanceB.engine.inspect(OWNER_ID, runId);
      expect(inspection.execution.status).toBe("cancelled");
      expect(inspection.execution.status).not.toBe("succeeded");
      expect(inspection.execution.status).not.toBe("partial");
      expect(inspection.execution.finalMessageId).toBeUndefined();
      expect(inspection.results).toHaveLength(0);

      const messages = await instanceB.engine.listMessages(OWNER_ID, conversation.id);
      expect(messages.filter((message) => message.role === "assistant")).toHaveLength(0);

      // Cancelling again must not resurrect or overwrite the terminal row.
      await expect(instanceA.engine.cancel(OWNER_ID, runId)).rejects.toMatchObject({
        code: "EXECUTION_ALREADY_TERMINAL",
      });
      const stillCancelled = await instanceB.engine.inspect(OWNER_ID, runId);
      expect(stillCancelled.execution.status).toBe("cancelled");
    } finally {
      release();
      await instanceA.db.close();
      await instanceB.db.close();
    }
  }, 60_000);

  it("parent cancellation cascades to delegated children across instances", async () => {
    let releaseChild: () => void = () => undefined;
    let childStarted: () => void = () => undefined;
    const childStartedPromise = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });

    const adapter = createMockProviderAdapter({
      respond: async ({ systemContent, call }) => {
        if (systemContent.includes("ALICE")) {
          childStarted();
          try {
            await raceGate(gate, call.signal);
          } catch {
            throw new ProviderError("CANCELLED", "aborted", { providerKey: "openrouter" });
          }
          if (call.signal?.aborted) {
            throw new ProviderError("CANCELLED", "aborted", { providerKey: "openrouter" });
          }
          return "saída ALICE";
        }
        if (systemContent.includes("Modo de síntese coordenadora")) return "síntese";
        return JSON.stringify({
          kind: "nexus.core.coordination.v1",
          action: "delegate",
          delegations: [{ targetAssistant: "alice", objective: "analisar" }],
        });
      },
    });

    const instanceA = createInstance(url!, adapter, "c-a");
    const instanceB = createInstance(url!, adapter, "c-b");

    try {
      const conversation = await instanceA.engine.createConversation(OWNER_ID, {
        title: "Cancelamento de delegação entre instâncias",
        assistantIds: [
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000002",
        ],
      });
      await instanceA.db.withOwnerTransaction(
        { ownerId: OWNER_ID, actor: { type: "owner" } },
        async (repos) => {
          await repos.providerPreferences.setConversation(conversation.id, {
            mode: "automatic",
          });
        },
      );

      const execution = instanceA.engine.execute({
        ownerId: OWNER_ID,
        conversationId: conversation.id,
        request: {
          content: [{ type: "text", text: "delegue e aguarde" }],
          requestId: crypto.randomUUID(),
          idempotencyKey: `cancel-parent-${crypto.randomUUID()}`,
          assistantKey: "yui",
        },
      });

      await childStartedPromise;

      const runs = await instanceA.engine.listExecutions(OWNER_ID, conversation.id);
      const parent = runs.find((run) => run.parentRunId === undefined);
      expect(parent).toBeDefined();

      // The cancel request lands on instance B while the child runs on instance A.
      await instanceB.engine.cancel(OWNER_ID, parent!.id);

      const persisted = await instanceB.engine.listExecutions(OWNER_ID, conversation.id);
      const parentRow = persisted.find((run) => run.id === parent!.id)!;
      expect(parentRow.status).toBe("cancelled");
      const children = persisted.filter((run) => run.parentRunId === parent!.id);
      expect(children.length).toBeGreaterThan(0);
      for (const child of children) {
        expect(child.status).toBe("cancelled");
      }

      const outcome = await execution.catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(CoreExecutionError);

      const inspection = await instanceB.engine.inspect(OWNER_ID, parent!.id);
      expect(inspection.execution.status).toBe("cancelled");
      expect(inspection.execution.finalMessageId).toBeUndefined();
      expect(inspection.results).toHaveLength(0);
      for (const run of persisted) {
        expect(run.status).not.toBe("succeeded");
        expect(run.status).not.toBe("partial");
      }

      const messages = await instanceB.engine.listMessages(OWNER_ID, conversation.id);
      expect(messages.filter((message) => message.role === "assistant")).toHaveLength(0);
    } finally {
      releaseChild();
      await instanceA.db.close();
      await instanceB.db.close();
    }
  }, 60_000);

  it("concurrent cancellation wins over finalization without overwriting the terminal state", async () => {
    const adapter = createMockProviderAdapter({ respond: () => "resposta tardia" });
    const instanceA = createInstance(url!, adapter, "race-a");
    const instanceB = createInstance(url!, adapter, "race-b");

    try {
      const conversation = await instanceA.engine.createConversation(OWNER_ID, {
        title: "Corrida cancelamento/finalização",
        assistantIds: ["00000000-0000-4000-8000-000000000001"],
      });
      await instanceA.db.withOwnerTransaction(
        { ownerId: OWNER_ID, actor: { type: "owner" } },
        async (repos) => {
          await repos.providerPreferences.setConversation(conversation.id, {
            mode: "automatic",
          });
        },
      );

      const request = {
        content: [{ type: "text" as const, text: "corrida" }],
        requestId: crypto.randomUUID(),
        idempotencyKey: `race-${crypto.randomUUID()}`,
        assistantKey: "yui" as const,
      };

      // Run many iterations to exercise the lock ordering both ways.
      for (let index = 0; index < 6; index += 1) {
        const execution = instanceA.engine.execute({
          ownerId: OWNER_ID,
          conversationId: conversation.id,
          request: { ...request, requestId: crypto.randomUUID(), idempotencyKey: `race-${crypto.randomUUID()}` },
        });

        const runs = await (async () => {
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const current = await instanceA.engine.listExecutions(OWNER_ID, conversation.id);
            const running = current.find(
              (run) => run.status === "queued" || run.status === "running",
            );
            if (running) return running;
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          return undefined;
        })();

        if (!runs) {
          await execution.catch(() => undefined);
          continue;
        }

        // Fire cancellation and finalization concurrently.
        const cancelledPromise = instanceB.engine
          .cancel(OWNER_ID, runs.id)
          .catch((error: unknown) => error);
        const [cancelledResult, executionResult] = await Promise.all([
          cancelledPromise,
          execution.catch((error: unknown) => error),
        ]);

        const finalRow = (await instanceB.engine.listExecutions(OWNER_ID, conversation.id)).find(
          (run) => run.id === runs.id,
        )!;

        if (cancelledResult instanceof Error) {
          // Cancellation lost: the run legitimately completed first.
          expect(finalRow.status === "succeeded" || finalRow.status === "partial").toBe(true);
          expect(executionResult).not.toBeInstanceOf(Error);
        } else {
          // Cancellation won: finalization must never overwrite it.
          expect(finalRow.status).toBe("cancelled");
          expect(finalRow.finalMessageId).toBeUndefined();
          if (executionResult instanceof Error) {
            expect((executionResult as CoreExecutionError).code).toBe("EXECUTION_CANCELLED");
          }
        }

        // Regardless of the winner, terminal statuses are mutually exclusive.
        expect(["cancelled", "succeeded", "partial"]).toContain(finalRow.status);
      }
    } finally {
      await instanceA.db.close();
      await instanceB.db.close();
    }
  }, 90_000);
  /**
   * Deterministic reproduction of the cascade race:
   *
   *  1. instance B starts cancelling the parent;
   *  2. the cascade discovers the running child;
   *  3. instance A finalizes that child before the cascade tries to cancel it;
   *  4. the cascade must skip the now-terminal child and continue;
   *  5. the parent must stay `cancelled` (no rollback);
   *  6. no terminal run may have its state overwritten.
   *
   * Synchronization uses promise barriers only — no sleeps and no timing luck. The
   * cascade is paused at the seam between discovery and the conditional write (at
   * the start of the child's `getStatusForUpdate`, before any child row lock is
   * held), which guarantees instance A's finalization commits inside that window.
   */
  it("cascade skips a child finalized concurrently on another instance without rolling back the parent", async () => {
    const adapter = createMockProviderAdapter({ respond: () => "resposta" });
    const instanceA = createInstance(url!, adapter, "race-cascade-a");
    const instanceB = createInstance(url!, adapter, "race-cascade-b");

    // Barrier 1: B's cascade is about to revalidate/cancel the active child.
    let childDiscovered: () => void = () => undefined;
    let releaseCascade: () => void = () => undefined;
    const childDiscoveredPromise = new Promise<void>((resolve) => {
      childDiscovered = resolve;
    });
    const cascadeGate = new Promise<void>((resolve) => {
      releaseCascade = resolve;
    });

    // Declared before the instrumented database so the cascade seam can gate on
    // the specific child that is about to be cancelled.
    let parentRunId = "";
    let childRunId = "";

    let armed = false;
    const instrumentedDatabase = {
      withOwnerTransaction: async <T>(
        context: Parameters<PostgresNexusDatabase["withOwnerTransaction"]>[0],
        operation: (repos: NexusRepositories) => Promise<T>,
      ): Promise<T> =>
        instanceB.db.withOwnerTransaction(context, async (repos) => {
          const executions: NexusRepositories["executions"] = {
            ...repos.executions,
            // Seam of the cascade: the active child has been discovered and the
            // cascade is about to lock it. No child row lock is held here yet, so
            // instance A can finalize the child on its own pool.
            getStatusForUpdate: async (runId: string) => {
              if (!armed && runId === childRunId) {
                armed = true;
                childDiscovered();
                await cascadeGate;
              }
              return repos.executions.getStatusForUpdate(runId);
            },
          };
          return operation({ ...repos, executions });
        }),
    } as PostgresNexusDatabase;

    const instrumentedEngine = new NexusCoreEngine({
      database: instrumentedDatabase,
      providers: createMockProviderRuntime(adapter),
      registry: new ExecutionCancellationRegistry(),
      cancellationWatcher: new ExecutionCancellationWatcher({
        database: instrumentedDatabase,
        pollIntervalMs: 25,
        minProbeIntervalMs: 0,
      }),
    });

    try {
      const conversation = await instanceA.engine.createConversation(OWNER_ID, {
        title: "Corrida na cascata de cancelamento",
        assistantIds: [YUI_ID, ALICE_ID],
      });

      const ownerContext = { ownerId: OWNER_ID, actor: { type: "owner" } } as const;
      const now = (): string => new Date().toISOString();

      // A persisted, genuinely delegated hierarchy: parent + one running child.
      const created = await instanceA.db.withOwnerTransaction(
        ownerContext,
        async (repos) => {
          const inputMessage = await repos.messages.append(conversation.id, {
            content: [{ type: "text", text: "delegue e aguarde" }],
            requestId: crypto.randomUUID(),
            idempotencyKey: `race-input-${crypto.randomUUID()}`,
          });
          const createdAt = now();
          const parentId = crypto.randomUUID();
          const childId = crypto.randomUUID();
          const parentStepId = crypto.randomUUID();

          await repos.executions.create({
            id: parentId,
            userId: OWNER_ID,
            conversationId: conversation.id,
            requestId: crypto.randomUUID(),
            idempotencyKey: `race-parent-${crypto.randomUUID()}`,
            status: "running",
            assistantIds: [YUI_ID],
            trace: [],
            inputMessageId: inputMessage.id,
            createdAt,
            startedAt: createdAt,
            formatVersion: 1,
          });
          await repos.executions.appendStep({
            id: parentStepId,
            userId: OWNER_ID,
            runId: parentId,
            order: 0,
            assistant: { assistantId: YUI_ID, assistantKey: "yui", configVersion: "1.0.0" },
            status: "running",
            objective: "coordenar",
            inputReferenceIds: [],
            startedAt: createdAt,
          });
          await repos.executions.create({
            id: childId,
            userId: OWNER_ID,
            conversationId: conversation.id,
            requestId: crypto.randomUUID(),
            idempotencyKey: `race-child-${crypto.randomUUID()}`,
            status: "running",
            assistantIds: [ALICE_ID],
            trace: [],
            inputMessageId: inputMessage.id,
            parentRunId: parentId,
            parentStepId,
            delegationDepth: 1,
            createdAt,
            startedAt: createdAt,
            formatVersion: 1,
          });
          return { parentRunId: parentId, childRunId: childId };
        },
      );
      parentRunId = created.parentRunId;
      childRunId = created.childRunId;

      // 1. Instance B starts cancelling the parent. The parent row is already
      //    cancelled inside that transaction, but the cancellation only becomes
      //    visible once it commits — which is exactly what must not be rolled back.
      const cancellation = instrumentedEngine.cancel(OWNER_ID, parentRunId);

      // The cascade must revalidate the child under a row lock before cancelling it.
      // Reaching this seam is itself part of the contract: a cascade that writes
      // straight from the discovery snapshot never gets here.
      await Promise.race([
        childDiscoveredPromise,
        new Promise<never>((_, reject) => {
          setTimeout(
            () =>
              reject(
                new Error(
                  "cascade attempted to cancel the child without revalidating its status under a row lock",
                ),
              ),
            5_000,
          ).unref();
        }),
      ]);

      // 3. Instance A finalizes the child, on its own pool, through the real
      //    repository path, while B's cascade is paused.
      await instanceA.db.withOwnerTransaction(ownerContext, async (repos) => {
        const assistantMessage = await repos.messages.appendAssistant(conversation.id, {
          content: [{ type: "text", text: "saída ALICE" }],
          requestId: crypto.randomUUID(),
          idempotencyKey: `race-child-out-${crypto.randomUUID()}`,
          assistantId: ALICE_ID,
          runId: childRunId,
        });
        await repos.executions.complete(childRunId, {
          finalMessageId: assistantMessage.id,
          finishedAt: now(),
        });
      });
      // 2/4. Release the cascade: it must skip the terminal child and continue.
      releaseCascade();

      // A cascade that tries to cancel the already-terminal child is rejected by
      // the repository and rolls the whole parent cancellation back. Surface that
      // as an immediate, explicit failure instead of a lock-wait timeout.
      const result = await Promise.race([
        cancellation,
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("cascade did not finish: parent cancellation rolled back")),
            5_000,
          ).unref();
        }),
      ]);

      // 5. The parent cancellation was not rolled back.
      expect(result.execution.status).toBe("cancelled");
      const parentRow = await instanceA.engine.inspect(OWNER_ID, parentRunId);
      expect(parentRow.execution.status).toBe("cancelled");
      expect(parentRow.execution.finalMessageId).toBeUndefined();

      // 6. The child kept the terminal state it acquired concurrently: never
      //    overwritten by the cascade.
      const childRow = await instanceA.engine.inspect(OWNER_ID, childRunId);
      expect(childRow.execution.status).toBe("succeeded");
      expect(childRow.execution.finalMessageId).toBeDefined();

      const persisted = await instanceA.engine.listExecutions(OWNER_ID, conversation.id);
      expect(persisted.filter((run) => run.status === "succeeded")).toHaveLength(1);
      expect(persisted.filter((run) => run.status === "cancelled")).toHaveLength(1);
    } finally {
      releaseCascade();
      await instanceA.db.close();
      await instanceB.db.close();
    }
  }, 90_000);
});
