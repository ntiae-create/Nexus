import type {
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
  append(conversationId: Conversation["id"], input: SendMessage): Promise<Message>;
}

export interface ExecutionRepository {
  getById(runId: CoreRun["id"]): Promise<CoreRun | null>;
  create(run: CoreRun): Promise<CoreRun>;
  appendStep(step: RunStep): Promise<RunStep>;
  recordToolEvent(event: ToolEvent): Promise<ToolEvent>;
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

export interface ProviderPreferenceRepository {
  getAll(): Promise<ProviderPreferenceSet>;
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
 * Contract for a future PostgreSQL transaction runner. An implementation must
 * bind RLS settings transaction-locally before constructing these repositories.
 */
export interface NexusDatabase {
  withOwnerTransaction<T>(
    context: OwnerTransactionContext,
    operation: (repositories: NexusRepositories) => Promise<T>,
  ): Promise<T>;
}
