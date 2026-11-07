import { describe, expect, it } from "vitest";
import { ExecutionCancellationRegistry } from "./cancellation-registry.js";
import { ExecutionCancellationWatcher } from "./cancellation-watcher.js";
import { NexusCoreEngine } from "./engine.js";
import { CoreExecutionError } from "./errors.js";
import type { InMemoryNexusDatabase } from "./in-memory-database.js";
import { createMockProviderAdapter, createMockProviderRuntime } from "./mock-provider.js";
import { OWNER_ID, YUI, conversation, createHarness } from "./test-fixtures.js";

/**
 * Each "instance" models a separate serverless worker: its own engine, its own
 * cancellation registry (in-memory fast path) and its own provider adapter. The
 * ONLY thing shared is the database handle, exactly like two Vercel invocations
 * hitting the same PostgreSQL.
 */
interface Instance {
  readonly engine: NexusCoreEngine;
  readonly registry: ExecutionCancellationRegistry;
}

function createInstance(
  db: InMemoryNexusDatabase,
  adapter: ReturnType<typeof createMockProviderAdapter>,
  options: { pollIntervalMs?: number; minProbeIntervalMs?: number } = {},
): Instance {
  const registry = new ExecutionCancellationRegistry();
  const engine = new NexusCoreEngine({
    database: db,
    providers: createMockProviderRuntime(adapter),
    registry,
    cancellationWatcher: new ExecutionCancellationWatcher({
      database: db,
      pollIntervalMs: options.pollIntervalMs ?? 5,
      minProbeIntervalMs: options.minProbeIntervalMs ?? 0,
    }),
  });
  return { engine, registry };
}

function request(idempotencyKey: string) {
  return {
    content: [{ type: "text" as const, text: "tarefa longa" }],
    requestId: crypto.randomUUID(),
    idempotencyKey,
    assistantKey: "yui" as const,
  };
}

/**
 * Resolves when the gate opens, or rejects as soon as the signal aborts —
 * exactly how a fetch-based adapter behaves with `AbortSignal`.
 */
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

/** Provider that blocks until released or aborted, emulating a slow upstream call. */
function createBlockingAdapter(onStart?: () => void) {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapter = createMockProviderAdapter({
    respond: async ({ call }) => {
      onStart?.();
      try {
        await raceGate(gate, call.signal);
      } catch {
        const { ProviderError } = await import("../providers/index.js");
        throw new ProviderError("CANCELLED", "aborted by signal", {
          providerKey: "openrouter",
        });
      }
      if (call.signal?.aborted) {
        const { ProviderError } = await import("../providers/index.js");
        throw new ProviderError("CANCELLED", "aborted by signal", {
          providerKey: "openrouter",
        });
      }
      return "resposta que não deveria ser usada";
    },
  });
  return { adapter, release: () => release?.() };
}

