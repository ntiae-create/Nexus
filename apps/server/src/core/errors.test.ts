import { describe, expect, it } from "vitest";
import { apiErrorSchema } from "@nexus/shared";
import { CoreExecutionError } from "./errors.js";
import { ProviderError } from "../providers/index.js";

const FAKE_SECRET = "sk-or-v1-test-only-fake-secret-value-0123456789";

describe("NEXUS CORE error contract", () => {
  it("maps every core error code to a stable HTTP status and retryability", () => {
    const cases: Array<[string, number, boolean]> = [
      ["CONVERSATION_NOT_FOUND", 404, false],
      ["EXECUTION_NOT_FOUND", 404, false],
      ["ASSISTANT_NOT_FOUND", 404, false],
      ["EXECUTION_ALREADY_TERMINAL", 409, false],
      ["EXECUTION_IN_PROGRESS", 409, true],
      ["IDEMPOTENCY_CONFLICT", 409, false],
      ["CONTEXT_LIMIT_EXCEEDED", 422, false],
      ["DELEGATION_CYCLE_DETECTED", 422, false],
      ["DELEGATION_DEPTH_EXCEEDED", 422, false],
      ["DELEGATION_LIMIT_EXCEEDED", 422, false],
      ["DELEGATED_EXECUTION_FAILED", 502, false],
      ["EMPTY_MODEL_RESPONSE", 502, false],
      ["PERSISTENCE_FAILED", 503, true],
      ["CORE_NOT_CONFIGURED", 503, true],
    ];

    for (const [code, status, retryable] of cases) {
      const error = new CoreExecutionError(code as never, "mensagem");
      expect(error.statusCode).toBe(status);
      expect(error.retryable).toBe(retryable);
      const parsed = apiErrorSchema.safeParse(error.toApiError("d9428888-122b-4c81-8f6d-5f9b1f3b5b21"));
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.error.code).toBe(code);
        expect(parsed.data.error.retryable).toBe(retryable);
      }
    }
  });

  it("redacts secrets from the message, the cause and the stack", () => {
    const error = new CoreExecutionError(
      "PERSISTENCE_FAILED",
      `upstream rejected key ${FAKE_SECRET}`,
      {
        redactValues: [FAKE_SECRET],
        cause: new Error(`authorization: Bearer ${FAKE_SECRET}`),
      },
    );

    expect(error.message).not.toContain(FAKE_SECRET);
    expect(error.message).toContain("[REDACTED]");
    expect(error.stack ?? "").not.toContain(FAKE_SECRET);
    expect((error.cause as Error).message).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(error.toApiError())).not.toContain(FAKE_SECRET);
  });

  it("drops credential-bearing detail fields instead of persisting them", () => {
    const error = new CoreExecutionError("DELEGATION_NOT_ALLOWED", "negado", {
      details: {
        sourceAssistant: "alice",
        targetAssistant: "schwi",
        apiKey: FAKE_SECRET,
        authorization: `Bearer ${FAKE_SECRET}`,
        nested: { token: FAKE_SECRET, safe: "valor" },
      },
    });

    expect(error.details).not.toHaveProperty("apiKey");
    expect(error.details).not.toHaveProperty("authorization");
    expect(JSON.stringify(error.details)).not.toContain(FAKE_SECRET);
    expect(error.details?.nested).toMatchObject({ safe: "valor" });
  });

  it("keeps provider errors as distinct, redacted contracts", () => {
    const providerError = new ProviderError("TIMEOUT", `timeout with ${FAKE_SECRET}`, {
      providerKey: "openrouter",
      redactValues: [FAKE_SECRET],
    });
    expect(providerError.statusCode).toBe(504);
    expect(providerError.retryable).toBe(true);
    expect(providerError.message).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(providerError.toApiError())).not.toContain(FAKE_SECRET);
    expect(providerError.toApiError().error.code).toBe("PROVIDER_TIMEOUT");
  });
});
