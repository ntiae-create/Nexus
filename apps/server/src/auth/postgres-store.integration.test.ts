import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { createPostgresAuthStore } from "./postgres-store.js";
const url = process.env.NEXUS_TEST_AUTH_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite("PostgreSQL auth store concurrency (isolated PostgreSQL)", () => {
  const poolA = new pg.Pool({ connectionString: url, max: 12, application_name: "nexus-auth-test-a" });
  const poolB = new pg.Pool({ connectionString: url, max: 12, application_name: "nexus-auth-test-b" });
  const storeA = createPostgresAuthStore(poolA);
  const storeB = createPostgresAuthStore(poolB);
  beforeAll(async () => { await storeA.clearFailures(); });
  afterAll(async () => { await storeA.clearFailures(); await poolA.end(); await poolB.end(); });

  it("serializes concurrent failures across independently pooled instances", async () => {
    const attempts = await Promise.all(Array.from({ length: 32 }, (_, i) => (i % 2 ? storeA : storeB).recordFailure()));
    expect(attempts.filter(Boolean)).toHaveLength(4);
    expect(attempts.filter((x) => !x)).toHaveLength(28);
    const { rows } = await poolA.query("SELECT failed_attempts, locked_until > now() AS locked FROM nexus.auth_login_state WHERE singleton=true");
    expect(Number(rows[0].failed_attempts)).toBe(5);
    expect(rows[0].locked).toBe(true);
    expect(await storeB.recordFailure()).toBe(false);
  });

  it("shares revocation and only garbage-collects expired sessions", async () => {
    const live = randomBytes(16).toString("hex");
    const stale = randomBytes(16).toString("hex");
    await poolA.query("INSERT INTO nexus.revoked_sessions(jti,expires_at) VALUES($1,now()+interval '1 hour'),($2,now()-interval '1 second')", [live, stale]);
    expect(await storeB.isRevoked(live)).toBe(true);
    expect(await storeB.isRevoked(stale)).toBe(false);
    await storeB.revoke(randomBytes(16).toString("hex"), Math.floor(Date.now() / 1000) + 3600);
    const rows = await poolA.query("SELECT jti FROM nexus.revoked_sessions WHERE jti=ANY($1::text[])", [[live, stale]]);
    expect(rows.rows.map((r) => r.jti)).toEqual([live]);
    await poolA.query("DELETE FROM nexus.revoked_sessions WHERE jti=$1", [live]);
  });
});
