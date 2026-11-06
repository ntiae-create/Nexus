import { createHash } from "node:crypto";
import type { AssistantProfile } from "@nexus/assistant-profiles";
import type {
  Conversation,
  CoreContextReport,
  CoreExecutionInspection,
  CoreExecutionModelSummary,
  CoreExecutionRequest,
  CoreExecutionResponse,
  CoreRun,
  CreateConversation,
  DelegationOutcomeRecord,
  DelegationTaskSpec,
  FreeEligibility,
  GenerationMessage,
  GenerationParameters,
  InitialAssistantKey,
  Message,
  ModelGenerationResponse,
  ProviderPreferenceSet,
  RunResult,
  RunStep,
  SendMessage,
  UserId,
} from "@nexus/shared";
import {
  coreContextReportSchema,
  coreExecutionModelSummarySchema,
  coreExecutionRequestSchema,
  createConversationSchema,
  sendMessageSchema,
} from "@nexus/shared";
import type { NexusDatabase, NexusRepositories } from "@nexus/database";
import type { ProviderRuntime, ResolvedModelExecutionTarget } from "../providers/index.js";
import { ProviderError } from "../providers/index.js";
import { redactSecrets } from "../providers/redaction.js";
import { ExecutionCancellationRegistry } from "./cancellation-registry.js";
import { buildExecutionContext, renderMessagePartsToText } from "./context-builder.js";
import {
  buildDelegationUserPrompt,
  buildSynthesisUserPrompt,
  canDelegate,
  extractCoordinatorDecision,
  validateDelegationPlan,
} from "./delegation.js";
import { CoreExecutionError } from "./errors.js";
import {
  deriveChildRunId,
  deriveMessageIdempotencyKey,
  deriveOutcomeUuid,
  deriveRootRunId,
  deriveRunIdempotencyKey,
  deriveStepId,
} from "./ids.js";
import {
  assistantKeyOf,
  buildAssistantSystemInstructions,
  resolveCanonicalAssistantProfile,
  toAssistantReference,
} from "./instructions.js";

export interface CoreLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

export interface CoreEngineLimits {
  readonly maxDelegationDepth: number;
  readonly maxDelegationsPerExecution: number;
  readonly maxTotalDelegations: number;
  readonly providerTimeoutMs: number;
  readonly maxContextWindowCap: number;
  readonly fallbackContextWindow: number;
  readonly defaultReservedOutputBudget: number;
  readonly maxHistoryMessages: number;
  readonly maxSynthesisOutcomeChars: number;
}

export const DEFAULT_CORE_LIMITS: CoreEngineLimits = Object.freeze({
  maxDelegationDepth: 2,
  maxDelegationsPerExecution: 3,
  maxTotalDelegations: 6,
  providerTimeoutMs: 60_000,
  maxContextWindowCap: 65_536,
  fallbackContextWindow: 4_096,
  defaultReservedOutputBudget: 1_024,
  maxHistoryMessages: 40,
  maxSynthesisOutcomeChars: 4_000,
});

export interface NexusCoreEngineOptions {
  readonly database: NexusDatabase;
  readonly providers: ProviderRuntime;
  readonly now?: () => Date;
  readonly registry?: ExecutionCancellationRegistry;
  readonly logger?: CoreLogger;
  readonly limits?: Partial<CoreEngineLimits>;
}

export interface ExecuteCoreInput {
  readonly ownerId: UserId;
  readonly conversationId: string;
  readonly request: CoreExecutionRequest;
  readonly signal?: AbortSignal;
}

interface NewAdmission {
  readonly kind: "new";
  readonly conversation: Conversation;
  readonly inputMessage: Message;
  readonly run: CoreRun;
}

interface ReplayAdmission {
  readonly kind: "replay";
  readonly response: CoreExecutionResponse;
}

interface TerminatedAdmission {
  readonly kind: "terminated";
  readonly run: CoreRun;
}

type Admission = NewAdmission | ReplayAdmission | TerminatedAdmission;

interface DelegationExecutionFailure {
  readonly index: number;
  readonly spec: DelegationTaskSpec;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly childRunId: string;
  readonly assistantKey: InitialAssistantKey;
}

interface DelegationExecutionSuccess {
  readonly outcome: DelegationOutcomeRecord;
  readonly childRun: CoreRun;
}

interface RootStepState {
  readonly step: RunStep;
  readonly target: ResolvedModelExecutionTarget;
  readonly contextReport: CoreContextReport;
}

const MESSAGE_SOURCE = "core";
const FORMAT_VERSION = 1;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function summarize(value: string, maxChars = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized || "Solicitação do usuário";
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function parameterNames(parameters: GenerationParameters | undefined) {
  if (!parameters) return [] as Array<keyof GenerationParameters>;
  return Object.keys(parameters) as Array<keyof GenerationParameters>;
}


const ELIGIBILITY_KEYS = [
  "eligible",
  "costStatus",
  "verifiedAt",
  "requiresPreCallVerification",
  "reason",
] as const;

/**
 * Stores the eligibility proof without price-key names. PostgreSQL forbids JSONB
 * keys matching the credential guard (`...Token`), so `pricingSummary` is rebuilt
 * deterministically on read from the verified `costStatus`.
 */
function persistFreeEligibility(
  eligibility: FreeEligibility,
): Record<string, unknown> {
  return {
    eligible: eligibility.eligible,
    costStatus: eligibility.costStatus,
    verifiedAt: eligibility.verifiedAt,
    requiresPreCallVerification: eligibility.requiresPreCallVerification,
    reason: eligibility.reason,
  };
}

function restoreFreeEligibility(raw: unknown): FreeEligibility {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CoreExecutionError(
      "PERSISTENCE_FAILED",
      "Persisted free-eligibility metadata is missing",
    );
  }
  const record = raw as Record<string, unknown>;
  const hasAllKeys = ELIGIBILITY_KEYS.every((key) => record[key] !== undefined);
  if (!hasAllKeys) {
    throw new CoreExecutionError(
      "PERSISTENCE_FAILED",
      "Persisted free-eligibility metadata is incomplete",
    );
  }
  const costStatus = record.costStatus;
  const zeroPrice = {
    promptPerToken: 0,
    completionPerToken: 0,
    requestFixed: null,
  };
  return {
    eligible: Boolean(record.eligible),
    costStatus: costStatus as FreeEligibility["costStatus"],
    verifiedAt: String(record.verifiedAt),
    requiresPreCallVerification: true,
    reason: record.reason as FreeEligibility["reason"],
    pricingSummary:
      costStatus === "free_confirmed"
        ? zeroPrice
        : { promptPerToken: null, completionPerToken: null, requestFixed: null },
  };
}

/**
 * NEXUS CORE execution engine.
 *
 * Guarantees:
 * - Authentication/ownership is enforced by the caller (HTTP layer) and re-checked
 *   here against persisted rows and PostgreSQL RLS.
 * - No PostgreSQL transaction is ever held open across an external provider call.
 * - Provider/model selection always goes through the Etapa 3A free-only runtime.
 * - Every terminal state is persisted before the client receives a response, and
 *   a failure never produces, persists, or returns a fabricated assistant answer.
 */
export class NexusCoreEngine {
  private readonly database: NexusDatabase;
  private readonly providers: ProviderRuntime;
  private readonly now: () => Date;
  private readonly registry: ExecutionCancellationRegistry;
  private readonly logger?: CoreLogger;
  private readonly limits: CoreEngineLimits;

  constructor(options: NexusCoreEngineOptions) {
    this.database = options.database;
    this.providers = options.providers;
    this.now = options.now ?? (() => new Date());
    this.registry = options.registry ?? new ExecutionCancellationRegistry();
    this.logger = options.logger;
    this.limits = { ...DEFAULT_CORE_LIMITS, ...(options.limits ?? {}) };
  }

