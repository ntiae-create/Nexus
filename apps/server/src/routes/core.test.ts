import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  coreExecutionResponseSchema,
  coreExecutionInspectionSchema,
} from "@nexus/shared";
import { buildApp } from "../app.js";
import { OWNER_ID, type SessionConfig } from "../auth/session.js";
import type { AuthStore } from "../auth/store.js";
import { NexusCoreEngine } from "../core/engine.js";
import { InMemoryNexusDatabase } from "../core/in-memory-database.js";
import {
  createMockProviderAdapter,
  createMockProviderRuntime,
  type MockProviderAdapterOptions,
} from "../core/mock-provider.js";
import {
  ALICE,
  SCHWI,
  YUI,
  conversation,
} from "../core/test-fixtures.js";
import { ProviderError } from "../providers/index.js";

const TEST_OWNER_PASSWORD = "test-owner-password-only-not-secret";
const TEST_SESSION_CONFIG: SessionConfig = {
  secret: "0123456789abcdef0123456789abcdef0123456789abcdef",
  ownerPassword: TEST_OWNER_PASSWORD,
  ttlSeconds: 3600,
};

function createMockAuthStore(): AuthStore {
  const revoked = new Set<string>();
  return {
    isRevoked: async (jti) => revoked.has(jti),
    revoke: async (jti) => {
      revoked.add(jti);
    },
    recordFailure: async () => true,
    clearFailures: async () => undefined,
  };
}

interface HttpHarness {
  app: ReturnType<typeof buildApp>;
  db: InMemoryNexusDatabase;
  adapter: ReturnType<typeof createMockProviderAdapter>;
  conversationId: string;
  token(): Promise<string>;
}

