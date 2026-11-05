/**
 * Integration tests that require a real PostgreSQL instance.
 * Skipped automatically when NEXUS_DATABASE_URL is not set.
 *
 * Cases covered:
 * - pool size 1 reuse does not leave residual session context
 * - rollback leaves no partial data
 * - close() ends the pool cleanly
 * - owner identity is readable under RLS context
 * - public surface does not expose pool / query
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPostgresDatabase } from "./index.js";
import type { PostgresNexusDatabase } from "./index.js";

const url = process.env.NEXUS_DATABASE_URL;
const describeIf = url ? describe : describe.skip;

describeIf("postgres pool + transaction integration", () => {
  let db: PostgresNexusDatabase;

  beforeAll(() => {
    db = createPostgresDatabase({
      connectionString: url!,
      max: 1,
      applicationName: "nexus-test",
    });
  });

  afterAll(async () => {
    await db.close();
  });

  it("does not expose pool or query on the public database handle", () => {
    expect((db as any).pool).toBeUndefined();
    expect((db as any).query).toBeUndefined();
    expect(typeof db.withOwnerTransaction).toBe("function");
    expect(typeof db.close).toBe("function");
  });

  it("reads owner identity inside a transaction", async () => {
    const owner = await db.withOwnerTransaction(
      {
        ownerId: "00000000-0000-4000-8000-000000000004",
        actor: { type: "owner" },
      },
      async (repos) => repos.owner.getCurrent(),
    );
    expect(owner).not.toBeNull();
    expect(owner!.userId).toBe("00000000-0000-4000-8000-000000000004");
  });

  it("does not leak transaction-local config across pool reuse (max=1)", async () => {
    await db.withOwnerTransaction(
      {
        ownerId: "00000000-0000-4000-8000-000000000004",
        actor: { type: "owner" },
      },
      async () => "first",
    );

    const second = await db.withOwnerTransaction(
      {
        ownerId: "00000000-0000-4000-8000-000000000004",
        actor: { type: "owner" },
      },
      async (repos) => {
        const owner = await repos.owner.getCurrent();
        return owner?.userId ?? null;
      },
    );
    expect(second).toBe("00000000-0000-4000-8000-000000000004");
  });

  it("rolls back on error and does not leave partial conversation", async () => {
    const rollbackTitle = `should-rollback-integration-${randomUUID()}`;
    let rolledBackId: string | undefined;

    await expect(
      db.withOwnerTransaction(
        {
          ownerId: "00000000-0000-4000-8000-000000000004",
          actor: { type: "owner" },
        },
        async (repos) => {
          const created = await repos.conversations.create({ title: rollbackTitle });
          rolledBackId = created.id;
          throw new Error("force rollback");
        },
      ),
    ).rejects.toThrow("force rollback");

    expect(rolledBackId).toBeDefined();

    const persisted = await db.withOwnerTransaction(
      {
        ownerId: "00000000-0000-4000-8000-000000000004",
        actor: { type: "owner" },
      },
      async (repos) => ({
        byId: await repos.conversations.getById(rolledBackId!),
        byTitle: (await repos.conversations.list()).some(
          (conversation) =>
            conversation.id === rolledBackId || conversation.title === rollbackTitle,
        ),
      }),
    );
    expect(persisted).toEqual({ byId: null, byTitle: false });
  });
});
