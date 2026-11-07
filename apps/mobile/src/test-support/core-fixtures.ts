import type {
  Conversation,
  CoreExecutionInspection,
  CoreExecutionResponse,
  CoreRun,
  Message,
} from "@nexus/shared";
import { TEST_OWNER_ID } from "./fakes.js";

/**
 * Fixtures shaped exactly like the CORE contract (`packages/shared/src/schemas/*`).
 *
 * They exist so tests exercise real field names — `assistantIds`, `formatVersion`,
 * `finalMessageId`, `failureCode` — instead of made-up ones. No network call is involved: the
 * fixtures are fed to a mocked `fetch`.
 */

export const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
export const CONVERSATION_ID_2 = "11111111-1111-4111-8111-222222222222";
export const RUN_ID = "22222222-2222-4222-8222-222222222222";
export const RUN_ID_2 = "22222222-2222-4222-8222-333333333333";
/** An unrelated run, useful to prove request-id filtering. */
export const TEST_RUN = "22222222-2222-4222-8222-444444444444";
export const USER_MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
export const ASSISTANT_MESSAGE_ID = "33333333-3333-4333-8333-444444444444";
export const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
export const IDEMPOTENCY_KEY = "msg:55555555-5555-4555-8555-555555555555";

export const YUI_ID = "00000000-0000-4000-8000-000000000001";
export const ALICE_ID = "00000000-0000-4000-8000-000000000002";
export const SCHWI_ID = "00000000-0000-4000-8000-000000000003";

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: CONVERSATION_ID,
    userId: TEST_OWNER_ID,
    title: null,
    status: "active",
    assistantIds: [YUI_ID],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...overrides,
  };
}

/** `role: "user"` message, as `POST .../messages` returns it in `inputMessage`. */
export function makeUserMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: USER_MESSAGE_ID,
    userId: TEST_OWNER_ID,
    conversationId: CONVERSATION_ID,
    sequence: 1,
    role: "user",
    status: "complete",
    content: [{ type: "text", text: "Olá, YUI" }],
    formatVersion: 1,
    createdAt: nowIso(),
    metadata: { source: "api", assistantKey: "yui" },
    ...overrides,
  };
}

/** `role: "assistant"` message; the contract requires `assistantId` for this role. */
export function makeAssistantMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: ASSISTANT_MESSAGE_ID,
    userId: TEST_OWNER_ID,
    conversationId: CONVERSATION_ID,
    sequence: 2,
    role: "assistant",
    assistantId: YUI_ID,
    runId: RUN_ID,
    status: "complete",
    content: [{ type: "text", text: "Olá! Como posso ajudar?" }],
    formatVersion: 1,
    createdAt: nowIso(),
    metadata: { source: "core", assistantKey: "yui", runStatus: "succeeded" },
    ...overrides,
  };
}

export function makeRun(overrides: Partial<CoreRun> = {}): CoreRun {
  return {
    id: RUN_ID,
    userId: TEST_OWNER_ID,
    conversationId: CONVERSATION_ID,
    requestId: REQUEST_ID,
    idempotencyKey: `core:${CONVERSATION_ID}:${IDEMPOTENCY_KEY}`,
    status: "succeeded",
    assistantIds: [YUI_ID],
    trace: [{ assistantId: YUI_ID, assistantKey: "yui", configVersion: "1.0.0" }],
    inputMessageId: USER_MESSAGE_ID,
    finalMessageId: ASSISTANT_MESSAGE_ID,
    createdAt: nowIso(),
    formatVersion: 1,
    metadata: { requestedAssistantKey: "yui" },
    ...overrides,
  };
}

export function makeInspection(overrides: Partial<CoreExecutionInspection> = {}): CoreExecutionInspection {
  return {
    execution: makeRun(),
    steps: [],
    results: [],
    childExecutions: [],
    ...overrides,
  };
}

/**
 * Non-terminal / terminal runs as the server would list them.
 *
 * `listByConversation` orders by `createdAt ASC, id ASC`, so fixtures keep that ordering
 * where the test depends on it (recovery follows the oldest active run).
 */
export function makeActiveRuns(runs: readonly CoreRun[]): readonly CoreRun[] {
  return [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Full `POST /v1/conversations/:id/messages` body (HTTP 201). */
export function makeExecutionResponse(
  overrides: Partial<CoreExecutionResponse> = {},
): CoreExecutionResponse {
  return {
    execution: makeRun(),
    inputMessage: makeUserMessage(),
    assistantMessage: makeAssistantMessage(),
    steps: [],
    results: [],
    delegations: [],
    childExecutions: [],
    modelSelection: {
      resolvedScope: "global",
      providerId: "66666666-6666-4666-8666-666666666666",
      providerKey: "openrouter",
      providerName: "OpenRouter",
      modelId: "77777777-7777-4777-8777-777777777777",
      modelKey: "some/free-model:free",
      modelName: "Some Free Model",
      contextWindow: 8192,
      freeEligibility: {
        eligible: true,
        costStatus: "free_confirmed",
        verifiedAt: nowIso(),
        requiresPreCallVerification: true,
        reason: "verified_free",
        pricingSummary: {
          promptPerToken: 0,
          completionPerToken: 0,
          requestFixed: null,
        },
      },
    },
    contextReport: {
      effectiveContextWindow: 8192,
      usedFallbackWindow: false,
      reservedOutputBudget: 1024,
      availableInputBudget: 7168,
      estimatedInputUnits: 42,
      includedHistoryCount: 0,
      omittedHistoryCount: 0,
    },
    replayed: false,
    ...overrides,
  };
}
