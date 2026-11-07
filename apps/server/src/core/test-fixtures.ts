import { randomUUID } from "node:crypto";
import type { Conversation, CoreRun, Message } from "@nexus/shared";
import { NexusCoreEngine, type CoreEngineLimits } from "./engine.js";
import { InMemoryNexusDatabase } from "./in-memory-database.js";
import {
  createMockProviderRuntime,
  type MockProviderAdapter,
} from "./mock-provider.js";

export const OWNER_ID = "00000000-0000-4000-8000-000000000004";
export const OTHER_OWNER_ID = "00000000-0000-4000-8000-000000000005";

export const YUI = "00000000-0000-4000-8000-000000000001";
export const ALICE = "00000000-0000-4000-8000-000000000002";
export const SCHWI = "00000000-0000-4000-8000-000000000003";

export const NOW = "2026-11-05T12:00:00.000Z";

export function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: randomUUID(),
    userId: OWNER_ID,
    title: "Conversa de teste",
    status: "active",
    assistantIds: [YUI, ALICE, SCHWI],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export interface HarnessHistoryEntry {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly assistantId?: string;
}

export interface Harness {
  readonly db: InMemoryNexusDatabase;
  readonly adapter: MockProviderAdapter;
  readonly engine: NexusCoreEngine;
  readonly conversationId: string;
  readonly conversation: Conversation;
  calls(): number;
}

export function createHarness(options: {
  adapter: MockProviderAdapter;
  seedConversation?: Conversation;
  history?: readonly HarnessHistoryEntry[];
  limits?: Partial<CoreEngineLimits>;
}): Harness {
  const db = new InMemoryNexusDatabase();
  const seed = options.seedConversation ?? conversation();
  db.seedConversation(seed);

  options.history?.forEach((entry, index) => {
    db.seedMessage({
      id: randomUUID(),
      userId: seed.userId,
      conversationId: seed.id,
      sequence: index,
      role: entry.role,
      ...(entry.role === "assistant" ? { assistantId: entry.assistantId ?? YUI } : {}),
      status: "complete",
      content: [{ type: "text", text: entry.text }],
      formatVersion: 1,
      createdAt: new Date(Date.parse(NOW) + index * 1000).toISOString(),
    } satisfies Message);
  });

  const engine = new NexusCoreEngine({
    database: db,
    providers: createMockProviderRuntime(options.adapter),
    now: () => new Date(NOW),
    ...(options.limits ? { limits: options.limits } : {}),
  });

  return {
    db,
    adapter: options.adapter,
    engine,
    conversationId: seed.id,
    conversation: seed,
    calls: () => options.adapter.calls.length,
  };
}

export function runSummaries(runs: readonly CoreRun[]) {
  return runs.map((run) => ({
    id: run.id,
    status: run.status,
    parentRunId: run.parentRunId ?? null,
    parentStepId: run.parentStepId ?? null,
    delegationDepth: run.delegationDepth ?? 0,
    assistantIds: run.assistantIds,
  }));
}
