import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createShutdownController } from "./shutdown.js";
import type { BootstrappedServer } from "./bootstrap.js";

function makeServer(closeImpl?: () => Promise<void>): BootstrappedServer {
  return {
    app: {} as BootstrappedServer["app"],
    db: {} as BootstrappedServer["db"],
    port: 3000,
    close: closeImpl ?? vi.fn(async () => undefined),
  };
}

describe("createShutdownController", () => {
  it("SIGINT triggers a single graceful close and exit", async () => {
    const close = vi.fn(async () => undefined);
    const exit = vi.fn();
    const signals = new EventEmitter();
    const controller = createShutdownController({
      server: makeServer(close),
      exit,
      log: { error: vi.fn(), info: vi.fn() },
    });

    controller.install(signals);
    signals.emit("SIGINT");

    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    controller.uninstall(signals);
  });

  it("SIGTERM triggers graceful close", async () => {
    const close = vi.fn(async () => undefined);
    const exit = vi.fn();
    const signals = new EventEmitter();
    const controller = createShutdownController({
      server: makeServer(close),
      exit,
      log: { error: vi.fn(), info: vi.fn() },
    });

    controller.install(signals);
    signals.emit("SIGTERM");

    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    controller.uninstall(signals);
  });

  it("concurrent shutdown calls share one close operation", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.fn(async () => {
      await barrier;
    });
    const controller = createShutdownController({
      server: makeServer(close),
      exit: vi.fn(),
      log: { error: vi.fn(), info: vi.fn() },
    });

    const first = controller.shutdown("test-a");
    const second = controller.shutdown("test-b");
    expect(close).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("logs close failures and exits with code 1 on signal path", async () => {
    const close = vi.fn(async () => {
      throw new Error("close boom");
    });
    const exit = vi.fn();
    const logError = vi.fn();
    const signals = new EventEmitter();
    const controller = createShutdownController({
      server: makeServer(close),
      exit,
      log: { error: logError, info: vi.fn() },
    });

    controller.install(signals);
    signals.emit("SIGINT");

    await vi.waitFor(() => expect(logError).toHaveBeenCalled());
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    controller.uninstall(signals);
  });

  it("listen-failed shutdown closes the server once", async () => {
    const close = vi.fn(async () => undefined);
    const controller = createShutdownController({
      server: makeServer(close),
      exit: vi.fn(),
      log: { error: vi.fn(), info: vi.fn() },
    });

    await controller.shutdown("listen-failed");
    await controller.shutdown("listen-failed");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
