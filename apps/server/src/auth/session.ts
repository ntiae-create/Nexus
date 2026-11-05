import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const OWNER_ID = "00000000-0000-4000-8000-000000000004" as const;

export interface SessionPayload {
  readonly ownerId: typeof OWNER_ID;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly jti: string;
}

export interface SessionConfig {
  readonly secret: string;
  readonly ownerPassword: string;
  readonly ttlSeconds?: number;
}

const DEFAULT_TTL = 60 * 60 * 24 * 7;

function requireSecret(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length < 16) {
    throw new Error(
      `${name} must be set to a secret of at least 16 characters (environment / secret manager only)`,
    );
  }
  return trimmed;
}

export function loadSessionConfig(env: NodeJS.ProcessEnv = process.env): SessionConfig {
  return {
    secret: requireSecret(env.NEXUS_SESSION_SECRET, "NEXUS_SESSION_SECRET"),
    ownerPassword: requireSecret(env.NEXUS_OWNER_PASSWORD, "NEXUS_OWNER_PASSWORD"),
    ttlSeconds: Number(env.NEXUS_SESSION_TTL_SECONDS) || DEFAULT_TTL,
  };
}

function passwordDigest(password: string, secret: string): Buffer {
  const salt = createHmac("sha256", secret).update("nexus-owner-password-salt").digest();
  return scryptSync(password, salt, 32);
}

export function verifyOwnerPassword(candidate: string, config: SessionConfig): boolean {
  try {
    const expected = passwordDigest(config.ownerPassword, config.secret);
    const actual = passwordDigest(candidate, config.secret);
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

export function issueSessionToken(config: SessionConfig): {
  token: string;
  payload: SessionPayload;
} {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    ownerId: OWNER_ID,
    issuedAt: now,
    expiresAt: now + (config.ttlSeconds ?? DEFAULT_TTL),
    jti: randomBytes(16).toString("hex"),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = sign(payloadB64, config.secret);
  return { token: `${payloadB64}.${signature}`, payload };
}

export function verifySessionToken(
  token: string,
  config: SessionConfig,
): SessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, signature] = parts;
  if (!payloadB64 || !signature) return null;
  const expected = sign(payloadB64, config.secret);
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const json = Buffer.from(payloadB64, "base64url").toString("utf8");
    const payload = JSON.parse(json) as SessionPayload;
    if (payload.ownerId !== OWNER_ID) return null;
    if (typeof payload.expiresAt !== "number" || payload.expiresAt < Math.floor(Date.now() / 1000)) {
      return null;
    }
    if (typeof payload.issuedAt !== "number" || typeof payload.jti !== "string") return null;
    return payload;
  } catch {
    return null;
  }
}

export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match?.[1]?.trim() || null;
}
