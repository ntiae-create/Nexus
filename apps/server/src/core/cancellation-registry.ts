export interface RegisteredExecutionHandle {
  readonly runId: string;
  readonly ownerId: string;
  readonly parentRunId?: string;
  readonly signal: AbortSignal;
  release(): void;
}

interface ActiveRunEntry {
  readonly runId: string;
  readonly ownerId: string;
  readonly parentRunId?: string;
  readonly controller: AbortController;
  readonly childRunIds: Set<string>;
  readonly cleanupCallerSignal?: () => void;
}

/**
 * Tracks in-flight executions on the current server instance so cancellation
 * requests immediately abort active provider calls and cascade to child runs.
 */
export class ExecutionCancellationRegistry {
  private readonly active = new Map<string, ActiveRunEntry>();

  register(input: {
    readonly runId: string;
    readonly ownerId: string;
    readonly parentRunId?: string;
    readonly callerSignal?: AbortSignal;
  }): RegisteredExecutionHandle {
    const controller = new AbortController();

    let cleanupCallerSignal: (() => void) | undefined;
    if (input.callerSignal) {
      if (input.callerSignal.aborted) {
        controller.abort();
      } else {
        const onCallerAbort = (): void => {
          this.cancel(input.runId, input.ownerId);
        };
        input.callerSignal.addEventListener("abort", onCallerAbort, { once: true });
        cleanupCallerSignal = () => {
          input.callerSignal?.removeEventListener("abort", onCallerAbort);
        };
      }
    }

    if (input.parentRunId) {
      const parent = this.active.get(input.parentRunId);
      if (parent) {
        parent.childRunIds.add(input.runId);
        if (parent.controller.signal.aborted) {
          controller.abort();
        }
      }
    }

    const entry: ActiveRunEntry = {
      runId: input.runId,
      ownerId: input.ownerId,
      parentRunId: input.parentRunId,
      controller,
      childRunIds: new Set<string>(),
      cleanupCallerSignal,
    };

    this.active.set(input.runId, entry);

    return {
      runId: input.runId,
      ownerId: input.ownerId,
      parentRunId: input.parentRunId,
      signal: controller.signal,
      release: () => {
        const current = this.active.get(input.runId);
        if (!current) return;
        current.cleanupCallerSignal?.();
        if (current.parentRunId) {
          this.active.get(current.parentRunId)?.childRunIds.delete(input.runId);
        }
        this.active.delete(input.runId);
      },
    };
  }

  cancel(runId: string, ownerId: string): boolean {
    const entry = this.active.get(runId);
    if (!entry || entry.ownerId !== ownerId) {
      return false;
    }

    entry.controller.abort();
    for (const childId of entry.childRunIds) {
      this.cancel(childId, ownerId);
    }
    return true;
  }

  isAborted(runId: string): boolean {
    return this.active.get(runId)?.controller.signal.aborted ?? false;
  }
}
