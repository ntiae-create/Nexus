import type { JsonValue } from "@nexus/shared";

const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_PATTERN =
  /secret|credential|password|token|api[_-]?key|authorization|bearer/i;

const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const OPENROUTER_KEY_PATTERN = /\bsk-or-v1-[A-Za-z0-9_-]+/gi;
const GENERIC_SK_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{12,}/g;
const INLINE_CREDENTIAL_ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|authorization|access[_-]?token|secret|password)\b(\s*[:=]\s*)(["']?)([^\s"',;}\]]+)\3/gi;
const URL_USERINFO_PATTERN = /\b(https?:\/\/)([^/\s:@]+:[^/\s@]+)@/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redacts explicit secret values and common credential patterns (Bearer tokens,
 * OpenRouter keys, generic sk-* keys, inline key=value credentials, URL userinfo)
 * from any diagnostic or error text so secrets never leak to logs or clients.
 */
export function redactSecrets(
  input: string,
  knownSecrets: readonly (string | undefined)[] = [],
): string {
  if (!input) return input;

  let output = input;

  for (const rawSecret of knownSecrets) {
    const secret = rawSecret?.trim();
    if (!secret) continue;
    output = output.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
    const urlEncoded = encodeURIComponent(secret);
    if (urlEncoded !== secret) {
      output = output.replace(new RegExp(escapeRegExp(urlEncoded), "g"), REDACTED);
    }
    const base64Encoded = Buffer.from(secret, "utf8").toString("base64");
    if (base64Encoded.length >= 8) {
      output = output.replace(
        new RegExp(escapeRegExp(base64Encoded), "g"),
        REDACTED,
      );
    }
  }

  output = output
    .replace(BEARER_TOKEN_PATTERN, `Bearer ${REDACTED}`)
    .replace(OPENROUTER_KEY_PATTERN, REDACTED)
    .replace(GENERIC_SK_KEY_PATTERN, REDACTED)
    .replace(INLINE_CREDENTIAL_ASSIGNMENT_PATTERN, `$1$2$3${REDACTED}$3`)
    .replace(URL_USERINFO_PATTERN, `$1${REDACTED}@`);

  return output;
}

export function sanitizeValue(
  value: unknown,
  knownSecrets: readonly (string | undefined)[] = [],
  depth = 0,
): JsonValue {
  if (depth > 6) {
    return "[Truncated]";
  }
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return redactSecrets(value, knownSecrets);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, knownSecrets, depth + 1));
  }
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        result[key] = REDACTED;
      } else {
        result[key] = sanitizeValue(entry, knownSecrets, depth + 1);
      }
    }
    return result;
  }
  return redactSecrets(String(value), knownSecrets);
}

export function sanitizeDetailsRecord(
  details: Record<string, unknown> | undefined,
  knownSecrets: readonly (string | undefined)[] = [],
): Record<string, JsonValue> | undefined {
  if (!details) return undefined;
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(details)) {
    if (entry === undefined || SENSITIVE_KEY_PATTERN.test(key)) {
      continue;
    }
    result[key] = sanitizeValue(entry, knownSecrets, 1);
  }
  return result;
}

/**
 * Produces a safe Error representation for `Error.cause` without retaining raw
 * HTTP request/response objects, headers, or credential values.
 */
export function sanitizeErrorCause(
  cause: unknown,
  knownSecrets: readonly (string | undefined)[] = [],
): Error | undefined {
  if (!cause) return undefined;
  if (cause instanceof Error) {
    const safe = new Error(redactSecrets(cause.message, knownSecrets));
    safe.name = cause.name;
    delete safe.stack;
    return safe;
  }
  if (typeof cause === "string") {
    const safe = new Error(redactSecrets(cause, knownSecrets));
    delete safe.stack;
    return safe;
  }
  return undefined;
}
