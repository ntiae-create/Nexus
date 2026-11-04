import type { BootstrappedServer } from "./bootstrap.js";

export type SignalName = "SIGINT" | "SIGTERM";

export interface ShutdownLogger {
  info?: (message: string) => void;
  error: (message: string, error?: unknown) => void;
}

export interface ShutdownControllerOptions {
  server: BootstrappedServer;
  log?: ShutdownLogger;
  /** Invoked after shutdown settles; default is process.exit. */
  exit?: (code: number) => void;
}

export interface ShutdownController {
  /** Single-flight graceful shutdown (app + pool via onClose). */
  shutdown(reason: string): Promise<void>;
  /** Registers one-shot SIGINT/SIGTERM handlers. */
  install(signalTarget?: NodeJS.EventEmitter): void;
  /** Removes handlers installed by install(). */
  uninstall(signalTarget?: NodeJS.EventEmitter): void;
}

/**
 * Coordinates process-level graceful shutdown without duplicate close work.
 */
export function createShutdownController(
  options: ShutdownControllerOptions,
): ShutdownController {
  const log: ShutdownLogger = options.log ?? {
    info: (message) => console.error(message),
    error: (message, error) => console.error(message, error),
  };
  const exit =
    options.exit ??
    ((code: number) => {
      process.exit(code);
    });

  let inFlight: Promise<void> | undefined;
  let exitCode = 0;

  const onSigInt = (): void => {
    void runSignal("SIGINT");
  };
  const onSigTerm = (): void => {
    void runSignal("SIGTERM");
  };

  const shutdown = async (reason: string): Promise<void> => {
    if (inFlight) return inFlight;

    inFlight = (async () => {
      log.info?.(`[nexus-server] Shutting down (${reason})`);
      try {
        await options.server.close();
      } catch (error) {
        exitCode = 1;
        log.error("[nexus-server] Error during graceful shutdown", error);
      }
    })();

    return inFlight;
  };

  const runSignal = async (signal: SignalName): Promise<void> => {
    await shutdown(signal);
    exit(exitCode);
  };

  return {
    shutdown,
    install(signalTarget: NodeJS.EventEmitter = process) {
      signalTarget.once("SIGINT", onSigInt);
      signalTarget.once("SIGTERM", onSigTerm);
    },
    uninstall(signalTarget: NodeJS.EventEmitter = process) {
      signalTarget.off("SIGINT", onSigInt);
      signalTarget.off("SIGTERM", onSigTerm);
    },
  };
}
