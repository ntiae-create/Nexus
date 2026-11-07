/**
 * Identifier helpers for request correlation.
 *
 * The CORE contract requires `requestId` (UUID) and `idempotencyKey` (1–200 chars) on every
 * message. Both must be generated on the client, remain stable across retries of the same
 * message, and never be reused for a different one.
 */

/**
 * RFC 4122 version 4 UUID.
 *
 * Prefers the platform CSPRNG (`crypto.randomUUID`), falling back to
 * `crypto.getRandomValues` — and only then to `Math.random` — so old Android WebViews keep
 * working. These ids are correlation handles, not secrets.
 */
export function createUuid(): string {
  const cryptoObject: Crypto | undefined = globalThis.crypto;

  if (cryptoObject && typeof cryptoObject.randomUUID === "function") {
    return cryptoObject.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (cryptoObject && typeof cryptoObject.getRandomValues === "function") {
    cryptoObject.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/**
 * Client idempotency key for one message.
 *
 * Unique per message (so two identical texts are still two messages), ≤ 200 characters, and
 * kept stable by the caller while retrying that same message. The CORE derives
 * `core:<conversationId>:<key>` and rejects reuse with different content
 * (`IDEMPOTENCY_CONFLICT`), which is exactly the protection we want.
 */
export function createIdempotencyKey(prefix = "msg"): string {
  return `${prefix}:${createUuid()}`;
}