  get cancellationRegistry(): ExecutionCancellationRegistry {
    return this.registry;
  }

  private tx<T>(
    ownerId: string,
    operation: (repositories: NexusRepositories) => Promise<T>,
  ): Promise<T> {
    return this.database.withOwnerTransaction(
      { ownerId, actor: { type: "owner" } },
      operation,
    );
  }

  // ---------------------------------------------------------------------------
  // Conversation and message surfaces (owner-scoped, RLS enforced)
  // ---------------------------------------------------------------------------

  async listConversations(ownerId: UserId): Promise<readonly Conversation[]> {
    return this.tx(ownerId, async (repos) => {
      const conversations = await repos.conversations.list();
      return conversations.filter(
        (conversation) => conversation.userId === ownerId && conversation.status !== "deleted",
      );
    });
  }

  async createConversation(
    ownerId: UserId,
    input: CreateConversation,
  ): Promise<Conversation> {
    const parsed = createConversationSchema.parse(input);
    return this.tx(ownerId, async (repos) => {
      const created = await repos.conversations.create(parsed);
      if (created.userId !== ownerId) {
        throw new CoreExecutionError(
          "PERSISTENCE_FAILED",
          "Created conversation does not belong to the authenticated owner",
        );
      }
      return created;
    });
  }

  async getConversation(ownerId: UserId, conversationId: string): Promise<Conversation> {
    return this.tx(ownerId, async (repos) => {
      const conversation = await repos.conversations.getById(conversationId);
      if (!conversation || conversation.userId !== ownerId) {
        throw new CoreExecutionError(
          "CONVERSATION_NOT_FOUND",
          "Conversation not found",
        );
      }
      return conversation;
    });
  }

  async listMessages(
    ownerId: UserId,
    conversationId: string,
    afterSequence?: number,
  ): Promise<readonly Message[]> {
    return this.tx(ownerId, async (repos) => {
      const conversation = await repos.conversations.getById(conversationId);
      if (!conversation || conversation.userId !== ownerId) {
        throw new CoreExecutionError("CONVERSATION_NOT_FOUND", "Conversation not found");
      }
      const messages = await repos.messages.list(conversationId, afterSequence);
      return messages.filter(
        (message) => message.userId === ownerId && message.conversationId === conversationId,
      );
    });
  }

  /**
   * Registers a user message without starting an execution. Used by the
   * conversation message route when `execute` is not requested.
   */
  async appendUserMessage(
    ownerId: UserId,
    conversationId: string,
    input: SendMessage,
  ): Promise<Message> {
    const parsed = sendMessageSchema.parse(input);
    return this.tx(ownerId, async (repos) => {
      const conversation = await repos.conversations.getById(conversationId);
      if (!conversation || conversation.userId !== ownerId) {
        throw new CoreExecutionError("CONVERSATION_NOT_FOUND", "Conversation not found");
      }
      if (conversation.status !== "active") {
        throw new CoreExecutionError(
          "CONVERSATION_INACTIVE",
          "Conversation is not active",
        );
      }
      return repos.messages.append(conversationId, parsed);
    });
  }

  async listExecutions(
    ownerId: UserId,
    conversationId: string,
  ): Promise<readonly CoreRun[]> {
    return this.tx(ownerId, async (repos) => {
      const conversation = await repos.conversations.getById(conversationId);
      if (!conversation || conversation.userId !== ownerId) {
        throw new CoreExecutionError("CONVERSATION_NOT_FOUND", "Conversation not found");
      }
      return repos.executions.listByConversation(conversationId);
    });
  }

  async inspect(ownerId: UserId, runId: string): Promise<CoreExecutionInspection> {
    return this.tx(ownerId, async (repos) => {
      const run = await repos.executions.getById(runId);
      if (!run || run.userId !== ownerId) {
        throw new CoreExecutionError("EXECUTION_NOT_FOUND", "Execution not found");
      }
      const [steps, results, children] = await Promise.all([
        repos.executions.listSteps(run.id),
        repos.executions.listResults(run.id),
        repos.executions.listChildRuns(run.id),
      ]);
      return {
        execution: run,
        steps: [...steps],
        results: [...results],
        childExecutions: [...children],
      };
    });
  }

  async cancel(ownerId: UserId, runId: string): Promise<CoreExecutionInspection> {
    const cancelled = await this.tx(ownerId, async (repos) => {
      const run = await repos.executions.getById(runId);
      if (!run || run.userId !== ownerId) {
        throw new CoreExecutionError("EXECUTION_NOT_FOUND", "Execution not found");
      }
      if (
        run.status === "succeeded" ||
        run.status === "partial" ||
        run.status === "failed" ||
        run.status === "cancelled"
      ) {
        throw new CoreExecutionError(
          "EXECUTION_ALREADY_TERMINAL",
          `Execution already finished with status '${run.status}'`,
          { details: { runId: run.id, status: run.status } },
        );
      }

      const finishedAt = this.now().toISOString();
      const updated = await repos.executions.cancel(run.id, {
        finishedAt,
        metadata: {
          cancelledAt: finishedAt,
          cancellationSource: "api",
        },
      });

      const children = await repos.executions.listChildRuns(run.id);
      for (const child of children) {
        if (
          child.status === "queued" ||
          child.status === "running"
        ) {
          await repos.executions.cancel(child.id, {
            finishedAt,
            metadata: { cancelledAt: finishedAt, cancellationSource: "parent" },
          });
        }
      }
      return updated.status === "cancelled";
    });

    if (cancelled) {
      this.registry.cancel(runId, ownerId);
      this.logger?.info({ runId }, "core execution cancelled");
    }

    return this.inspect(ownerId, runId);
  }

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  async execute(input: ExecuteCoreInput): Promise<CoreExecutionResponse> {
    const ownerId = input.ownerId;
    const conversationId = input.conversationId;
    const request = coreExecutionRequestSchema.parse(input.request);
    const profile = resolveCanonicalAssistantProfile({
      assistantId: request.assistantId,
      assistantKey: request.assistantKey,
    });
    const fingerprint = this.fingerprint(request, profile);

    const admission = await this.admit({
      ownerId,
      conversationId,
      request,
      profile,
      fingerprint,
    });

    if (admission.kind === "replay") {
      return admission.response;
    }

    if (admission.kind === "terminated") {
      throw this.terminalReplayError(admission.run);
    }

    const runId = admission.run.id;
    const startedAt = this.now().toISOString();

    try {
      await this.tx(ownerId, async (repos) => {
        const current = await repos.executions.getById(runId);
        if (!current) {
          throw new CoreExecutionError("EXECUTION_NOT_FOUND", "Execution not found");
        }
        if (current.status === "cancelled") {
          throw new CoreExecutionError(
            "EXECUTION_CANCELLED",
            "Execution was cancelled before it started",
            { statusCode: 409 },
          );
        }
        await repos.executions.update({
          ...current,
          status: "running",
          startedAt,
        });
      });

      return await this.runRootExecution({
        ownerId,
        conversationId,
        request,
        profile,
        runId,
        inputMessageId: admission.inputMessage.id,
        startedAt,
        callerSignal: input.signal,
      });
    } catch (error) {
      await this.handleExecutionFailure({ ownerId, runId, error, profile });
      throw error;
    }
  }

  private fingerprint(
    request: CoreExecutionRequest,
    profile: AssistantProfile,
  ): string {
    return sha256(
      JSON.stringify({
        assistantId: profile.id,
        content: request.content,
        delegations: request.delegations ?? null,
        parameters: request.parameters ?? null,
      }),
    );
  }

