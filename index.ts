import { bootstrapServer } from "./apps/server/src/bootstrap.js";

const { app } = await bootstrapServer();

export default app;
