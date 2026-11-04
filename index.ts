import Fastify from "fastify";
import { bootstrapServer } from "./apps/server/src/bootstrap.js";

const { app }: { app: ReturnType<typeof Fastify> } = await bootstrapServer();

export default app;