async function createHttpHarness(
  options: MockProviderAdapterOptions & { seedAssistants?: string[] } = {},
): Promise<HttpHarness> {
  const { seedAssistants, ...adapterOptions } = options;
  const db = new InMemoryNexusDatabase();
  const seed = conversation({
    assistantIds: seedAssistants ?? [YUI, ALICE, SCHWI],
  });
  db.seedConversation(seed);
  const adapter = createMockProviderAdapter({
    respond: () => "Resposta simulada do provedor",
    ...adapterOptions,
  });
  const core = new NexusCoreEngine({
    database: db,
    providers: createMockProviderRuntime(adapter),
  });
  const app = buildApp({
    logger: false,
    auth: { config: TEST_SESSION_CONFIG, store: createMockAuthStore() },
    core: { core },
  });

  return {
    app,
    db,
    adapter,
    conversationId: seed.id,
    token: async () => {
      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { password: TEST_OWNER_PASSWORD },
      });
      expect(login.statusCode).toBe(200);
      return (login.json() as { token: string }).token;
    },
  };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("NEXUS CORE HTTP routes", () => {
  it("requires authentication on every execution route", async () => {
    const harness = await createHttpHarness();
    try {
      const requests: Array<{ method: "GET" | "POST"; url: string }> = [
        { method: "GET", url: "/v1/conversations" },
        { method: "POST", url: "/v1/conversations" },
        { method: "GET", url: `/v1/conversations/${harness.conversationId}` },
        { method: "GET", url: `/v1/conversations/${harness.conversationId}/messages` },
        { method: "POST", url: `/v1/conversations/${harness.conversationId}/messages` },
        { method: "POST", url: `/v1/conversations/${harness.conversationId}/executions` },
        { method: "GET", url: `/v1/conversations/${harness.conversationId}/executions` },
        { method: "GET", url: `/v1/executions/${randomUUID()}` },
        { method: "POST", url: `/v1/executions/${randomUUID()}/cancel` },
      ];

      for (const request of requests) {
        for (const headers of [
          undefined,
          { authorization: "Bearer not-a-valid-token" },
        ]) {
          const response = await harness.app.inject({
            method: request.method,
            url: request.url,
            ...(headers ? { headers } : {}),
          });
          expect(response.statusCode).toBe(401);
          expect(apiErrorSchema.safeParse(response.json()).success).toBe(true);
        }
      }
      expect(harness.adapter.calls).toHaveLength(0);
    } finally {
      await harness.app.close();
    }
  });

  it("answers 503 CORE_NOT_CONFIGURED when the engine is not wired", async () => {
    const app = buildApp({
      logger: false,
      auth: { config: TEST_SESSION_CONFIG, store: createMockAuthStore() },
    });
    try {
      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { password: TEST_OWNER_PASSWORD },
      });
      const token = (login.json() as { token: string }).token;
      const response = await app.inject({
        method: "GET",
        url: "/v1/conversations",
        headers: bearer(token),
      });
      expect(response.statusCode).toBe(503);
      expect((response.json() as { error: { code: string } }).error.code).toBe(
        "CORE_NOT_CONFIGURED",
      );
    } finally {
      await app.close();
    }
  });

  it("executes a message through POST /v1/conversations/:id/messages and persists the result", async () => {
    const harness = await createHttpHarness();
    try {
      const token = await harness.token();
      const response = await harness.app.inject({
        method: "POST",
        url: `/v1/conversations/${harness.conversationId}/messages`,
        headers: bearer(token),
        payload: {
          content: [{ type: "text", text: "Execução via HTTP" }],
          requestId: randomUUID(),
          idempotencyKey: "http-exec-1",
          assistantKey: "yui",
        },
      });

      expect(response.statusCode).toBe(201);
      const parsed = coreExecutionResponseSchema.safeParse(response.json());
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.execution.status).toBe("succeeded");
        expect(parsed.data.assistantMessage.assistantId).toBe(YUI);
        expect(parsed.data.replayed).toBe(false);
      }

      const messages = await harness.app.inject({
        method: "GET",
        url: `/v1/conversations/${harness.conversationId}/messages`,
        headers: bearer(token),
      });
      expect(messages.statusCode).toBe(200);
      const list = messages.json() as { messages: Array<{ role: string }> };
      expect(list.messages.map((item) => item.role)).toEqual(["user", "assistant"]);
    } finally {
      await harness.app.close();
    }
  });

  it("returns the exact same execution when the same idempotency key is retried", async () => {
    const harness = await createHttpHarness();
    try {
      const token = await harness.token();
      const payload = {
        content: [{ type: "text", text: "Idempotência HTTP" }],
        requestId: randomUUID(),
        idempotencyKey: "http-idem-1",
        assistantKey: "yui",
      };
      const first = await harness.app.inject({
        method: "POST",
        url: `/v1/conversations/${harness.conversationId}/messages`,
        headers: bearer(token),
        payload,
      });
      const second = await harness.app.inject({
        method: "POST",
        url: `/v1/conversations/${harness.conversationId}/messages`,
        headers: bearer(token),
        payload,
      });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(200);
      const firstBody = first.json() as { execution: { id: string }; replayed: boolean };
      const secondBody = second.json() as { execution: { id: string }; replayed: boolean };
      expect(secondBody.execution.id).toBe(firstBody.execution.id);
      expect(firstBody.replayed).toBe(false);
      expect(secondBody.replayed).toBe(true);
      expect(harness.adapter.calls).toHaveLength(1);
    } finally {
      await harness.app.close();
    }
  });

  it("rejects cross-conversation and malformed identifiers with 404 without leaking data", async () => {
    const harness = await createHttpHarness();
    try {
      const token = await harness.token();
      const otherConversation = conversation({ userId: OWNER_ID });
      harness.db.seedConversation(otherConversation);
      harness.db.seedConversation({ ...otherConversation, id: randomUUID() });

      const unknown = await harness.app.inject({
        method: "POST",
        url: `/v1/conversations/${randomUUID()}/messages`,
        headers: bearer(token),
        payload: {
          content: [{ type: "text", text: "sem conversa" }],
          requestId: randomUUID(),
          idempotencyKey: "http-missing",
          assistantKey: "yui",
        },
      });
      expect(unknown.statusCode).toBe(404);
      expect((unknown.json() as { error: { code: string } }).error.code).toBe(
        "CONVERSATION_NOT_FOUND",
      );

      const malformed = await harness.app.inject({
        method: "GET",
        url: "/v1/conversations/not-a-uuid/messages",
        headers: bearer(token),
      });
      expect(malformed.statusCode).toBe(404);
      expect(malformed.body).not.toMatch(/select|nexus\./i);
    } finally {
      await harness.app.close();
    }
  });

  it("rejects assistant not participating in the conversation with 422", async () => {
    const harness = await createHttpHarness({ seedAssistants: [YUI] });
    try {
      const token = await harness.token();
      const response = await harness.app.inject({
        method: "POST",
        url: `/v1/conversations/${harness.conversationId}/executions`,
        headers: bearer(token),
        payload: {
          content: [{ type: "text", text: "quero a SCHWI" }],
          requestId: randomUUID(),
          idempotencyKey: "http-not-in-conv",
          assistantKey: "schwi",
        },
      });
      expect(response.statusCode).toBe(422);
      expect((response.json() as { error: { code: string } }).error.code).toBe(
        "ASSISTANT_NOT_IN_CONVERSATION",
      );
      expect(harness.adapter.calls).toHaveLength(0);
    } finally {
      await harness.app.close();
    }
  });

  it("returns provider failures with their own status and never a fictitious answer", async () => {
    const harness = await createHttpHarness({
      respond: () => {
        throw new ProviderError("TIMEOUT", "upstream timeout", {
          providerKey: "openrouter",
        });
      },
    });
    try {
      const token = await harness.token();
      const response = await harness.app.inject({
        method: "POST",
        url: `/v1/conversations/${harness.conversationId}/executions`,
        headers: bearer(token),
        payload: {
          content: [{ type: "text", text: "timeout HTTP" }],
          requestId: randomUUID(),
          idempotencyKey: "http-timeout",
          assistantKey: "yui",
        },
      });

      expect(response.statusCode).toBe(504);
      const body = response.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe("PROVIDER_TIMEOUT");
      expect(response.body).not.toMatch(/efetiv|sucesso|resposta padrão/i);

      const messages = await harness.app.inject({
        method: "GET",
        url: `/v1/conversations/${harness.conversationId}/messages`,
        headers: bearer(token),
      });
      const list = messages.json() as { messages: Array<{ role: string }> };
      expect(list.messages.filter((item) => item.role === "assistant")).toHaveLength(0);
    } finally {
      await harness.app.close();
    }
  });

  it("validates the request contract and returns structured issues", async () => {
    const harness = await createHttpHarness();
    try {
      const token = await harness.token();
      const invalid = await harness.app.inject({
        method: "POST",
        url: `/v1/conversations/${harness.conversationId}/executions`,
        headers: bearer(token),
        payload: {
          content: [],
          requestId: "not-a-uuid",
          idempotencyKey: "",
        },
      });
      expect(invalid.statusCode).toBe(400);
      const body = invalid.json() as { error: { code: string; details?: { issues?: unknown[] } } };
      expect(body.error.code).toBe("INVALID_REQUEST");
      expect(Array.isArray(body.error.details?.issues)).toBe(true);
      expect(harness.adapter.calls).toHaveLength(0);
    } finally {
      await harness.app.close();
    }
  });

  it("inspects and cancels executions over HTTP", async () => {
    const harness = await createHttpHarness();
    try {
      const token = await harness.token();
      const created = await harness.app.inject({
        method: "POST",
        url: `/v1/conversations/${harness.conversationId}/executions`,
        headers: bearer(token),
        payload: {
          content: [{ type: "text", text: "inspecionar HTTP" }],
          requestId: randomUUID(),
          idempotencyKey: "http-inspect",
          assistantKey: "yui",
        },
      });
      const runId = (created.json() as { execution: { id: string } }).execution.id;

      const inspected = await harness.app.inject({
        method: "GET",
        url: `/v1/executions/${runId}`,
        headers: bearer(token),
      });
      expect(inspected.statusCode).toBe(200);
      expect(coreExecutionInspectionSchema.safeParse(inspected.json()).success).toBe(true);

      const listed = await harness.app.inject({
        method: "GET",
        url: `/v1/conversations/${harness.conversationId}/executions`,
        headers: bearer(token),
      });
      expect(listed.statusCode).toBe(200);
      expect((listed.json() as { executions: unknown[] }).executions).toHaveLength(1);

      const cancelTerminal = await harness.app.inject({
        method: "POST",
        url: `/v1/executions/${runId}/cancel`,
        headers: bearer(token),
      });
      expect(cancelTerminal.statusCode).toBe(409);
      expect((cancelTerminal.json() as { error: { code: string } }).error.code).toBe(
        "EXECUTION_ALREADY_TERMINAL",
      );

      const missing = await harness.app.inject({
        method: "GET",
        url: `/v1/executions/${randomUUID()}`,
        headers: bearer(token),
      });
      expect(missing.statusCode).toBe(404);
      expect((missing.json() as { error: { code: string } }).error.code).toBe(
        "EXECUTION_NOT_FOUND",
      );
    } finally {
      await harness.app.close();
    }
  });

  it("creates conversations and appends a message without running the CORE", async () => {
    const harness = await createHttpHarness();
    try {
      const token = await harness.token();
      const created = await harness.app.inject({
        method: "POST",
        url: "/v1/conversations",
        headers: bearer(token),
        payload: { title: "Nova conversa", assistantIds: [YUI, ALICE] },
      });
      expect(created.statusCode).toBe(201);
      const conversationId = (created.json() as { conversation: { id: string } }).conversation.id;

      const appended = await harness.app.inject({
        method: "POST",
        url: `/v1/conversations/${conversationId}/messages`,
        headers: bearer(token),
        payload: {
          content: [{ type: "text", text: "somente registrar" }],
          requestId: randomUUID(),
          idempotencyKey: "http-plain-message",
          execute: false,
        },
      });
      expect(appended.statusCode).toBe(201);
      expect((appended.json() as { execution: null }).execution).toBeNull();
      expect(harness.adapter.calls).toHaveLength(0);

      const conversationList = await harness.app.inject({
        method: "GET",
        url: "/v1/conversations",
        headers: bearer(token),
      });
      expect((conversationList.json() as { conversations: unknown[] }).conversations).toHaveLength(2);
    } finally {
      await harness.app.close();
    }
  });

  it("exposes the delegated child executions through the execution inspection route", async () => {
    const harness = await createHttpHarness({
      respond: ({ systemContent }) => {
        if (systemContent.includes("ALICE")) return "análise da ALICE";
        if (systemContent.includes("Modo de síntese coordenadora")) return "síntese final";
        return JSON.stringify({
          kind: "nexus.core.coordination.v1",
          action: "delegate",
          delegations: [{ targetAssistant: "alice", objective: "analisar" }],
        });
      },
    });
    try {
      const token = await harness.token();
      const created = await harness.app.inject({
        method: "POST",
        url: `/v1/conversations/${harness.conversationId}/executions`,
        headers: bearer(token),
        payload: {
          content: [{ type: "text", text: "coordene via HTTP" }],
          requestId: randomUUID(),
          idempotencyKey: "http-delegation",
          assistantKey: "yui",
        },
      });
      expect(created.statusCode).toBe(201);
      const body = created.json() as {
        execution: { id: string };
        delegations: Array<{ assistant: { assistantKey: string }; childRunId: string }>;
      };
      expect(body.delegations).toHaveLength(1);
      expect(body.delegations[0]!.assistant.assistantKey).toBe("alice");

      const inspected = await harness.app.inject({
        method: "GET",
        url: `/v1/executions/${body.execution.id}`,
        headers: bearer(token),
      });
      const inspection = inspected.json() as {
        childExecutions: Array<{ id: string; parentRunId?: string; delegationDepth?: number }>;
      };
      expect(inspection.childExecutions).toHaveLength(1);
      expect(inspection.childExecutions[0]!.parentRunId).toBe(body.execution.id);
      expect(inspection.childExecutions[0]!.delegationDepth).toBe(1);
    } finally {
      await harness.app.close();
    }
  });
});
