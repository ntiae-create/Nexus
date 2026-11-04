import { bootstrapServer, BootstrapError } from "./bootstrap.js";
import { createShutdownController } from "./shutdown.js";

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof bootstrapServer>> | undefined;

  try {
    server = await bootstrapServer();
  } catch (error) {
    if (error instanceof BootstrapError) {
      console.error(`[nexus-server] ${error.message}`);
    } else {
      console.error("[nexus-server] Startup failed", error);
    }
    process.exitCode = 1;
    return;
  }

  const { app, port } = server;
  const shutdown = createShutdownController({
    server,
    log: {
      info: (message) => app.log.info(message),
      error: (message, error) => app.log.error({ err: error }, message),
    },
  });
  shutdown.install(process);

  try {
    await app.listen({ host: "0.0.0.0", port });
    app.log.info({ port }, "NEXUS server listening");
  } catch (error) {
    app.log.error({ err: error }, "Failed to bind HTTP server");
    try {
      await shutdown.shutdown("listen-failed");
    } catch (closeError) {
      app.log.error({ err: closeError }, "Failed to close after listen error");
    }
    process.exitCode = 1;
  }
}

await main();