  private terminalReplayError(run: CoreRun): CoreExecutionError {
    const metadata = (run.metadata ?? {}) as Record<string, unknown>;
    const failureCode =
      typeof metadata.failureCode === "string" ? metadata.failureCode : undefined;
    if (run.status === "cancelled") {
      return new CoreExecutionError(
        "EXECUTION_CANCELLED",
        "This execution was cancelled; no assistant response was produced",
        {
          details: {
            runId: run.id,
            status: run.status,
            ...(failureCode ? { failureCode } : {}),
          },
        },
      );
    }
    return new CoreExecutionError(
      "EXECUTION_ALREADY_TERMINAL",
      `This idempotent request already finished with status '${run.status}' and produced no successful response`,
      {
        details: {
          runId: run.id,
          status: run.status,
          ...(failureCode ? { failureCode } : {}),
        },
      },
    );
  }

  private async admit(input: {
    ownerId: string;
    conversationId: string;
    request: CoreExecutionRequest;
    profile: AssistantProfile;
    fingerprint: string;
  }): Promise<Admission> {
    const { ownerId, conversationId, request, profile, fingerprint } = input;
    const runIdempotencyKey = deriveRunIdempotencyKey(conversationId, request.idempotencyKey);
    const rootRunId = deriveRootRunId(conversationId, request.idempotencyKey);

    return this.tx(ownerId, async (repos) => {
      const conversation = await repos.conversations.getById(conversationId);
      // RLS already prevents cross-owner reads; this explicit check keeps the
      // domain invariant even if a repository is replaced by a mock.
      if (!conversation || conversation.userId !== ownerId) {
        throw new CoreExecutionError("CONVERSATION_NOT_FOUND", "Conversation not found");
      }
      if (conversation.status !== "active") {
        throw new CoreExecutionError(
          "CONVERSATION_INACTIVE",
          "Conversation is not active",
          { details: { status: conversation.status } },
        );
      }
      if (!conversation.assistantIds.includes(profile.id)) {
        throw new CoreExecutionError(
          "ASSISTANT_NOT_IN_CONVERSATION",
          `Assistant '${profile.name}' does not participate in this conversation`,
          { details: { assistantId: profile.id, conversationId } },
        );
      }

      const existingRun = await repos.executions.getByIdempotencyKey(runIdempotencyKey);
      if (existingRun) {
        if (existingRun.conversationId !== conversationId) {
          throw new CoreExecutionError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key is already used by another conversation",
          );
        }
        const storedFingerprint = existingRun.metadata?.requestFingerprint;
        if (typeof storedFingerprint === "string" && storedFingerprint !== fingerprint) {
          throw new CoreExecutionError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was already used for a different request payload",
            { details: { runId: existingRun.id } },
          );
        }
        if (existingRun.status === "queued" || existingRun.status === "running") {
          throw new CoreExecutionError(
            "EXECUTION_IN_PROGRESS",
            "An execution with this idempotency key is already in progress",
            { details: { runId: existingRun.id, status: existingRun.status } },
          );
        }
        if (existingRun.status === "succeeded" || existingRun.status === "partial") {
          return {
            kind: "replay",
            response: await this.buildResponse(repos, existingRun, true),
          } satisfies ReplayAdmission;
        }
        return { kind: "terminated", run: existingRun } satisfies TerminatedAdmission;
      }

      let inputMessage: Message;
      try {
        inputMessage = await repos.messages.append(conversationId, {
          content: request.content,
          requestId: request.requestId,
          idempotencyKey: this.messageIdempotencyKey(conversationId, request.idempotencyKey),
          metadata: {
            source: MESSAGE_SOURCE,
            assistantKey: profile.key,
            ...(request.metadata ?? {}),
          },
        });
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : "";
        if (/idempotency key conflict/i.test(rawMessage)) {
          throw new CoreExecutionError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was already used for a different message payload",
          );
        }
        // A replayed requestId always means the same client operation; recover the
        // rows it produced instead of surfacing a raw unique-violation.
        if (/messages_conversation_request_id_key|requestId/i.test(rawMessage)) {
          const existingRun = await repos.executions.getByIdempotencyKey(runIdempotencyKey);
          if (!existingRun) {
            throw new CoreExecutionError(
              "IDEMPOTENCY_CONFLICT",
              "requestId was already used by another execution in this conversation",
              { details: { requestId: request.requestId } },
            );
          }
          if (existingRun.status === "queued" || existingRun.status === "running") {
            throw new CoreExecutionError(
              "EXECUTION_IN_PROGRESS",
              "An execution with this idempotency key is already in progress",
              { details: { runId: existingRun.id, status: existingRun.status } },
            );
          }
          if (existingRun.status === "succeeded" || existingRun.status === "partial") {
            return {
              kind: "replay",
              response: await this.buildResponse(repos, existingRun, true),
            } satisfies ReplayAdmission;
          }
          return { kind: "terminated", run: existingRun } satisfies TerminatedAdmission;
        }
        throw error;
      }

      const createdAt = this.now().toISOString();
      const run = await this.createRootRunOrRecover(repos, {
        id: rootRunId,
        userId: ownerId,
        conversationId,
        requestId: request.requestId,
        idempotencyKey: runIdempotencyKey,
        status: "queued",
        assistantIds: [profile.id],
        trace: [toAssistantReference(profile)],
        inputMessageId: inputMessage.id,
        createdAt,
        formatVersion: FORMAT_VERSION,
        metadata: {
          requestFingerprint: fingerprint,
          requestedAssistantKey: profile.key,
          delegationCount: 0,
        },
      });

