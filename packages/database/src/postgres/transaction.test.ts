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
  it("sets context with set_config(..., true) and never exposes client", async () => {
    const client = makeMockClient();
    const pool = makeMockPool(client);
    let receivedRepos: NexusRepositories | null = null;

    const withTx = createWithOwnerTransaction(pool, () => dummyRepos);

    await withTx(
      { ownerId: "00000000-0000-4000-8000-000000000004", actor: { type: "owner" } },
      async (repos) => {
        receivedRepos = repos;
        expect((repos as any).query).toBeUndefined();
        expect((repos as any).client).toBeUndefined();
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
});
