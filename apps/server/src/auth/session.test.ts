import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { extractBearerToken, issueSessionToken, OWNER_ID, verifyOwnerPassword, verifySessionToken, type SessionConfig } from "./session.js";

const config: SessionConfig = {
  secret: "test-session-secret-at-least-16-chars",
  ownerPassword: "correct-horse-battery-staple",
  ttlSeconds: 3600,
};

describe("session auth", () => {
  it("accepts the configured owner password and rejects others", () => {
    expect(verifyOwnerPassword("correct-horse-battery-staple", config)).toBe(true);
    expect(verifyOwnerPassword("wrong-password", config)).toBe(false);
  });
  it("issues a verifiable token bound to the fixed owner", () => {
    const { token, payload } = issueSessionToken(config);
    expect(payload.ownerId).toBe(OWNER_ID);
    expect(verifySessionToken(token, config)?.jti).toBe(payload.jti);
  });
  it("rejects a correctly signed expired token", () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = { ownerId: OWNER_ID, issuedAt: now - 100, expiresAt: now - 1, jti: "a".repeat(32) };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", config.secret).update(encoded).digest("base64url");
    expect(verifySessionToken(`${encoded}.${signature}`, config)).toBeNull();
  });
  it("rejects tampered tokens", () => {
    const { token } = issueSessionToken(config);
    expect(verifySessionToken(token + "x", config)).toBeNull();
  });
  it("extracts Bearer tokens", () => {
    expect(extractBearerToken("Bearer abc.def")).toBe("abc.def");
    expect(extractBearerToken(undefined)).toBeNull();
  });
});
