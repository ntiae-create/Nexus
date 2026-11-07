import type { NexusDatabase } from "@nexus/database";
import type { CoreRun, UserId } from "@nexus/shared";
import type { CoreLogger } from "./engine.js";

const TERMINAL_STATUSES: ReadonlySet<CoreRun["status"]> = new Set([
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);

export const DEFAULT_CANCELLATION_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_CANCELLATION_MIN_PROBE_INTERVAL_MS = 250;

export interface CancellationWatcherOptions {
  readonly database: NexusDatabase;
  /**
   * Upper bound for the out-of-process probe interval. Tests can shorten it;
   * production uses a value well below a typical provider latency.
   */
  readonly pollIntervalMs?: number;
  /**
   * Minimum spacing between two persisted probes, so a hot loop (for example a
   * provider that returns instantly) cannot hammer PostgreSQL.
   */
  readonly minProbeIntervalMs?: number;
  readonly logger?: CoreLogger;
}

/**
 * Observes cancellation that was persisted by *another* process.
 *
 * In a serverless runtime the execution that calls the provider and the request
 * that cancels it may land on different instances, so the in-memory
 * `ExecutionCancellationRegistry` can never be the source of truth. This watcher
 * re-reads the run status from PostgreSQL and aborts the local signal as soon as
 * the persisted state becomes terminal.
 *
 * Invariants:
 * - Each probe is its own short read; no transaction or row lock is held while
 *   the external call is in flight.
 * - The in-memory registry remains a local fast path (same instance), not the
 *   authority.
 * - Probing never throws into the calling flow: a transient database error keeps
 *   the execution alive and is logged, because cancellation must be persisted
 *   first to be authoritative.
 */
export class ExecutionCancellationWatcher {
  private readonly database: NexusDatabase;
  private readonly pollIntervalMs: number;
  private readonly minProbeIntervalMs: number;
  private readonly logger?: CoreLogger;

  constructor(options: CancellationWatcherOptions) {
    this.database = options.database;
    this.pollIntervalMs = Math.max(
      DEFAULT_CANCELLATION_MIN_PROBE_INTERVAL_MS,
      options.pollIntervalMs ?? DEFAULT_CANCELLATION_POLL_INTERVAL_MS,
    );
    this.minProbeIntervalMs = Math.max(
      0,
      options.minProbeIntervalMs ?? DEFAULT_CANCELLATION_MIN_PROBE_INTERVAL_MS,
    );
    this.logger = options.logger;
  }

  /**
   * Reads the persisted status of a run in its own short transaction.
   * Returns `null` when the run cannot be read (missing or not accessible).
   */
  async readPersistedStatus(ownerId: UserId, runId: string): Promise<CoreRun["status"] | null> {
    return this.database.withOwnerTransaction(
      { ownerId, actor: { type: "owner" } },
      async (repositories) => repositories.executions.getStatus(runId),
    );
  }

  /**
   * Starts observing a run and aborts `controller` when the persisted state is
   * terminal (cancelled by another instance), or when the caller aborts.
   *
   * Returns a disposer that stops all timers/listeners and must be called in a
   * `finally` block.
   */
  watch(input: {
    readonly ownerId: UserId;
    readonly runId: string;
    readonly runIds?: readonly string[];
    readonly controller: AbortController;
    readonly callerSignal?: AbortSignal;
  }): () => void {
    const { ownerId, controller } = input;
    const runIds = [input.runId, ...(input.runIds ?? [])];
    let disposed = false;
    let timer: NodeJS.Timeout | undefined;
    let lastProbeAt = 0;
    let inFlight: Promise<void> | undefined;

    const abortLocally = (reason: "persisted_cancellation" | "caller"): void => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
      if (reason === "persisted_cancellation") {
        this.logger?.info(
          { runId: input.runId },
          "persisted cancellation observed by this instance",
        );
      }
    };

    const onCallerAbort = (): void => abortLocally("caller");
    if (input.callerSignal) {
      if (input.callerSignal.aborted) {
        abortLocally("caller");
      } else {
        input.callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }

    const probe = async (): Promise<void> => {
      if (disposed || controller.signal.aborted) return;
      const now = Date.now();
      if (now - lastProbeAt < this.minProbeIntervalMs) return;
      lastProbeAt = now;

      for (const runId of runIds) {
        let status: CoreRun["status"] | null;
        try {
          status = await this.readPersistedStatus(ownerId, runId);
        } catch (error) {
          // A failed probe must not abort a healthy execution. Cancellation is
          // authoritative only once it is persisted and readable.
          this.logger?.warn(
            { runId, reason: error instanceof Error ? error.name : "unknown" },
            "cancellation probe failed; keeping execution alive",
          );
          continue;
        }
        if (disposed) return;
        if (status && TERMINAL_STATUSES.has(status)) {
          abortLocally("persisted_cancellation");
          return;
        }
      }
    };

    const schedule = (): void => {
      if (disposed || controller.signal.aborted) return;
      timer = setTimeout(() => {
        if (disposed) return;
        inFlight = probe()
          .catch(() => undefined)
          .then(() => {
            inFlight = undefined;
            schedule();
          });
      }, this.pollIntervalMs);
      timer.unref?.();
    };

    schedule();

    return () => {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      input.callerSignal?.removeEventListener("abort", onCallerAbort);
      // An in-flight probe is left to settle; it checks `disposed` before acting.
      void inFlight;
    };
  }
}
