import { buildApp } from "./app.js";
import { createServerDatabase, type PostgresNexusDatabase } from "./database.js";

const app = buildApp();
const port = Number(process.env.PORT ?? 3000);

let db: PostgresNexusDatabase | undefined;

if (process.env.NEXUS_DATABASE_URL) {
  try {
    db = createServerDatabase();
    app.addHook("onClose", async () => {
      if (db) {
        await db.close();
        app.log.info("PostgreSQL pool closed");
      }
    });
    app.log.info("PostgreSQL database pool initialized");
  } catch (error) {
    app.log.error({ err: error }, "Failed to initialize PostgreSQL pool");
    process.exitCode = 1;
  }
} else {
  app.log.warn(
    "NEXUS_DATABASE_URL is not set; PostgreSQL persistence is disabled for this process",
  );
}

try {
  await app.listen({ host: "0.0.0.0", port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