      return { kind: "new", conversation, inputMessage, run } satisfies NewAdmission;
    });
  }

  /**
   * Handles the race between two concurrent requests that share the same
   * idempotency key: the losing insert is converted into an explicit
   * "already in progress" or replay result instead of a persistence error.
   */
  private async createRootRunOrRecover(
    repos: NexusRepositories,
    run: Parameters<NexusRepositories["executions"]["create"]>[0],
  ): Promise<CoreRun> {
    try {
      return await repos.executions.create(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/duplicate|unique|already exists/i.test(message)) {
        throw error;
      }
      const existing = await repos.executions.getByIdempotencyKey(run.idempotencyKey);
      if (!existing) throw error;
      if (existing.status === "queued" || existing.status === "running") {
        throw new CoreExecutionError(
          "EXECUTION_IN_PROGRESS",
          "An execution with this idempotency key is already in progress",
          { details: { runId: existing.id, status: existing.status } },
        );
      }
      throw this.terminalReplayError(existing);
    }
  }

  private messageIdempotencyKey(conversationId: string, clientKey: string): string {
    return `core:${conversationId}:${clientKey}`.slice(0, 200);
  }

  private async runRootExecution(input: {
    ownerId: string;
    conversationId: string;
    request: CoreExecutionRequest;
    profile: AssistantProfile;
    runId: string;
    inputMessageId: string;
    startedAt: string;
    callerSignal?: AbortSignal;
  }): Promise<CoreExecutionResponse> {
    const { ownerId, conversationId, request, profile, runId } = input;
    const handle = this.registry.register({
      runId,
      ownerId,
      callerSignal: input.callerSignal,
    });

    try {
      const preferences = await this.tx(ownerId, (repos) =>
        repos.providerPreferences.getAll(),
      );

      const requiredParameters = parameterNames(request.parameters).map(
        (name) => name,
      );

      const target = await this.providers.selection.resolveEffectiveSelection(
        preferences as ProviderPreferenceSet,
        {
          assistantId: profile.id,
          conversationId,
          requiredCapabilities: ["chat"],
          requiredParameters,
          signal: handle.signal,
        },
      );

      const persistedMessages = await this.tx(ownerId, (repos) =>
        repos.messages.list(conversationId),
      );
      const inputMessage = persistedMessages.find(
        (message) => message.id === input.inputMessageId,
      );
      if (!inputMessage) {
        throw new CoreExecutionError(
          "PERSISTENCE_FAILED",
          "Persisted input message could not be recovered for execution",
        );
      }
      const currentUserContent = renderMessagePartsToText(inputMessage.content);

      const profileKey = assistantKeyOf(profile);
      const coordinator = canDelegate(profileKey);
      const instructions = buildAssistantSystemInstructions(profile, {
        mode: coordinator ? "coordinator_planning" : "direct",
        ...(coordinator
          ? { canDelegateTo: ["alice", "schwi"] as const }
          : {}),
      });

      const context = buildExecutionContext({
        ownerId,
        conversationId,
        systemInstructions: instructions,
        persistedHistory: persistedMessages,
        currentInputMessageId: inputMessage.id,
        currentUserContent,
        modelContextWindow: target.model.contextWindow,
        ...(request.parameters?.maxOutputTokens !== undefined
          ? { requestedMaxOutputTokens: request.parameters.maxOutputTokens }
          : {}),
        policy: {
          fallbackContextWindow: this.limits.fallbackContextWindow,
          maxContextWindowCap: this.limits.maxContextWindowCap,
          defaultReservedOutputBudget: this.limits.defaultReservedOutputBudget,
          maxHistoryMessages: this.limits.maxHistoryMessages,
        },
      });

      const planStep = await this.tx(ownerId, async (repos) => {
        const current = await repos.executions.getById(runId);
        if (!current) {
          throw new CoreExecutionError("EXECUTION_NOT_FOUND", "Execution not found");
        }
        if (current.status === "cancelled") {
          throw new CoreExecutionError(
            "EXECUTION_CANCELLED",
            "Execution was cancelled before the provider call",
            { statusCode: 409 },
          );
        }
        await repos.executions.update({
          ...current,
          metadata: {
            ...(current.metadata ?? {}),
            ...this.modelMetadata(target),
            contextReport: this.contextMetadata(context.report),
            requestedAssistantKey: profile.key,
            delegationCount: 0,
          },
        });
        return repos.executions.appendStep({
          id: deriveStepId(runId, 0, "primary"),
          userId: ownerId,
          runId,
          order: 0,
          assistant: toAssistantReference(profile),
          status: "running",
          objective: summarize(currentUserContent),
          inputReferenceIds: [],
          startedAt: this.now().toISOString(),
          metadata: {
            phase: coordinator ? "coordination_plan" : "response",
            providerKey: target.adapter.key,
            modelKey: target.model.key,
            delegationDepth: 0,
          },
        });
      });

      // Structured plans (client-supplied or declared by the assistant) are fully
      // validated before any provider call, so invalid delegation never costs a
      // model invocation and never reaches an external boundary.
      if (request.delegations && request.delegations.length > 0) {
        validateDelegationPlan({
          specs: request.delegations,
          chainKeys: [profileKey],
          baseDepth: 0,
          limits: this.limits,
        });
      }

      const primary = await this.callProvider({
        ownerId,
        runId,
        target,
        messages: context.messages,
        parameters: request.parameters,
        timeoutMs: request.timeoutMs,
        signal: handle.signal,
      });

      const primaryText = this.requireModelText(primary);

      let decision: ReturnType<typeof extractCoordinatorDecision> = {
        kind: "direct",
        text: primaryText,
      };
      if (coordinator && request.delegations && request.delegations.length > 0) {
        decision = { kind: "delegate", delegations: request.delegations };
      } else if (coordinator) {
        decision = extractCoordinatorDecision(primaryText);
      }

      if (decision.kind === "direct") {
        return await this.completeRootExecution({
          ownerId,
          conversationId,
          profile,
          runId,
          step: planStep,
          status: "succeeded",
          responseText: decision.text,
          contextReport: context.report,
          target,
          extraMetadata: { delegationCount: 0 },
        });
      }

      return await this.executeDelegationPlan({
        ownerId,
        conversationId,
        request,
        profile,
        preferences: preferences as ProviderPreferenceSet,
        runId,
        planStep,
        contextReport: context.report,
        currentUserContent,
        plan: decision.delegations,
        primaryTarget: target,
        handle,
      });
    } finally {
      handle.release();
    }
  }

  private modelMetadata(target: ResolvedModelExecutionTarget): Record<string, unknown> {
    return {
      resolvedScope: target.resolvedScope,
      providerId: target.adapter.id,
      providerKey: target.adapter.key,
      providerName: target.adapter.name,
      modelId: target.model.id,
      modelKey: target.model.key,
      modelName: target.model.name,
      contextWindow: target.model.contextWindow,
      // Persist the eligibility proof. Price keys are intentionally excluded:
      // PostgreSQL rejects JSONB keys matching /token/ (credential guard), and the
      // zero-price summary is reconstructed deterministically from `costStatus`.
      freeEligibility: persistFreeEligibility(target.model.freeEligibility),
      paidFallbackUsed: false,
    };
  }

  private contextMetadata(report: CoreContextReport): Record<string, number | boolean> {
    return {
      effectiveContextWindow: report.effectiveContextWindow,
      usedFallbackWindow: report.usedFallbackWindow,
      reservedOutputBudget: report.reservedOutputBudget,
      availableInputBudget: report.availableInputBudget,
      estimatedInputUnits: report.estimatedInputUnits,
      includedHistoryCount: report.includedHistoryCount,
      omittedHistoryCount: report.omittedHistoryCount,
    };
  }

  private async executeDelegationPlan(input: {
    ownerId: string;
    conversationId: string;
    request: CoreExecutionRequest;
    profile: AssistantProfile;
    preferences: ProviderPreferenceSet;
    runId: string;
    planStep: RunStep;
    contextReport: CoreContextReport;
    currentUserContent: string;
    plan: readonly DelegationTaskSpec[];
    primaryTarget: ResolvedModelExecutionTarget;
    handle: { readonly signal: AbortSignal };
  }): Promise<CoreExecutionResponse> {
    const {
      ownerId,
      conversationId,
      request,
      profile,
      preferences,
      runId,
      planStep,
      contextReport,
      currentUserContent,
      plan,
      primaryTarget,
      handle,
    } = input;

    // Validation happens before any child execution or provider call is created.
    validateDelegationPlan({
      specs: plan,
      chainKeys: [assistantKeyOf(profile)],
      baseDepth: 0,
      limits: this.limits,
    });

    const conversation = await this.tx(ownerId, async (repos) =>
      repos.conversations.getById(conversationId),
    );
    if (!conversation) {
      throw new CoreExecutionError("CONVERSATION_NOT_FOUND", "Conversation not found");
    }

    const targets = plan.map((spec) => {
      const targetProfile = this.profileForDelegation(spec.targetAssistant);
      if (!conversation.assistantIds.includes(targetProfile.id)) {
        throw new CoreExecutionError(
          "ASSISTANT_NOT_IN_CONVERSATION",
          `Delegated assistant '${targetProfile.name}' does not participate in this conversation`,
          {
            details: {
              assistantId: targetProfile.id,
              conversationId,
            },
          },
        );
      }
      return targetProfile;
    });

    const planFinishedAt = this.now().toISOString();
    const steps = await this.tx(ownerId, async (repos) => {
      const current = await repos.executions.getById(runId);
      if (!current) {
        throw new CoreExecutionError("EXECUTION_NOT_FOUND", "Execution not found");
      }
      if (current.status === "cancelled") {
        throw new CoreExecutionError(
          "EXECUTION_CANCELLED",
          "Execution was cancelled before delegations started",
          { statusCode: 409 },
        );
      }

      const created: RunStep[] = [];
      for (const [index, spec] of plan.entries()) {
        const targetProfile = targets[index]!;
        created.push(
          await repos.executions.appendStep({
            id: deriveStepId(runId, index + 1, "delegation"),
            userId: ownerId,
            runId,
            order: index + 1,
            assistant: toAssistantReference(targetProfile),
            status: "running",
            objective: summarize(spec.objective, 240),
            inputReferenceIds: [...(spec.inputReferenceIds ?? [])],
            startedAt: this.now().toISOString(),
            metadata: {
              phase: "delegation",
              delegationIndex: index,
              targetAssistantKey: targetProfile.key,
              delegationDepth: 1,
            },
          }),
        );
      }

      await repos.executions.update({
        ...current,
        assistantIds: [profile.id, ...targets.map((target) => target.id)],
        trace: [toAssistantReference(profile), ...targets.map(toAssistantReference)],
        metadata: {
          ...(current.metadata ?? {}),
          delegationCount: plan.length,
          delegationTargets: [...targets.map((target) => target.key)],
        },
      });

      await repos.executions.updateStep({
        ...planStep,
        status: "succeeded",
        finishedAt: planFinishedAt,
        metadata: {
          ...(planStep.metadata ?? {}),
          phase: "coordination_plan",
          decision: "delegate",
          delegationCount: plan.length,
        },
      });

      return created;
    });

    const successes: DelegationExecutionSuccess[] = [];
    const failures: DelegationExecutionFailure[] = [];

    for (const [index, spec] of plan.entries()) {
      const targetProfile = targets[index]!;
      const step = steps[index]!;

      try {
        const executed = await this.executeDelegatedChild({
          ownerId,
          conversationId,
          request,
          parentRunId: runId,
          parentStepId: step.id,
          sourceProfile: profile,
          targetProfile,
          spec,
          index,
          userRequest: currentUserContent,
          preferences,
          parentSignal: handle.signal,
        });
        successes.push(executed);
      } catch (error) {
        if (error instanceof CoreExecutionError && error.code === "EXECUTION_CANCELLED") {
          throw error;
        }
        const mapped = this.describeFailure(error);
        failures.push({
          index,
          spec,
          errorCode: mapped.code,
          errorMessage: mapped.message,
          childRunId: deriveChildRunId(runId, index, targetProfile.key),
          assistantKey: assistantKeyOf(targetProfile),
        });

        const childRunId = deriveChildRunId(runId, index, targetProfile.key);
        await this.markFailed({
          ownerId,
          runId: childRunId,
          code: mapped.code,
          message: mapped.message,
        });
        await this.tx(ownerId, async (repos) => {
          const currentStep = (await repos.executions.listSteps(runId)).find(
            (item) => item.id === step.id,
          );
          if (!currentStep || currentStep.status !== "running") return;
          await repos.executions.updateStep({
            ...currentStep,
            status: "failed",
            finishedAt: this.now().toISOString(),
            metadata: {
              ...(currentStep.metadata ?? {}),
              failureCode: mapped.code,
            },
          });
        });
      }
    }

    if (successes.length === 0) {
      const firstFailure = failures[0]!;
      const failureSummary = failures
        .map((failure) => `${failure.assistantKey}: ${failure.errorCode}`)
        .join("; ");
      throw new CoreExecutionError(
        "DELEGATED_EXECUTION_FAILED",
        `All delegated executions failed (${failureSummary}); no final answer was produced`,
        {
          details: {
            failures: failures.map((failure) => ({
              assistantKey: failure.assistantKey,
              errorCode: failure.errorCode,
              childRunId: failure.childRunId,
            })),
            primaryFailure: firstFailure.errorCode,
          },
        },
      );
    }

    // Synthesis: the coordinator receives the structured delegated outputs and
    // formulates the final answer under its own identity.
    const synthesisStep = await this.tx(ownerId, async (repos) => {
      const current = await repos.executions.getById(runId);
      if (!current) {
        throw new CoreExecutionError("EXECUTION_NOT_FOUND", "Execution not found");
      }
      if (current.status === "cancelled") {
        throw new CoreExecutionError(
          "EXECUTION_CANCELLED",
          "Execution was cancelled before synthesis",
          { statusCode: 409 },
        );
      }
      return repos.executions.appendStep({
        id: deriveStepId(runId, plan.length + 1, "synthesis"),
        userId: ownerId,
        runId,
        order: plan.length + 1,
        assistant: toAssistantReference(profile),
        status: "running",
        objective: "Síntese final da coordenação",
        inputReferenceIds: [],
        startedAt: this.now().toISOString(),
        metadata: {
          phase: "synthesis",
          providerKey: primaryTarget.adapter.key,
          modelKey: primaryTarget.model.key,
          delegatedSuccessCount: successes.length,
          delegatedFailureCount: failures.length,
        },
      });
    });

    const synthesisInstructions = buildAssistantSystemInstructions(profile, {
      mode: "coordinator_synthesis",
    });
    const synthesisPrompt = buildSynthesisUserPrompt({
      coordinatorProfile: profile,
      userRequest: currentUserContent,
      maxCharsPerOutcome: this.limits.maxSynthesisOutcomeChars,
      outcomes: [
        ...successes.map((success) => ({
          assistantName: this.profileForDelegation(success.outcome.assistant.assistantKey as InitialAssistantKey).name,
          assistantKey: success.outcome.assistant.assistantKey,
          objective: success.outcome.objective,
          status: "succeeded" as const,
          outputText: success.outcome.outputText,
        })),
        ...failures.map((failure) => ({
          assistantName: this.profileForDelegation(failure.assistantKey).name,
          assistantKey: failure.assistantKey,
          objective: failure.spec.objective,
          status: "failed" as const,
          failureMessage: `${failure.errorCode}: ${failure.errorMessage}`,
        })),
      ],
    });

    const synthesisContext = buildExecutionContext({
      ownerId,
      conversationId,
      systemInstructions: synthesisInstructions,
      persistedHistory: [],
      currentInputMessageId: deriveOutcomeUuid(runId, "synthesis-input"),
      currentUserContent: synthesisPrompt,
      modelContextWindow: primaryTarget.model.contextWindow,
      ...(request.parameters?.maxOutputTokens !== undefined
        ? { requestedMaxOutputTokens: request.parameters.maxOutputTokens }
        : {}),
      policy: {
        fallbackContextWindow: this.limits.fallbackContextWindow,
        maxContextWindowCap: this.limits.maxContextWindowCap,
        defaultReservedOutputBudget: this.limits.defaultReservedOutputBudget,
        maxHistoryMessages: this.limits.maxHistoryMessages,
      },
    });

    const synthesisResponse = await this.callProvider({
      ownerId,
      runId,
      target: primaryTarget,
      messages: synthesisContext.messages,
      parameters: request.parameters,
      timeoutMs: request.timeoutMs,
      signal: handle.signal,
    });

    const finalText = this.requireModelText(synthesisResponse);

    return await this.completeRootExecution({
      ownerId,
      conversationId,
      profile,
      runId,
      step: synthesisStep,
      status: failures.length > 0 ? "partial" : "succeeded",
      responseText: finalText,
      contextReport,
      target: primaryTarget,
      extraMetadata: {
        delegationCount: plan.length,
        delegatedSuccessCount: successes.length,
        delegatedFailureCount: failures.length,
        delegationFailureCodes: failures.map((failure) => failure.errorCode),
      },
      assistantIds: [profile.id, ...targets.map((target) => target.id)],
      trace: [toAssistantReference(profile), ...targets.map(toAssistantReference), toAssistantReference(profile)],
      delegations: successes.map((success) => success.outcome),
      childRunIds: successes.map((success) => success.childRun.id),
    });
  }

  private profileForDelegation(key: InitialAssistantKey): AssistantProfile {
    return resolveCanonicalAssistantProfile({ assistantKey: key });
  }

  private async executeDelegatedChild(input: {
    ownerId: string;
    conversationId: string;
    request: CoreExecutionRequest;
    parentRunId: string;
    parentStepId: string;
    sourceProfile: AssistantProfile;
    targetProfile: AssistantProfile;
    spec: DelegationTaskSpec;
    index: number;
    userRequest: string;
    preferences: ProviderPreferenceSet;
    parentSignal: AbortSignal;
  }): Promise<DelegationExecutionSuccess> {
    const {
      ownerId,
      conversationId,
      request,
      parentRunId,
      parentStepId,
      sourceProfile,
      targetProfile,
      spec,
      index,
      userRequest,
      preferences,
      parentSignal,
    } = input;

    if (parentSignal.aborted) {
      throw new CoreExecutionError(
        "EXECUTION_CANCELLED",
        "Delegated execution was cancelled before it started",
        { statusCode: 409 },
      );
    }

    const targetKey = assistantKeyOf(targetProfile);
    const childRunId = deriveChildRunId(parentRunId, index, targetKey);
    const childStepId = deriveStepId(childRunId, 0, "delegation");
    const childDepth = 1;

    const target = await this.providers.selection.resolveEffectiveSelection(preferences, {
      assistantId: targetProfile.id,
      conversationId,
      requiredCapabilities: ["chat"],
      requiredParameters: parameterNames(request.parameters),
      signal: parentSignal,
    });

    const instructions = buildAssistantSystemInstructions(targetProfile, {
      mode: "delegated_specialist",
    });
    const delegationPrompt = buildDelegationUserPrompt({
      sourceProfile,
      targetProfile,
      spec,
      userRequest,
      maxChars: this.limits.maxSynthesisOutcomeChars,
    });

    const context = buildExecutionContext({
      ownerId,
      conversationId,
      systemInstructions: instructions,
      persistedHistory: [],
      currentInputMessageId: deriveOutcomeUuid(childRunId, "delegation-input"),
      currentUserContent: delegationPrompt,
      modelContextWindow: target.model.contextWindow,
      ...(request.parameters?.maxOutputTokens !== undefined
        ? { requestedMaxOutputTokens: request.parameters.maxOutputTokens }
        : {}),
      policy: {
        fallbackContextWindow: this.limits.fallbackContextWindow,
        maxContextWindowCap: this.limits.maxContextWindowCap,
        defaultReservedOutputBudget: this.limits.defaultReservedOutputBudget,
        maxHistoryMessages: this.limits.maxHistoryMessages,
      },
    });

    const existing = await this.tx(ownerId, async (repos) => {
      const child = await repos.executions.getById(childRunId);
      if (!child) return null;
      return this.replayChildOutcome(repos, child);
    });
    if (existing) {
      return existing;
    }

    await this.tx(ownerId, async (repos) => {
      const startedAt = this.now().toISOString();
      await repos.executions.create({
        id: childRunId,
        userId: ownerId,
        conversationId,
        requestId: deriveOutcomeUuid(childRunId, "request"),
        idempotencyKey: `core:child:${childRunId}`,
        status: "running",
        assistantIds: [targetProfile.id],
        trace: [toAssistantReference(targetProfile)],
        inputMessageId: await this.resolveInputMessageId(repos, parentRunId),
        parentRunId,
        parentStepId,
        delegationDepth: childDepth,
        createdAt: startedAt,
        startedAt,
        formatVersion: FORMAT_VERSION,
        metadata: {
          ...this.modelMetadata(target),
          contextReport: this.contextMetadata(context.report),
          delegation: {
            parentRunId,
            parentStepId,
            sourceAssistantKey: sourceProfile.key,
            targetAssistantKey: targetProfile.key,
            objective: summarize(spec.objective, 240),
            index,
          },
          delegationDepth: childDepth,
        },
      });

      await repos.executions.appendStep({
        id: childStepId,
        userId: ownerId,
        runId: childRunId,
        order: 0,
        assistant: toAssistantReference(targetProfile),
        status: "running",
        objective: summarize(spec.objective, 240),
        inputReferenceIds: [...(spec.inputReferenceIds ?? [])],
        startedAt: this.now().toISOString(),
        metadata: {
          phase: "delegated_response",
          providerKey: target.adapter.key,
          modelKey: target.model.key,
          delegationDepth: childDepth,
        },
      });
    });

    const handle = this.registry.register({
      runId: childRunId,
      ownerId,
      parentRunId,
      callerSignal: parentSignal,
    });

    try {
      const response = await this.callProvider({
        ownerId,
        runId: childRunId,
        target,
        messages: context.messages,
        parameters: request.parameters,
        timeoutMs: request.timeoutMs,
        signal: handle.signal,
      });
      const text = this.requireModelText(response);

      const finishedAt = this.now().toISOString();
      const outcome = await this.tx(ownerId, async (repos) => {
        const child = await repos.executions.getById(childRunId);
        if (!child) {
          throw new CoreExecutionError("EXECUTION_NOT_FOUND", "Child execution not found");
        }
        if (child.status === "cancelled") {
          throw new CoreExecutionError(
            "EXECUTION_CANCELLED",
            "Delegated execution was cancelled",
            { statusCode: 409 },
          );
        }
        const steps = await repos.executions.listSteps(childRunId);
        const step = steps.find((item) => item.id === childStepId);
        if (!step) {
          throw new CoreExecutionError(
            "PERSISTENCE_FAILED",
            "Delegated execution step is missing",
          );
        }
        const usageUnits = this.usageMetadata(response);
        const result = await repos.executions.recordResult({
          id: deriveOutcomeUuid(childRunId, "result"),
          userId: ownerId,
          runId: childRunId,
          stepId: childStepId,
          status: "succeeded",
          content: [{ type: "text", data: { text } }],
          references: [],
          formatVersion: FORMAT_VERSION,
          createdAt: finishedAt,
          metadata: {
            providerKey: target.adapter.key,
            modelKey: target.model.key,
          },
        });
        const updatedStep = await repos.executions.updateStep({
          ...step,
          status: "succeeded",
          finishedAt,
        });
        const updatedChild = await repos.executions.update({
          ...child,
          status: "succeeded",
          finishedAt,
          metadata: {
            ...(child.metadata ?? {}),
            ...(usageUnits ? { usageUnits } : {}),
            finishReason: response.finishReason,
            targetAssistantKey: targetKey,
          },
        });

        const record: DelegationOutcomeRecord = {
          childRunId,
          parentRunId,
          parentStepId,
          childStepId: updatedStep.id,
          childResultId: result.id,
          assistant: toAssistantReference(targetProfile),
          objective: spec.objective,
          status: "succeeded",
          outputText: text,
          providerKey: target.adapter.key,
          modelKey: target.model.key,
          delegationDepth: childDepth,
        };
        return { outcome: record, childRun: updatedChild };
      });

      return outcome;
    } finally {
      handle.release();
    }
  }

  private async resolveInputMessageId(
    repos: NexusRepositories,
    parentRunId: string,
  ): Promise<string> {
    const parent = await repos.executions.getById(parentRunId);
    if (!parent) {
      throw new CoreExecutionError("EXECUTION_NOT_FOUND", "Parent execution not found");
    }
    return parent.inputMessageId;
  }

  private async replayChildOutcome(
    repos: NexusRepositories,
    child: CoreRun,
  ): Promise<DelegationExecutionSuccess | null> {
    if (child.status !== "succeeded") return null;
    const [steps, results] = await Promise.all([
      repos.executions.listSteps(child.id),
      repos.executions.listResults(child.id),
    ]);
    const step = steps[0];
    const result = step?.resultId
      ? results.find((item) => item.id === step.resultId)
      : results[0];
    if (!step || !result) return null;
    const outputText = result.content
      .filter((part) => part.type === "text")
      .map((part) => {
        const text = part.data.text;
        return typeof text === "string" ? text : "";
      })
      .join("\n")
      .trim();
    if (!outputText) return null;

    const metadata = (child.metadata ?? {}) as Record<string, unknown>;
    const delegation = (metadata.delegation ?? {}) as Record<string, unknown>;
    const providerKey = typeof metadata.providerKey === "string" ? metadata.providerKey : "openrouter";
    const modelKey = typeof metadata.modelKey === "string" ? metadata.modelKey : "unknown";
    if (!step.assistant || !child.parentRunId || !child.parentStepId) return null;

    return {
      outcome: {
        childRunId: child.id,
        parentRunId: child.parentRunId,
        parentStepId: child.parentStepId,
        childStepId: step.id,
        childResultId: result.id,
        assistant: step.assistant,
        objective:
          typeof delegation.objective === "string"
            ? delegation.objective
            : step.objective,
        status: "succeeded",
        outputText,
        providerKey,
        modelKey,
        delegationDepth: child.delegationDepth ?? 1,
      },
      childRun: child,
    };
  }

  private usageMetadata(response: ModelGenerationResponse): Record<string, number> | undefined {
    if (!response.usage) return undefined;
    return {
      inputUnits: response.usage.inputTokens,
      outputUnits: response.usage.outputTokens,
      totalUnits: response.usage.totalTokens,
    };
  }

  private requireModelText(response: ModelGenerationResponse): string {
    const text = response.content.trim();
    if (!text) {
      throw new CoreExecutionError(
        "EMPTY_MODEL_RESPONSE",
        "Provider returned an empty completion; no assistant response can be produced",
        {
          details: {
            providerKey: response.providerKey,
            modelKey: response.modelKey,
            finishReason: response.finishReason,
          },
        },
      );
    }
    return text;
  }

  private async completeRootExecution(input: {
    ownerId: string;
    conversationId: string;
    profile: AssistantProfile;
    runId: string;
    step: RunStep;
    status: "succeeded" | "partial";
    responseText: string;
    contextReport: CoreContextReport;
    target: ResolvedModelExecutionTarget;
    extraMetadata?: Record<string, unknown>;
    assistantIds?: string[];
    trace?: ReturnType<typeof toAssistantReference>[];
    delegations?: readonly DelegationOutcomeRecord[];
    childRunIds?: string[];
  }): Promise<CoreExecutionResponse> {
    const { ownerId, conversationId, profile, runId, step, status, responseText } = input;
    const finishedAt = this.now().toISOString();

    try {
      const persisted = await this.tx(ownerId, async (repos) => {
        const current = await repos.executions.getById(runId);
        if (!current) {
          throw new CoreExecutionError("EXECUTION_NOT_FOUND", "Execution not found");
        }
        if (current.status === "cancelled") {
          throw new CoreExecutionError(
            "EXECUTION_CANCELLED",
            "Execution was cancelled before the response could be persisted",
            { statusCode: 409 },
          );
        }
        if (current.status !== "running" && current.status !== "queued") {
          throw new CoreExecutionError(
            "EXECUTION_ALREADY_TERMINAL",
            `Execution is already terminal with status '${current.status}'`,
          );
        }

        const assistantMessage = await repos.messages.appendAssistant(conversationId, {
          content: [{ type: "text", text: responseText }],
          requestId: deriveOutcomeUuid(runId, "assistant-message"),
          idempotencyKey: deriveMessageIdempotencyKey(runId, "out"),
          assistantId: profile.id,
          runId,
          metadata: {
            source: MESSAGE_SOURCE,
            assistantKey: profile.key,
            runStatus: status,
            ...(input.extraMetadata ?? {}),
          },
        });

        const result = await repos.executions.recordResult({
          id: deriveOutcomeUuid(runId, "result"),
          userId: ownerId,
          runId,
          stepId: step.id,
          status,
          content: [{ type: "text", data: { text: responseText } }],
          references: [],
          formatVersion: FORMAT_VERSION,
          createdAt: finishedAt,
          metadata: {
            providerKey: input.target.adapter.key,
            modelKey: input.target.model.key,
            phase: step.metadata?.phase ?? "response",
          },
        });

        const currentStep = (await repos.executions.listSteps(runId)).find(
          (item) => item.id === step.id,
        );
        if (!currentStep) {
          throw new CoreExecutionError(
            "PERSISTENCE_FAILED",
            "Execution step is missing while finalizing",
          );
        }
        await repos.executions.updateStep({
          ...currentStep,
          status: "succeeded",
          resultId: result.id,
          finishedAt,
        });

        const updated = await repos.executions.update({
          ...current,
          status,
          finalMessageId: assistantMessage.id,
          finishedAt,
          ...(input.assistantIds ? { assistantIds: input.assistantIds } : {}),
          ...(input.trace ? { trace: input.trace } : {}),
          metadata: {
            ...(current.metadata ?? {}),
            ...(input.extraMetadata ?? {}),
            resolvedScope: input.target.resolvedScope,
            providerKey: input.target.adapter.key,
            modelKey: input.target.model.key,
            providerId: input.target.adapter.id,
            providerName: input.target.adapter.name,
            modelId: input.target.model.id,
            modelName: input.target.model.name,
            contextWindow: input.target.model.contextWindow,
            contextReport: this.contextMetadata(input.contextReport),
            finalMessageId: assistantMessage.id,
          },
        });

        const steps = await repos.executions.listSteps(runId);
        const results = await repos.executions.listResults(runId);
        const children = await repos.executions.listChildRuns(runId);
        return { run: updated, assistantMessage, steps, results, children };
      });

      return {
        execution: persisted.run,
        inputMessage: await this.requireInputMessage(ownerId, runId),
        assistantMessage: persisted.assistantMessage,
        steps: [...persisted.steps],
        results: [...persisted.results],
        delegations: [...(input.delegations ?? [])],
        childExecutions: [...persisted.children],
        modelSelection: this.modelSummary(input.target),
        contextReport: input.contextReport,
        replayed: false,
      };
    } catch (error) {
      if (error instanceof CoreExecutionError) throw error;
      throw new CoreExecutionError(
        "PERSISTENCE_FAILED",
        "Failed to persist the final execution state atomically",
        { retryable: true, cause: error },
      );
    }
  }

  private async requireInputMessage(ownerId: string, runId: string): Promise<Message> {
    return this.tx(ownerId, async (repos) => {
      const run = await repos.executions.getById(runId);
      if (!run) {
        throw new CoreExecutionError("EXECUTION_NOT_FOUND", "Execution not found");
      }
      const messages = await repos.messages.list(run.conversationId);
      const input = messages.find((message) => message.id === run.inputMessageId);
      if (!input) {
        throw new CoreExecutionError(
          "PERSISTENCE_FAILED",
          "Input message for this execution could not be recovered",
        );
      }
      return input;
    });
  }

  private modelSummary(target: ResolvedModelExecutionTarget): CoreExecutionModelSummary {
    return {
      resolvedScope: target.resolvedScope,
      providerId: target.adapter.id,
      providerKey: target.adapter.key,
      providerName: target.adapter.name,
      modelId: target.model.id,
      modelKey: target.model.key,
      modelName: target.model.name,
      contextWindow: target.model.contextWindow,
      freeEligibility: target.model.freeEligibility,
    };
  }

  private async callProvider(input: {
    ownerId: string;
    runId: string;
    target: ResolvedModelExecutionTarget;
    messages: readonly GenerationMessage[];
    parameters?: GenerationParameters;
    timeoutMs?: number;
    signal: AbortSignal;
  }): Promise<ModelGenerationResponse> {
    const { runId, target, signal } = input;
    if (signal.aborted) {
      throw new CoreExecutionError(
        "EXECUTION_CANCELLED",
        "Execution was cancelled before the provider call",
        { statusCode: 409 },
      );
    }

    const timeoutMs = Math.min(
      input.timeoutMs ?? this.limits.providerTimeoutMs,
      this.limits.providerTimeoutMs,
    );
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, timeoutSignal]);

    try {
      return await target.adapter.generate({
        model: target.model.key,
        messages: [...input.messages],
        ...(input.parameters ? { parameters: input.parameters } : {}),
        requestId: deriveOutcomeUuid(runId, "provider-request"),
        timeoutMs,
        signal: combined,
      });
    } catch (error) {
      if (signal.aborted) {
        throw new CoreExecutionError(
          "EXECUTION_CANCELLED",
          "Execution was cancelled while waiting for the provider",
          { statusCode: 409 },
        );
      }
      if (error instanceof ProviderError) {
        if (error.code === "CANCELLED") {
          throw new CoreExecutionError(
            timeoutSignal.aborted ? "EXECUTION_CANCELLED" : "EXECUTION_CANCELLED",
            "Provider call was cancelled",
            { statusCode: 409, cause: error },
          );
        }
        throw error;
      }
      if (timeoutSignal.aborted) {
        throw new ProviderError("TIMEOUT", "Provider call exceeded the execution timeout", {
          providerKey: target.adapter.key,
          details: { model: target.model.key, timeoutMs },
        });
      }
      this.logger?.warn({ runId, provider: target.adapter.key }, "provider call failed");
      throw new ProviderError(
        "UNAVAILABLE",
        "Provider call failed before a response could be normalized",
        { providerKey: target.adapter.key, cause: error },
      );
    }
  }

  private describeFailure(error: unknown): { code: string; message: string } {
    if (error instanceof CoreExecutionError) {
      return { code: error.code, message: error.message };
    }
    if (error instanceof ProviderError) {
      return { code: `PROVIDER_${error.code}`, message: error.message };
    }
    const message =
      error instanceof Error ? error.message : "Unexpected execution failure";
    return { code: "PERSISTENCE_FAILED", message: redactSecrets(message, []) };
  }

  private async handleExecutionFailure(input: {
    ownerId: string;
    runId: string;
    error: unknown;
    profile: AssistantProfile;
  }): Promise<void> {
    const { ownerId, runId, error } = input;
    const { code, message } = this.describeFailure(error);
    await this.markFailed({ ownerId, runId, code, message });
    this.logger?.warn(
      {
        runId,
        code,
        assistantKey: input.profile.key,
      },
      "core execution failed",
    );
  }

  private async markFailed(input: {
    ownerId: string;
    runId: string;
    code: string;
    message: string;
  }): Promise<void> {
    const { ownerId, runId, code, message } = input;
    try {
      await this.tx(ownerId, async (repos) => {
        const run = await repos.executions.getById(runId);
        if (!run) return;
        if (
          run.status === "succeeded" ||
          run.status === "partial" ||
          run.status === "failed" ||
          run.status === "cancelled"
        ) {
          return;
        }
        const finishedAt = this.now().toISOString();
        const steps = await repos.executions.listSteps(runId);
        for (const step of steps) {
          if (step.status === "running" || step.status === "pending") {
            await repos.executions.updateStep({
              ...step,
              status: "failed",
              finishedAt,
            });
          }
        }
        await repos.executions.fail(runId, {
          finishedAt,
          metadata: {
            failureCode: code,
            failureMessage: redactSecrets(message, []).slice(0, 500),
          },
        });
      });
    } catch (persistError) {
      this.logger?.error(
        { runId, code },
        `failed to persist execution failure state: ${
          persistError instanceof Error ? persistError.message : "unknown error"
        }`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Persisted response reconstruction
  // ---------------------------------------------------------------------------

  private async buildResponse(
    repos: NexusRepositories,
    run: CoreRun,
    replayed: boolean,
  ): Promise<CoreExecutionResponse> {
    const [steps, results, children, messages] = await Promise.all([
      repos.executions.listSteps(run.id),
      repos.executions.listResults(run.id),
      repos.executions.listChildRuns(run.id),
      repos.messages.list(run.conversationId),
    ]);

    const inputMessage = messages.find((message) => message.id === run.inputMessageId);
    if (!inputMessage) {
      throw new CoreExecutionError(
        "PERSISTENCE_FAILED",
        "Persisted input message is missing; the execution cannot be replayed",
      );
    }
    const assistantMessage = run.finalMessageId
      ? messages.find((message) => message.id === run.finalMessageId)
      : undefined;
    if (!assistantMessage) {
      throw new CoreExecutionError(
        "PERSISTENCE_FAILED",
        "Persisted assistant message is missing; refusing to fabricate a response",
      );
    }

    const metadata = (run.metadata ?? {}) as Record<string, unknown>;
    const modelSelection = this.selectionFromMetadata(run, metadata);
    const contextReport = this.contextFromMetadata(metadata);

    const delegations: DelegationOutcomeRecord[] = [];
    for (const child of children) {
      const replay = await this.replayChildOutcome(repos, child);
      if (replay) delegations.push(replay.outcome);
    }

    return {
      execution: run,
      inputMessage,
      assistantMessage,
      steps: [...steps],
      results: [...results],
      delegations,
      childExecutions: [...children],
      modelSelection,
      contextReport,
      replayed,
    };
  }

  private selectionFromMetadata(
    run: CoreRun,
    metadata: Record<string, unknown>,
  ): CoreExecutionModelSummary {
    const required = [
      "resolvedScope",
      "providerId",
      "providerKey",
      "providerName",
      "modelId",
      "modelKey",
      "modelName",
      "freeEligibility",
    ] as const;
    const missing = required.filter((key) => metadata[key] === undefined);
    if (missing.length > 0) {
      throw new CoreExecutionError(
        "PERSISTENCE_FAILED",
        "Execution metadata does not contain the model selection used for this run",
        { details: { runId: run.id, missing } },
      );
    }
    const parsed = coreExecutionModelSummarySchema.safeParse({
      resolvedScope: metadata.resolvedScope,
      providerId: metadata.providerId,
      providerKey: metadata.providerKey,
      providerName: metadata.providerName,
      modelId: metadata.modelId,
      modelKey: metadata.modelKey,
      modelName: metadata.modelName,
      contextWindow: metadata.contextWindow ?? null,
      freeEligibility: restoreFreeEligibility(metadata.freeEligibility),
    });
    if (!parsed.success) {
      throw new CoreExecutionError(
        "PERSISTENCE_FAILED",
        "Persisted model selection metadata is not a valid contract",
        {
          details: {
            runId: run.id,
            issues: parsed.error.issues.map((issue) => issue.message),
          },
        },
      );
    }
    return parsed.data;
  }

  private contextFromMetadata(metadata: Record<string, unknown>): CoreContextReport {
    const report = (metadata.contextReport ?? {}) as Record<string, unknown>;
    const candidate = {
      effectiveContextWindow: Number(report.effectiveContextWindow ?? 0),
      usedFallbackWindow: Boolean(report.usedFallbackWindow),
      reservedOutputBudget: Number(report.reservedOutputBudget ?? 0),
      availableInputBudget: Number(report.availableInputBudget ?? 0),
      estimatedInputUnits: Number(report.estimatedInputUnits ?? 0),
      includedHistoryCount: Number(report.includedHistoryCount ?? 0),
      omittedHistoryCount: Number(report.omittedHistoryCount ?? 0),
    };
    const parsed = coreContextReportSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new CoreExecutionError(
        "PERSISTENCE_FAILED",
        "Persisted context report metadata is missing or invalid",
      );
    }
    return parsed.data;
  }
}