describe("NEXUS CORE cancellation across independent instances", () => {
  it("instance B observes a cancellation persisted by instance A and aborts the provider call", async () => {
    const harness = createHarness({ adapter: createMockProviderAdapter() });
    const db = harness.db;
    let providerStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const blocking = createBlockingAdapter(() => providerStarted());

    // Two independent instances over the same database.
    const instanceA = createInstance(db, blocking.adapter, { pollIntervalMs: 5 });
    const instanceB = createInstance(db, blocking.adapter, { pollIntervalMs: 5 });
    expect(instanceA.registry).not.toBe(instanceB.registry);

    const execution = instanceA.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: request("cross-instance-1"),
    });

    // Wait until the provider call is actually in flight on instance A.
    await started;

    // Instance B (different invocation, different memory) persists the cancel.
    const runId = db.snapshot().runs[0]!.id;
    const cancelled = await instanceB.engine.cancel(OWNER_ID, runId);
    expect(cancelled.execution.status).toBe("cancelled");

    // Instance A must notice via PostgreSQL, not via the shared registry.
    const outcome = await execution.catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(CoreExecutionError);
    expect((outcome as CoreExecutionError).code).toBe("EXECUTION_CANCELLED");

    // A cancelled run can never be succeeded/partial and produced no answer.
    const snapshot = db.snapshot();
    const stored = snapshot.runs.find((run) => run.id === runId)!;
    expect(stored.status).toBe("cancelled");
    expect(stored.status).not.toBe("succeeded");
    expect(stored.status).not.toBe("partial");
    expect(stored.finalMessageId).toBeUndefined();
    expect(snapshot.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
    expect(snapshot.results).toHaveLength(0);
  });

  it("checks persisted state before starting an external call on another instance", async () => {
    const harness = createHarness({ adapter: createMockProviderAdapter() });
    const db = harness.db;
    const adapterA = createMockProviderAdapter({ respond: () => "nunca chamado" });
    const adapterB = createMockProviderAdapter({ respond: () => "nunca chamado" });
    const instanceA = createInstance(db, adapterA);
    const instanceB = createInstance(db, adapterB);

    const queuedConversation = conversation();
    db.seedConversation(queuedConversation);
    const message = db.seedMessage({
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
    const run = await db.withOwnerTransaction(
      { ownerId: OWNER_ID, actor: { type: "owner" } },
      (repos) =>
        repos.executions.create({
          id: crypto.randomUUID(),
          userId: OWNER_ID,
          conversationId: queuedConversation.id,
          requestId: crypto.randomUUID(),
          idempotencyKey: `core:${queuedConversation.id}:pre-call`,
          status: "queued",
          assistantIds: [YUI],
          trace: [{ assistantId: YUI, assistantKey: "yui", configVersion: "1.0.0" }],
          inputMessageId: message.id,
          createdAt: "2026-11-05T12:00:00.000Z",
          formatVersion: 1,
        }),
    );

    await instanceB.engine.cancel(OWNER_ID, run.id);
    // Instance A tries to resume the already-cancelled run.
    await expect(instanceA.engine.cancel(OWNER_ID, run.id)).rejects.toMatchObject({
      code: "EXECUTION_ALREADY_TERMINAL",
    });
    expect(adapterA.calls).toHaveLength(0);
    expect(adapterB.calls).toHaveLength(0);
    expect(db.snapshot().runs[0]!.status).toBe("cancelled");
  });

  it("propagates a parent cancellation to child runs created by another instance", async () => {
    const harness = createHarness({ adapter: createMockProviderAdapter() });
    const db = harness.db;
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
            const { ProviderError } = await import("../providers/index.js");
            throw new ProviderError("CANCELLED", "aborted", { providerKey: "openrouter" });
          }
          if (call.signal?.aborted) {
            const { ProviderError } = await import("../providers/index.js");
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

    const instanceA = createInstance(db, adapter, { pollIntervalMs: 5 });
    const instanceB = createInstance(db, adapter, { pollIntervalMs: 5 });

    const execution = instanceA.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: request("cross-instance-parent"),
    });

    // Wait for the delegated child provider call to be in flight.
    await childStartedPromise;
    const parentRunId = db.snapshot().runs.find((run) => !run.parentRunId)!.id;
    const childRun = db.snapshot().runs.find((run) => run.parentRunId === parentRunId)!;

    // Cancellation lands on instance B: it must cascade to the child in the DB.
    await instanceB.engine.cancel(OWNER_ID, parentRunId);
    const afterCancel = db.snapshot();
    expect(afterCancel.runs.find((run) => run.id === parentRunId)!.status).toBe("cancelled");
    expect(afterCancel.runs.find((run) => run.id === childRun.id)!.status).toBe("cancelled");

    const outcome = await execution.catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(CoreExecutionError);
    const snapshot = db.snapshot();
    expect(snapshot.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
    expect(snapshot.results).toHaveLength(0);
    for (const run of snapshot.runs) {
      expect(run.status).not.toBe("succeeded");
      expect(run.status).not.toBe("partial");
    }
    releaseChild();
  });

  it("prevents a concurrent cancellation from being overwritten by finalization", async () => {
    const harness = createHarness({ adapter: createMockProviderAdapter() });
    const db = harness.db;
    let finishProvider: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      finishProvider = resolve;
    });
    const adapter = createMockProviderAdapter({
      respond: async () => {
        await gate;
        return "resposta tardia";
      },
    });

    const instanceA = createInstance(db, adapter, { pollIntervalMs: 1_000 });
    const instanceB = createInstance(db, adapter, { pollIntervalMs: 1_000 });

    const execution = instanceA.engine.execute({
      ownerId: OWNER_ID,
      conversationId: harness.conversationId,
      request: request("cross-instance-race"),
    });
    // Let the provider start, then cancel and only afterwards release the provider
    // so finalization races against an already-committed cancellation.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const runId = db.snapshot().runs[0]!.id;
    await instanceB.engine.cancel(OWNER_ID, runId);
    finishProvider();

    const outcome = await execution.catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(CoreExecutionError);
    expect((outcome as CoreExecutionError).code).toBe("EXECUTION_CANCELLED");

    const snapshot = db.snapshot();
    const stored = snapshot.runs.find((run) => run.id === runId)!;
    expect(stored.status).toBe("cancelled");
    expect(stored.finalMessageId).toBeUndefined();
    expect(snapshot.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
    expect(snapshot.results).toHaveLength(0);
  });
});
