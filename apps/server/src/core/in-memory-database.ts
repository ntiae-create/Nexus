import { isDeepStrictEqual } from "node:util";
import {
  coreRunSchema,
  runStepSchema,
  runResultSchema,
  type Conversation,
  type CoreRun,
  type Message,
  type ProviderPreferenceSet,
  type RunResult,
  type RunStep,
} from "@nexus/shared";
import type {
  ExecutionRepository,
  MessageRepository,
  NexusDatabase,
  NexusRepositories,
  OwnerTransactionContext,
} from "@nexus/database";

export type FaultPoint =
  | "messages.appendAssistant"
  | "executions.recordResult"
  | "executions.updateStep"
  | "executions.update"
  | "executions.create";

export interface FaultPlan {
  readonly point: FaultPoint;
  /** How many calls fail before the fault stops firing. Defaults to 1. */
  readonly times?: number;
}

interface HarnessState {
  conversations: Conversation[];
  messages: Message[];
  runs: CoreRun[];
  steps: RunStep[];
  results: RunResult[];
  preferences: ProviderPreferenceSet;
}

const OWNER_ID = "00000000-0000-4000-8000-000000000004";

function emptyPreferences(): ProviderPreferenceSet {
  return {
    global: {
      id: OWNER_ID,
      userId: OWNER_ID,
      selection: { mode: "automatic" },
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    byAssistant: [],
    byConversation: [],
  };
}

function initialState(): HarnessState {
  return {
    conversations: [],
    messages: [],
    runs: [],
    steps: [],
    results: [],
    preferences: emptyPreferences(),
  };
}

const terminalRuns = new Set<CoreRun["status"]>([
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);

/**
 * In-memory implementation of the `@nexus/database` contracts with the same
 * observable semantics as the PostgreSQL repositories (ownership scoping,
 * idempotency, terminal immutability, transactional rollback).
 *
 * Every external boundary (provider HTTP) is mocked in tests; no network access
 * and no real credentials are involved.
 */
export class InMemoryNexusDatabase implements NexusDatabase {
  private state: HarnessState = initialState();
  private faults: Array<{ point: FaultPoint; remaining: number }> = [];
  /**
   * Serializes transactions the same way PostgreSQL row locks do: concurrent
   * admissions queue behind each other, while provider calls stay outside any
   * transaction and therefore never block.
   */
  private transactionQueue: Promise<unknown> = Promise.resolve();
  readonly transactions: OwnerTransactionContext[] = [];

  injectFault(point: FaultPoint, times = 1): void {
    this.faults.push({ point, remaining: times });
  }

  snapshot(): HarnessState {
    return structuredClone(this.state);
  }

  seedConversation(conversation: Conversation): Conversation {
    const stored = structuredClone(conversation);
    this.state.conversations.push(stored);
    return stored;
  }

  seedMessage(message: Message): Message {
    const stored = structuredClone(message);
    this.state.messages.push(stored);
    return stored;
  }

  private consumeFault(point: FaultPoint): void {
    const entry = this.faults.find((fault) => fault.point === point && fault.remaining > 0);
    if (!entry) return;
    entry.remaining -= 1;
    throw new Error(`Injected persistence fault at ${point}`);
  }

  async withOwnerTransaction<T>(
    context: OwnerTransactionContext,
    operation: (repositories: NexusRepositories) => Promise<T>,
  ): Promise<T> {
    if (!context?.ownerId || !context.actor) {
      throw new Error("Invalid OwnerTransactionContext");
    }
    this.transactions.push(context);

    const run = async (): Promise<T> => {
      const before = structuredClone(this.state);
      try {
        return await operation(this.buildRepositories(context));
      } catch (error) {
        // Mirrors ROLLBACK: no partial persistence survives a failed transaction.
        this.state = before;
        throw error;
      }
    };

    const pending = this.transactionQueue.then(run, run);
    this.transactionQueue = pending.catch(() => undefined);
    return pending;
  }

  private buildRepositories(context: OwnerTransactionContext): NexusRepositories {
    const ownerId = context.ownerId;
    const state = this.state;
    const consumeFault = (point: FaultPoint): void => this.consumeFault(point);

    const requireOwnedConversation = (conversationId: string): Conversation => {
      const conversation = state.conversations.find(
        (item) => item.id === conversationId && item.userId === ownerId,
      );
      if (!conversation || conversation.status === "deleted") {
        throw new Error("Conversation not found or not accessible");
      }
      return conversation;
    };

    const conversations: NexusRepositories["conversations"] = {
      list: async () =>
        structuredClone(
          state.conversations.filter((item) => item.userId === ownerId),
        ),
      getById: async (conversationId) => {
        const conversation = state.conversations.find(
          (item) =>
            item.id === conversationId &&
            item.userId === ownerId &&
            item.status !== "deleted",
        );
        return conversation ? structuredClone(conversation) : null;
      },
      create: async (input) => {
        const now = new Date().toISOString();
        const created: Conversation = {
          id: crypto.randomUUID(),
          userId: ownerId,
          title: input.title ?? null,
          status: "active",
          assistantIds: [...(input.assistantIds ?? [])],
          ...(input.providerPreference ? { providerPreference: input.providerPreference } : {}),
          createdAt: now,
          updatedAt: now,
        };
        state.conversations.push(created);
        return structuredClone(created);
      },
      delete: async (conversationId) => {
        const conversation = requireOwnedConversation(conversationId);
        conversation.status = "deleted";
      },
    };

    const appendMessage = (
      conversationId: string,
      input: {
        content: Message["content"];
        requestId: string;
        idempotencyKey: string;
        metadata?: Message["metadata"];
      },
      author: { role: Message["role"]; assistantId: string | null; runId: string | null },
    ): Message => {
      const conversation = requireOwnedConversation(conversationId);
      const existing = state.messages.find(
        (item) =>
          item.conversationId === conversationId &&
          (item.metadata?.idempotencyKey as string | undefined) === input.idempotencyKey,
      );
      if (existing) {
        const sameOperation =
          existing.role === author.role &&
          (existing.assistantId ?? null) === author.assistantId &&
          (existing.runId ?? null) === author.runId &&
          isDeepStrictEqual(existing.content, input.content);
        if (!sameOperation) {
          throw new Error(
            "Idempotency key conflict: the key belongs to a different message operation",
          );
        }
        return structuredClone(existing);
      }
      if (
        state.messages.some(
          (item) =>
            item.conversationId === conversationId &&
            item.metadata?.requestId === input.requestId,
        )
      ) {
        throw new Error("Duplicate requestId within the conversation");
      }

      const nextSequence =
        state.messages
          .filter((item) => item.conversationId === conversationId)
          .reduce((max, item) => Math.max(max, item.sequence), -1) + 1;

      const message: Message = {
        id: crypto.randomUUID(),
        userId: ownerId,
        conversationId,
        sequence: nextSequence,
        role: author.role,
        ...(author.assistantId ? { assistantId: author.assistantId } : {}),
        ...(author.runId ? { runId: author.runId } : {}),
        status: "complete",
        content: structuredClone(input.content),
        formatVersion: 1,
        createdAt: new Date().toISOString(),
        metadata: {
          ...(input.metadata ?? {}),
          idempotencyKey: input.idempotencyKey,
          requestId: input.requestId,
        },
      };
      state.messages.push(message);
      conversation.updatedAt = message.createdAt;
      return structuredClone(message);
    };

    const messages: MessageRepository = {
      list: async (conversationId, afterSequence) => {
        requireOwnedConversation(conversationId);
        return structuredClone(
          state.messages
            .filter(
              (item) =>
                item.conversationId === conversationId &&
                item.userId === ownerId &&
                (afterSequence === undefined || item.sequence > afterSequence),
            )
            .sort((left, right) => left.sequence - right.sequence),
        );
      },
      append: async (conversationId, input) => {
        if (input.assistantId) {
          throw new Error("User messages cannot claim assistant authorship");
        }
        return appendMessage(conversationId, input, {
          role: "user",
          assistantId: null,
          runId: null,
        });
      },
      appendAssistant: async (conversationId, input) => {
        consumeFault("messages.appendAssistant");
        return appendMessage(conversationId, input, {
          role: "assistant",
          assistantId: input.assistantId,
          runId: input.runId ?? null,
        });
      },
    };

    const findRun = (runId: string): CoreRun | undefined =>
      state.runs.find((item) => item.id === runId && item.userId === ownerId);

    const executions: ExecutionRepository = {
      getById: async (runId) => {
        const run = findRun(runId);
        return run ? structuredClone(run) : null;
      },
      getByIdempotencyKey: async (idempotencyKey) => {
        const run = state.runs.find(
          (item) => item.userId === ownerId && item.idempotencyKey === idempotencyKey,
        );
        return run ? structuredClone(run) : null;
      },
      listByConversation: async (conversationId) => {
        requireOwnedConversation(conversationId);
        return structuredClone(
          state.runs.filter(
            (item) => item.userId === ownerId && item.conversationId === conversationId,
          ),
        );
      },
      listChildRuns: async (parentRunId) =>
        structuredClone(
          state.runs.filter(
            (item) => item.userId === ownerId && item.parentRunId === parentRunId,
          ),
        ),
      create: async (rawRun) => {
        consumeFault("executions.create");
        const run = coreRunSchema.parse(rawRun);
        if (run.userId !== ownerId) {
          throw new Error("Execution owner does not match the authenticated owner");
        }
        requireOwnedConversation(run.conversationId);
        if (state.runs.some((item) => item.id === run.id)) {
          throw new Error("Duplicate execution id");
        }
        if (
          state.runs.some(
            (item) =>
              item.userId === ownerId && item.idempotencyKey === run.idempotencyKey,
          )
        ) {
          throw new Error("Duplicate idempotency key");
        }
        if (state.runs.some((item) => item.userId === ownerId && item.requestId === run.requestId)) {
          throw new Error("Duplicate requestId");
        }
        if (run.parentRunId && run.parentStepId) {
          const parent = findRun(run.parentRunId);
          if (!parent) throw new Error("Parent execution not found");
          if (parent.conversationId !== run.conversationId) {
            throw new Error("Parent execution belongs to another conversation");
          }
          if (!state.steps.some((item) => item.runId === parent.id && item.id === run.parentStepId)) {
            throw new Error("Parent step does not belong to the parent execution");
          }
        }
        const stored = structuredClone(run);
        state.runs.push(stored);
        return structuredClone(stored);
      },
      update: async (rawRun) => {
        consumeFault("executions.update");
        const run = coreRunSchema.parse(rawRun);
        const index = state.runs.findIndex(
          (item) => item.id === run.id && item.userId === ownerId,
        );
        if (index < 0) throw new Error("Execution not found or not accessible");
        const existing = state.runs[index]!;
        const sameIdentity =
          existing.conversationId === run.conversationId &&
          existing.requestId === run.requestId &&
          existing.idempotencyKey === run.idempotencyKey &&
          existing.inputMessageId === run.inputMessageId &&
          existing.parentRunId === run.parentRunId &&
          existing.parentStepId === run.parentStepId &&
          (existing.delegationDepth ?? 0) === (run.delegationDepth ?? 0);
        if (!sameIdentity) throw new Error("Execution identity fields are immutable");
        if (terminalRuns.has(existing.status)) {
          throw new Error(`Terminal executions are immutable (status: ${existing.status})`);
        }
        if (isDeepStrictEqual(existing, run)) return structuredClone(existing);
        const stored = structuredClone(run);
        state.runs[index] = stored;
        return structuredClone(stored);
      },
      complete: async (runId, completion) => {
        const run = findRun(runId);
        if (!run) throw new Error("Execution not found or not accessible");
        if (terminalRuns.has(run.status)) {
          throw new Error(`Terminal executions are immutable (status: ${run.status})`);
        }
        const finishedAt = completion.finishedAt ?? new Date().toISOString();
        return executions.update({
          ...run,
          status: "succeeded",
          finalMessageId: completion.finalMessageId,
          startedAt: run.startedAt ?? finishedAt,
          finishedAt,
        });
      },
      fail: async (runId, failure = {}) => {
        const run = findRun(runId);
        if (!run) throw new Error("Execution not found or not accessible");
        if (terminalRuns.has(run.status)) {
          throw new Error(`Terminal executions are immutable (status: ${run.status})`);
        }
        const finishedAt = failure.finishedAt ?? new Date().toISOString();
        return executions.update({
          ...run,
          status: "failed",
          finalMessageId: failure.finalMessageId,
          startedAt: run.startedAt ?? finishedAt,
          finishedAt,
          ...(failure.metadata
            ? { metadata: { ...(run.metadata ?? {}), ...failure.metadata } }
            : {}),
        });
      },
      cancel: async (runId, cancellation = {}) => {
        const run = findRun(runId);
        if (!run) throw new Error("Execution not found or not accessible");
        if (terminalRuns.has(run.status)) {
          throw new Error(`Terminal executions are immutable (status: ${run.status})`);
        }
        const finishedAt = cancellation.finishedAt ?? new Date().toISOString();
        return executions.update({
          ...run,
          status: "cancelled",
          startedAt: run.startedAt ?? finishedAt,
          finishedAt,
          ...(cancellation.metadata
            ? { metadata: { ...(run.metadata ?? {}), ...cancellation.metadata } }
            : {}),
        });
      },
      appendStep: async (rawStep) => {
        const step = runStepSchema.parse(rawStep);
        const run = findRun(step.runId);
        if (!run) throw new Error("Execution not found or not accessible");
        if (terminalRuns.has(run.status)) {
          throw new Error(`Terminal executions are immutable (status: ${run.status})`);
        }
        const stored = structuredClone(step);
        state.steps.push(stored);
        return structuredClone(stored);
      },
      updateStep: async (rawStep) => {
        consumeFault("executions.updateStep");
        const step = runStepSchema.parse(rawStep);
        const index = state.steps.findIndex((item) => item.id === step.id);
        if (index < 0) throw new Error("Execution step not found in this execution");
        state.steps[index] = structuredClone(step);
        return structuredClone(step);
      },
      listSteps: async (runId) =>
        structuredClone(
          state.steps
            .filter((item) => item.runId === runId && item.userId === ownerId)
            .sort((left, right) => left.order - right.order),
        ),
      recordToolEvent: async () => {
        throw new Error("Tool events are out of scope for Etapa 3B");
      },
      listToolEvents: async () => [],
      recordResult: async (rawResult) => {
        consumeFault("executions.recordResult");
        const result = runResultSchema.parse(rawResult);
        const run = findRun(result.runId);
        if (!run) throw new Error("Execution not found or not accessible");
        if (terminalRuns.has(run.status)) {
          throw new Error(`Terminal executions are immutable (status: ${run.status})`);
        }
        const stepIndex = result.stepId
          ? state.steps.findIndex(
              (item) => item.id === result.stepId && item.runId === result.runId,
            )
          : -1;
        if (result.stepId && stepIndex < 0) {
          throw new Error("Execution step not found in this execution");
        }
        if (stepIndex >= 0 && state.steps[stepIndex]!.resultId) {
          throw new Error("Execution step is already linked to a different result");
        }
        const stored = structuredClone(result);
        state.results.push(stored);
        if (stepIndex >= 0) state.steps[stepIndex]!.resultId = stored.id;
        return structuredClone(stored);
      },
      listResults: async (runId) =>
        structuredClone(state.results.filter((item) => item.runId === runId)),
    };

    const providerPreferences: NexusRepositories["providerPreferences"] = {
      getAll: async () => structuredClone(state.preferences),
      resolve: async (context) => {
        const preferences = state.preferences;
        const conversation = context.conversationId
          ? preferences.byConversation.find(
              (item) => item.conversationId === context.conversationId,
            )
          : undefined;
        if (conversation) return conversation.selection;
        const assistant = preferences.byAssistant.find(
          (item) => item.assistantId === context.assistantId,
        );
        return assistant ? assistant.selection : preferences.global.selection;
      },
      setGlobal: async (selection) => {
        state.preferences.global = {
          ...state.preferences.global,
          selection,
          updatedAt: new Date().toISOString(),
        };
        return state.preferences.global;
      },
      setAssistant: async (assistantId, selection) => {
        const existing = state.preferences.byAssistant.find(
          (item) => item.assistantId === assistantId,
        );
        if (existing) {
          existing.selection = selection;
          existing.updatedAt = new Date().toISOString();
          return existing;
        }
        const created = {
          id: assistantId,
          userId: ownerId,
          assistantId,
          selection,
          updatedAt: new Date().toISOString(),
        };
        state.preferences.byAssistant.push(created);
        return created;
      },
      setConversation: async (conversationId, selection) => {
        const existing = state.preferences.byConversation.find(
          (item) => item.conversationId === conversationId,
        );
        if (existing) {
          existing.selection = selection;
          existing.updatedAt = new Date().toISOString();
          return existing;
        }
        const created = {
          userId: ownerId,
          conversationId,
          selection,
          updatedAt: new Date().toISOString(),
        };
        state.preferences.byConversation.push(created);
        return created;
      },
      clearAssistant: async (assistantId) => {
        state.preferences.byAssistant = state.preferences.byAssistant.filter(
          (item) => item.assistantId !== assistantId,
        );
      },
      clearConversation: async (conversationId) => {
        state.preferences.byConversation = state.preferences.byConversation.filter(
          (item) => item.conversationId !== conversationId,
        );
      },
      replaceAll: async (preferences) => {
        state.preferences = structuredClone(preferences);
        return structuredClone(state.preferences);
      },
    };

    return {
      owner: {
        getCurrent: async () => ({
          userId: ownerId,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      },
      conversations,
      messages,
      executions,
      memories: {} as NexusRepositories["memories"],
      providerPreferences,
      sync: {} as NexusRepositories["sync"],
    };
  }
}
