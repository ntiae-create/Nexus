import type {
  AppendAssistantMessage,
  AssistantMemory,
  AssistantReference,
  CoreRun,
  Conversation,
  CreateConversation,
  IncrementalSyncRequest,
  IncrementalSyncResponse,
  MemoryPermission,
  Message,
  ProviderPreferenceSet,
  ProviderSelection,
  RunResult,
  RunStep,
  SendMessage,
  ToolEvent,
  UserAccount,
  UserId,
} from "@nexus/shared";

export type DatabaseActor =
  | { readonly type: "owner" }
  | { readonly type: "assistant"; readonly assistantId: AssistantReference["assistantId"] };

export interface OwnerTransactionContext {
  /** Stable UUID of the sole owner; retained as the shared API identity. */
  readonly ownerId: UserId;
  readonly actor: DatabaseActor;
}

export interface OwnerRepository {
  getCurrent(): Promise<UserAccount | null>;
}

export interface ConversationRepository {
  list(): Promise<readonly Conversation[]>;
  getById(conversationId: Conversation["id"]): Promise<Conversation | null>;
  create(input: CreateConversation): Promise<Conversation>;
  delete(conversationId: Conversation["id"]): Promise<void>;
}

export interface MessageRepository {
  list(conversationId: Conversation["id"], afterSequence?: number): Promise<readonly Message[]>;
  /** Appends a user-authored message. Client-supplied assistant authorship is rejected. */
  append(conversationId: Conversation["id"], input: SendMessage): Promise<Message>;
  /** Appends an assistant-authored message through a trusted backend operation. */
  appendAssistant(
    conversationId: Conversation["id"],
    input: AppendAssistantMessage,
  ): Promise<Message>;
}

export interface CompleteExecution {
  readonly finalMessageId: Message["id"];
  readonly finishedAt?: string;
}

export interface FailExecution {
  readonly finalMessageId?: Message["id"];
  readonly finishedAt?: string;
  readonly metadata?: CoreRun["metadata"];
}

export interface CancelExecution {
  readonly finishedAt?: string;
  readonly metadata?: CoreRun["metadata"];
}

export interface ExecutionRepository {
  getById(runId: CoreRun["id"]): Promise<CoreRun | null>;
  getByIdempotencyKey(idempotencyKey: CoreRun["idempotencyKey"]): Promise<CoreRun | null>;
  listByConversation(conversationId: Conversation["id"]): Promise<readonly CoreRun[]>;
  listChildRuns(parentRunId: CoreRun["id"]): Promise<readonly CoreRun[]>;
  create(run: CoreRun): Promise<CoreRun>;
  /** Updates mutable execution data while preserving its immutable identity. */
  update(run: CoreRun): Promise<CoreRun>;
  complete(runId: CoreRun["id"], completion: CompleteExecution): Promise<CoreRun>;
  fail(runId: CoreRun["id"], failure?: FailExecution): Promise<CoreRun>;
  cancel(runId: CoreRun["id"], cancellation?: CancelExecution): Promise<CoreRun>;
  appendStep(step: RunStep): Promise<RunStep>;
  updateStep(step: RunStep): Promise<RunStep>;
  listSteps(runId: CoreRun["id"]): Promise<readonly RunStep[]>;
  recordToolEvent(event: ToolEvent): Promise<ToolEvent>;
  listToolEvents(runId: CoreRun["id"]): Promise<readonly ToolEvent[]>;
  recordResult(result: RunResult): Promise<RunResult>;
  listResults(runId: CoreRun["id"]): Promise<readonly RunResult[]>;
}

export interface MemoryPermissionAuditEvent {
  readonly id: number;
  readonly ownerId: UserId;
  readonly permissionId: MemoryPermission["id"];
  readonly memoryId: AssistantMemory["id"];
  readonly assistantId: MemoryPermission["assistantId"];
  readonly action: "granted" | "revoked";
  readonly actorOwnerId: UserId;
  readonly occurredAt: string;
}

export interface MemoryRepository {
  listOwned(): Promise<readonly AssistantMemory[]>;
  listForCurrentAssistant(): Promise<readonly AssistantMemory[]>;
  delete(memoryId: AssistantMemory["id"]): Promise<void>;
  grant(memoryId: AssistantMemory["id"], assistantId: MemoryPermission["assistantId"]): Promise<MemoryPermission>;
  revoke(memoryId: AssistantMemory["id"], assistantId: MemoryPermission["assistantId"]): Promise<MemoryPermission>;
  listPermissionAudit(memoryId: AssistantMemory["id"]): Promise<readonly MemoryPermissionAuditEvent[]>;
}

export interface ResolveProviderPreference {
  readonly assistantId: AssistantReference["assistantId"];
  readonly conversationId?: Conversation["id"];
}

export interface ProviderPreferenceRepository {
  getAll(): Promise<ProviderPreferenceSet>;
  resolve(context: ResolveProviderPreference): Promise<ProviderSelection>;
  setGlobal(selection: ProviderSelection): Promise<ProviderPreferenceSet["global"]>;
  setAssistant(
    assistantId: AssistantReference["assistantId"],
    selection: ProviderSelection,
  ): Promise<ProviderPreferenceSet["byAssistant"][number]>;
  setConversation(
    conversationId: Conversation["id"],
    selection: ProviderSelection,
  ): Promise<ProviderPreferenceSet["byConversation"][number]>;
  clearAssistant(assistantId: AssistantReference["assistantId"]): Promise<void>;
  clearConversation(conversationId: Conversation["id"]): Promise<void>;
  /** Explicit full replacement. Prefer scoped setters for concurrent updates. */
  replaceAll(preferences: ProviderPreferenceSet): Promise<ProviderPreferenceSet>;
}

export interface SyncRepository {
  pullIncremental(input: IncrementalSyncRequest): Promise<IncrementalSyncResponse>;
}

export interface NexusRepositories {
  readonly owner: OwnerRepository;
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly executions: ExecutionRepository;
  readonly memories: MemoryRepository;
  readonly providerPreferences: ProviderPreferenceRepository;
  readonly sync: SyncRepository;
}

/**
 * PostgreSQL transaction runner. Implementations bind RLS settings
 * transaction-locally before constructing these repositories.
 */
export interface NexusDatabase {
  withOwnerTransaction<T>(
    context: OwnerTransactionContext,
    operation: (repositories: NexusRepositories) => Promise<T>,
  ): Promise<T>;
}
