import { createHash } from "node:crypto";

/**
 * Fixed RFC-4122 namespace UUID used to derive deterministic identifiers for
 * NEXUS CORE executions. Deterministic IDs make idempotency and delegation
 * lineage verifiable without relying on mutable in-memory state.
 */
const CORE_NAMESPACE_HEX = "6ba7b8129dad11d180b400c04fd430c8";

function uuidV5FromName(namespaceHex: string, name: string): string {
  const namespaceBytes = Buffer.from(namespaceHex.replace(/-/g, ""), "hex");
  const digest = createHash("sha1")
    .update(namespaceBytes)
    .update(Buffer.from(name, "utf8"))
    .digest();

  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 / 9562 variant

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export function deriveCoreUuid(name: string): string {
  const normalized = name.trim();
  if (!normalized) {
    throw new Error("Deterministic identifier name must not be empty");
  }
  return uuidV5FromName(CORE_NAMESPACE_HEX, `nexus:core:${normalized}`);
}

export function deriveRootRunId(conversationId: string, idempotencyKey: string): string {
  return deriveCoreUuid(`run:${conversationId}:${idempotencyKey}`);
}

export function deriveChildRunId(
  parentRunId: string,
  index: number,
  targetAssistant: string,
): string {
  return deriveCoreUuid(`child:${parentRunId}:${index}:${targetAssistant}`);
}

export function deriveStepId(runId: string, ordinal: number, kind: string): string {
  return deriveCoreUuid(`step:${runId}:${ordinal}:${kind}`);
}

export function deriveOutcomeUuid(runId: string, kind: string): string {
  return deriveCoreUuid(`outcome:${runId}:${kind}`);
}

/**
 * Message idempotency keys are scoped per conversation and bounded to 200 chars
 * by the database contract (messages_idempotency_key_length).
 */
export function deriveMessageIdempotencyKey(runId: string, kind: "in" | "out"): string {
  return `core:${runId}:${kind}`;
}

export function deriveRunIdempotencyKey(conversationId: string, idempotencyKey: string): string {
  return `core:${conversationId}:${idempotencyKey}`;
}
