import { describe, expect, it } from "vitest";
import {
  COORDINATION_ENVELOPE_KIND,
  coreExecutionResponseSchema,
} from "@nexus/shared";
import type { PostgresNexusDatabase } from "@nexus/database";
import { createServerDatabase } from "../database.js";
import { NexusCoreEngine } from "./engine.js";
import { CoreExecutionError } from "./errors.js";
import { createMockProviderAdapter, createMockProviderRuntime } from "./mock-provider.js";

const url = process.env.NEXUS_DATABASE_URL;
const describeIfPostgres = url ? describe : describe.skip;

const OWNER_ID = "00000000-0000-4000-8000-000000000004";
const YUI = "00000000-0000-4000-8000-000000000001";
const ALICE = "00000000-0000-4000-8000-000000000002";

function conversationRequest() {
  return {
    requestId: crypto.randomUUID(),
    idempotencyKey: `pg-${crypto.randomUUID()}`,
  };
}

describeIfPostgres("NEXUS CORE over PostgreSQL 17 (real persistence and RLS)", () => {
  it("executes, delegates, persists and replays a real conversation end-to-end", async () => {
    const db: PostgresNexusDatabase = createServerDatabase({
      connectionString: url!,
      applicationName: "nexus-core-integration",
    });

    try {
      const adapter = createMockProviderAdapter({
        respond: ({ systemContent }) => {
          if (systemContent.includes("ALICE")) return "Evidência coletada pela ALICE";
          if (systemContent.includes("Modo de síntese coordenadora")) {
            return "Resposta final coordenada pela YUI";
          }
          return JSON.stringify({
            kind: COORDINATION_ENVELOPE_KIND,
            action: "delegate",
            delegations: [{ targetAssistant: "alice", objective: "coletar evidências" }],
          });
        },
      });
      const engine = new NexusCoreEngine({
        database: db,
        providers: createMockProviderRuntime(adapter),
      });

      // Deterministic provider selection for the assertion: the CORE must always
      // resolve through the Etapa 3A free-only runtime.
      await db.withOwnerTransaction(
        { ownerId: OWNER_ID, actor: { type: "owner" } },
        async (repos) => {
          await repos.providerPreferences.setGlobal({ mode: "automatic" });
          await repos.providerPreferences.clearAssistant(YUI);
          await repos.providerPreferences.clearAssistant(ALICE);
        },
      );

      const conversation = await engine.createConversation(OWNER_ID, {
        title: "Integração NEXUS CORE",
        assistantIds: [YUI, ALICE],
      });
      expect(conversation.userId).toBe(OWNER_ID);

      const request = {
        content: [{ type: "text" as const, text: "pesquise e sintetize" }],
        ...conversationRequest(),
        assistantKey: "yui" as const,
      };

      const response = await engine.execute({
        ownerId: OWNER_ID,
        conversationId: conversation.id,
        request,
      });

      expect(coreExecutionResponseSchema.safeParse(response).success).toBe(true);
      expect(response.execution.status).toBe("succeeded");
      expect(response.delegations).toHaveLength(1);
      expect(response.delegations[0]!.assistant.assistantKey).toBe("alice");
      expect(response.assistantMessage.content).toEqual([
        { type: "text", text: "Resposta final coordenada pela YUI" },
      ]);
      expect(response.childExecutions).toHaveLength(1);
      expect(response.childExecutions[0]!.parentRunId).toBe(response.execution.id);
      expect(response.childExecutions[0]!.delegationDepth).toBe(1);

      // Replay is served from PostgreSQL, byte-identical and without new provider calls.
      const callsBeforeReplay = adapter.calls.length;
      const replay = await engine.execute({
        ownerId: OWNER_ID,
        conversationId: conversation.id,
        request,
      });
      expect(replay.replayed).toBe(true);
      expect(replay.execution.id).toBe(response.execution.id);
      expect(replay.assistantMessage.id).toBe(response.assistantMessage.id);
      expect(adapter.calls).toHaveLength(callsBeforeReplay);

      // Persisted history is recoverable and ordered.
      const messages = await engine.listMessages(OWNER_ID, conversation.id);
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(messages.map((message) => message.sequence)).toEqual([0, 1]);

      const inspections = await engine.inspect(OWNER_ID, response.execution.id);
      expect(inspections.steps.length).toBeGreaterThanOrEqual(3);
      expect(inspections.results).toHaveLength(1);
      expect(inspections.childExecutions.map((child) => child.assistantIds)).toEqual([[ALICE]]);

      // RLS isolates the owner: an unknown owner cannot read the execution.
      await expect(
        engine.inspect("00000000-0000-4000-8000-000000000005", response.execution.id),
      ).rejects.toBeInstanceOf(CoreExecutionError);

      // Terminal executions are immutable through the CORE surface too.
      await expect(engine.cancel(OWNER_ID, response.execution.id)).rejects.toMatchObject({
        code: "EXECUTION_ALREADY_TERMINAL",
      });
    } finally {
      await db.close();
    }
  }, 60_000);
});
