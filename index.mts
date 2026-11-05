import Fastify from "fastify";
import { createServerlessApp } from "./apps/server/src/bootstrap.js";

const app: ReturnType<typeof Fastify> = createServerlessApp();

export default app;
