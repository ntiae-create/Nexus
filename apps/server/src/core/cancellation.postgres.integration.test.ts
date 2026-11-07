import { describe, expect, it } from "vitest";
import type { PostgresNexusDatabase } from "@nexus/database";
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
});
