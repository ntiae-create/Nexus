import { createHash } from "node:crypto";

/**
 * Fixed RFC-4122 namespace UUID for deterministic NEXUS provider/model IDs.
 * Ensures every (providerKey) and (providerId, modelKey) pair derives a stable,
 * valid v5 UUID without requiring external dependencies or mutable state.
 */
const NEXUS_PROVIDER_NAMESPACE_HEX = "6ba7b8109dad11d180b400c04fd430c8";

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

export function deriveProviderId(providerKey: string): string {
  const normalized = providerKey.trim().toLowerCase();
  if (!normalized) {
    throw new Error("providerKey must not be empty");
  }
  return uuidV5FromName(NEXUS_PROVIDER_NAMESPACE_HEX, `nexus:provider:${normalized}`);
}

export function deriveModelId(providerId: string, modelKey: string): string {
  const normalizedProviderId = providerId.trim().toLowerCase();
  const normalizedModelKey = modelKey.trim();
  if (!normalizedProviderId || !normalizedModelKey) {
    throw new Error("providerId and modelKey must not be empty");
  }
  return uuidV5FromName(
    normalizedProviderId,
    `nexus:model:${normalizedModelKey}`,
  );
}

export const OPENROUTER_PROVIDER_KEY = "openrouter" as const;
export const OPENROUTER_PROVIDER_ID = deriveProviderId(OPENROUTER_PROVIDER_KEY);
