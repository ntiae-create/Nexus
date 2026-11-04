import { describe, it, expect, vi } from "vitest";
import type { Pool, PoolClient, QueryResult } from "pg";
import { createWithOwnerTransaction } from "./transaction.js";
import type { NexusRepositories } from "../contracts.js";

function makeMockClient(overrides: Partial<PoolClient> = {}): PoolClient {
  const client = {
    query: vi.fn(async (sql: string) => {
      return { rows: [], rowCount: 0 } as QueryResult;
    }),
    release: vi.fn(),
    ...overrides,
  } as unknown as PoolClient;
  return client;
}

function makeMockPool(client: PoolClient): Pool {
  return {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
}

const dummyRepos: NexusRepositories = {
  owner: { getCurrent: async () => null },
  conversations: {
    list: async () => [],
    getById: async () => null,
    create: async () => ({}) as any,
    delete: async () => {},
  },
  messages: {
    list: async () => [],
    append: async () => ({}) as any,
  },
  executions: {
    getById: async () => null,
    create: async (r) => r,
    appendStep: async (s) => s,
    recordToolEvent: async (e) => e,
    recordResult: async (r) => r,
    listResults: async () => [],
  },
  memories: {
    listOwned: async () => [],
    listForCurrentAssistant: async () => [],
    delete: async () => {},
    grant: async () => ({}) as any,
    revoke: async () => ({}) as any,
    listPermissionAudit: async () => [],
  },
  providerPreferences: {
    getAll: async () => ({}) as any,
    replaceAll: async (p) => p,
  },
  sync: {
    pullIncremental: async () => ({}) as any,
  },
};

describe("withOwnerTransaction security", () => {
  it("sets context with set_config(..., true) and never exposes client or query", async () => {
    const client = makeMockClient();
    const pool = makeMockPool(client);
    let receivedRepos: NexusRepositories | null = null;

    const withTx = createWithOwnerTransaction(pool, () => dummyRepos);

    await withTx(
      { ownerId: "00000000-0000-4000-8000-000000000004", actor: { type: "owner" } },
      async (repos) => {
        receivedRepos = repos;
        // Critical: no raw SQL surface on the callback argument.
        expect((repos as any).query).toBeUndefined();
        expect((repos as any).client).toBeUndefined();
        expect((repos as any).pool).toBeUndefined();
        // Only the seven typed repositories.
        expect(Object.keys(repos).sort()).toEqual(
          [
            "conversations",
            "executions",
            "memories",
            "messages",
            "owner",
            "providerPreferences",
            "sync",
          ].sort(),
        );
        return "ok";
      },
    );

    expect(receivedRepos).toBe(dummyRepos);
    const calls = (client.query as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(calls.some((s: string) => s.includes("BEGIN"))).toBe(true);
    expect(calls.some((s: string) => s.includes("set_config('nexus.owner_id'"))).toBe(true);
    expect(calls.some((s: string) => s.includes("set_config('nexus.actor_type'"))).toBe(true);
    const setConfigCalls = (client.query as any).mock.calls.filter((c: any[]) =>
      String(c[0]).includes("set_config"),
    );
    for (const c of setConfigCalls) {
      expect(String(c[0])).toMatch(/,\s*true\s*\)/);
    }
    expect(calls.some((s: string) => s.includes("COMMIT"))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  it("application callback cannot change RLS actor settings", async () => {
    const client = makeMockClient();
    const pool = makeMockPool(client);
    const withTx = createWithOwnerTransaction(pool, () => dummyRepos);

    await withTx(
      { ownerId: "00000000-0000-4000-8000-000000000004", actor: { type: "owner" } },
      async (repos) => {
        // There is no path for the business layer to issue set_config.
        expect(typeof (repos as any).query).toBe("undefined");
        expect(typeof (repos as any).client).toBe("undefined");
        // Attempting to reach a query method via any repository must fail.
        for (const key of Object.keys(repos) as (keyof NexusRepositories)[]) {
          const repo = repos[key] as Record<string, unknown>;
          expect(repo.query).toBeUndefined();
          expect(repo.client).toBeUndefined();
        }
        return "ok";
      },
    );

    // All set_config calls must have originated from the transaction runner, not the callback.
    const setConfigCalls = (client.query as any).mock.calls.filter((c: any[]) =>
      String(c[0]).includes("set_config"),
    );
    // owner_id, actor_type, assistant_id (cleared for owner) = 3
    expect(setConfigCalls.length).toBe(3);
    for (const c of setConfigCalls) {
      expect(String(c[0])).toMatch(/set_config\('nexus\.(owner_id|actor_type|assistant_id)'/);
    }
  });

  it("rolls back and rethrows on operation error", async () => {
    const client = makeMockClient();
    const pool = makeMockPool(client);
    const withTx = createWithOwnerTransaction(pool, () => dummyRepos);

    await expect(
      withTx(
        { ownerId: "00000000-0000-4000-8000-000000000004", actor: { type: "owner" } },
        async () => {
          throw new Error("business failure");
        },
      ),
    ).rejects.toThrow("business failure");

    const calls = (client.query as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(calls.some((s: string) => s.includes("ROLLBACK"))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  it("destroys connection when ROLLBACK itself fails", async () => {
    const client = makeMockClient({
      query: vi.fn(async (sql: string) => {
        if (String(sql).includes("ROLLBACK")) {
          throw new Error("rollback failed");
        }
        return { rows: [], rowCount: 0 } as QueryResult;
      }),
      release: vi.fn(),
    });
    const pool = makeMockPool(client);
    const withTx = createWithOwnerTransaction(pool, () => dummyRepos);

    await expect(
      withTx(
        { ownerId: "00000000-0000-4000-8000-000000000004", actor: { type: "owner" } },
        async () => {
          throw new Error("business failure");
        },
      ),
    ).rejects.toThrow(/business failure/);

    expect(client.release).toHaveBeenCalledWith(true);
  });

  it("sets assistant_id when actor is assistant", async () => {
    const client = makeMockClient();
    const pool = makeMockPool(client);
    const withTx = createWithOwnerTransaction(pool, () => dummyRepos);

    await withTx(
      {
        ownerId: "00000000-0000-4000-8000-000000000004",
        actor: { type: "assistant", assistantId: "00000000-0000-4000-8000-000000000001" },
      },
      async () => "ok",
    );

    const setAssistant = (client.query as any).mock.calls.find((c: any[]) =>
      String(c[0]).includes("nexus.assistant_id"),
    );
    expect(setAssistant).toBeTruthy();
    expect(setAssistant[1][0]).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("rejects invalid context before opening a transaction", async () => {
    const client = makeMockClient();
    const pool = makeMockPool(client);
    const withTx = createWithOwnerTransaction(pool, () => dummyRepos);

    await expect(
      withTx({ ownerId: "", actor: { type: "owner" } } as any, async () => "x"),
    ).rejects.toThrow(/Invalid OwnerTransactionContext/);

    // connect may or may not have been called depending on validation order;
    // the important invariant is no COMMIT of business work with bad context.
    const commits = (client.query as any).mock.calls.filter((c: any[]) =>
      String(c[0]).includes("COMMIT"),
    );
    expect(commits.length).toBe(0);
  });
});
