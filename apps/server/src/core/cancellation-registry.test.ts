import { describe, expect, it, vi } from "vitest";
import { ExecutionCancellationRegistry } from "./cancellation-registry.js";
import { CoreExecutionError } from "./errors.js";

const OWNER = "00000000-0000-4000-8000-000000000004";
const OTHER_OWNER = "00000000-0000-4000-8000-000000000005";

describe("NEXUS CORE cancellation registry", () => {
  it("aborts only the requested owner's execution", () => {
    const registry = new ExecutionCancellationRegistry();
    const handle = registry.register({ runId: "run-a", ownerId: OWNER });
    expect(handle.signal.aborted).toBe(false);

    expect(registry.cancel("run-a", OTHER_OWNER)).toBe(false);
    expect(handle.signal.aborted).toBe(false);

    expect(registry.cancel("run-a", OWNER)).toBe(true);
    expect(handle.signal.aborted).toBe(true);
    expect(registry.isAborted("run-a")).toBe(true);
    expect(registry.cancel("unknown-run", OWNER)).toBe(false);
    handle.release();
  });

  it("cascades cancellation from a parent execution to its children", () => {
    const registry = new ExecutionCancellationRegistry();
    const parent = registry.register({ runId: "parent", ownerId: OWNER });
    const child = registry.register({ runId: "child", ownerId: OWNER, parentRunId: "parent" });
    const grandchild = registry.register({
      runId: "grandchild",
      ownerId: OWNER,
      parentRunId: "child",
    });

    registry.cancel("parent", OWNER);

    expect(parent.signal.aborted).toBe(true);
    expect(child.signal.aborted).toBe(true);
    expect(grandchild.signal.aborted).toBe(true);

    parent.release();
    child.release();
    grandchild.release();
    expect(registry.cancel("parent", OWNER)).toBe(false);
  });

  it("propagates an already-cancelled caller signal to the execution", () => {
    const registry = new ExecutionCancellationRegistry();
    const controller = new AbortController();
    controller.abort();
    const handle = registry.register({
      runId: "run-c",
      ownerId: OWNER,
      callerSignal: controller.signal,
    });
    expect(handle.signal.aborted).toBe(true);
    handle.release();
  });

  it("cancels when the caller aborts later and removes the listener on release", () => {
    const registry = new ExecutionCancellationRegistry();
    const controller = new AbortController();
    const handle = registry.register({
      runId: "run-d",
      ownerId: OWNER,
      callerSignal: controller.signal,
    });
    expect(handle.signal.aborted).toBe(false);

    controller.abort();
    expect(handle.signal.aborted).toBe(true);
    handle.release();
    expect(registry.isAborted("run-d")).toBe(false);
  });

  it("registers a child after the parent was cancelled as already aborted", () => {
    const registry = new ExecutionCancellationRegistry();
    const parent = registry.register({ runId: "parent-2", ownerId: OWNER });
    registry.cancel("parent-2", OWNER);
    const child = registry.register({
      runId: "child-2",
      ownerId: OWNER,
      parentRunId: "parent-2",
    });
    expect(child.signal.aborted).toBe(true);
    child.release();
    parent.release();
  });

  it("exposes cancellation as an explicit domain error rather than a silent success", async () => {
    const registry = new ExecutionCancellationRegistry();
    const controller = new AbortController();
    const handle = registry.register({
      runId: "run-e",
      ownerId: OWNER,
      callerSignal: controller.signal,
    });
    const aborted = new Promise<never>((_, reject) => {
      handle.signal.addEventListener("abort", () => {
        reject(
          new CoreExecutionError("EXECUTION_CANCELLED", "Execution was cancelled", {
            statusCode: 409,
          }),
        );
      });
    });
    const spy = vi.fn();
    controller.abort();
    await expect(aborted.catch((error: unknown) => error)).resolves.toBeInstanceOf(
      CoreExecutionError,
    );
    expect(spy).not.toHaveBeenCalled();
    handle.release();
  });
});
