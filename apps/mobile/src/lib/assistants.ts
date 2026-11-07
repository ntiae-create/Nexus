import { initialAssistantKeySchema, type InitialAssistantKey } from "@nexus/shared";

/**
 * Read-only mirror of the frozen assistant catalog, for display and selection.
 *
 * Sources of truth (never duplicated logic, only identity):
 * - `packages/assistant-profiles/src/catalog.ts` — frozen profiles (`id`, `key`, `name`);
 * - `packages/database/migrations/00001_initial_schema.sql` — seeded `nexus.assistants` rows.
 *
 * `apps/mobile/src/lib/assistants.test.ts` asserts that this mirror stays byte-for-byte
 * identical to the frozen catalog, so a profile change breaks the build instead of
 * silently mislabelling a message.
 *
 * This module is presentation data only. The app never decides who answers: delegation
 * (YUI → ALICE/SCHWI) belongs exclusively to the NEXUS CORE backend, and the mobile client
 * only sends `assistantKey` values the API contract already accepts.
 */
export interface AssistantOption {
  readonly key: InitialAssistantKey;
  /** Canonical UUID used when creating a conversation (`assistantIds`). */
  readonly id: string;
  readonly name: string;
}

const RAW_CATALOG: readonly { key: string; id: string; name: string }[] = [
  { key: "yui", id: "00000000-0000-4000-8000-000000000001", name: "YUI" },
  { key: "alice", id: "00000000-0000-4000-8000-000000000002", name: "ALICE" },
  { key: "schwi", id: "00000000-0000-4000-8000-000000000003", name: "SCHWI" },
];

/**
 * Parsed once, at module load: a key outside `initialAssistantKeySchema` would make
 * every request fail with `400 INVALID_REQUEST`, so it is rejected at build/test time.
 */
export const ASSISTANT_CATALOG: readonly AssistantOption[] = Object.freeze(
  RAW_CATALOG.map((assistant) => {
    const parsed = initialAssistantKeySchema.parse(assistant.key);
    return Object.freeze({
      key: parsed,
      id: assistant.id,
      name: assistant.name,
    });
  }),
);

const byKey = new Map<string, AssistantOption>(
  ASSISTANT_CATALOG.map((assistant) => [assistant.key, assistant]),
);
const byId = new Map<string, AssistantOption>(
  ASSISTANT_CATALOG.map((assistant) => [assistant.id, assistant]),
);

/** Resolves an assistant by its canonical key; `undefined` when not in the catalog. */
export function getAssistantByKey(key: string | null | undefined): AssistantOption | undefined {
  if (!key) return undefined;
  return byKey.get(key.toLowerCase());
}

/** Resolves an assistant by its canonical UUID; `undefined` for unknown ids. */
export function getAssistantById(id: string | null | undefined): AssistantOption | undefined {
  if (!id) return undefined;
  return byId.get(id);
}

/**
 * Assistants that participate in a conversation, in the order the server returned them.
 *
 * Only these may be addressed in that conversation: the CORE rejects any other target with
 * `ASSISTANT_NOT_IN_CONVERSATION`, so the UI must not offer it.
 */
export function getConversationAssistants(
  assistantIds: readonly string[],
): readonly AssistantOption[] {
  return assistantIds
    .map((id) => getAssistantById(id))
    .filter((assistant): assistant is AssistantOption => assistant !== undefined);
}

/**
 * Display label for a persisted assistant message.
 *
 * Prefers `metadata.assistantKey`, which the engine writes when it persists the reply, and
 * falls back to the canonical id. Returns `null` when the author is unknown, so the caller
 * can render a neutral label instead of guessing.
 */
export function resolveAssistantLabel(input: {
  readonly assistantId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}): string | null {
  const metadataKey = input.metadata?.["assistantKey"];
  if (typeof metadataKey === "string") {
    const byMetadata = getAssistantByKey(metadataKey);
    if (byMetadata) return byMetadata.name;
  }
  return getAssistantById(input.assistantId)?.name ?? null;
}
