import { z } from "zod";
import { jsonObjectSchema, nonEmptyStringSchema, schemaVersionSchema, timestampSchema, uuidSchema } from "./common.js";
import { normalizedDataSchema, toolEventMetadataSchema } from "./jsonb.js";
import { assistantKeySchema, assistantReferenceSchema, type AssistantKey } from "./assistants.js";
import { userIdSchema } from "./identity.js";
import { messageContentPartSchema, messageSchema } from "./messages.js";
import { selectionScopeSchema } from "./preferences.js";
import { freeEligibilitySchema, generationParametersSchema } from "./providers.js";

export const runStatusSchema = z.enum(["queued", "running", "succeeded", "partial", "failed", "cancelled"]);
export const stepStatusSchema = z.enum(["pending", "running", "succeeded", "failed", "skipped", "cancelled"]);
export const toolEventStatusSchema = z.enum(["requested", "running", "succeeded", "failed", "cancelled"]);
export const resultStatusSchema = z.enum(["succeeded", "partial", "failed"]);

const runTransitions: Record<z.infer<typeof runStatusSchema>, readonly z.infer<typeof runStatusSchema>[]> = {
  queued: ["running", "cancelled", "failed"],
  running: ["succeeded", "partial", "failed", "cancelled"],
  succeeded: [],
  partial: [],
  failed: [],
  cancelled: [],
};

export const runTransitionSchema = z.object({ from: runStatusSchema, to: runStatusSchema }).refine(({ from, to }) => ({
  ...runTransitions,
})[from].includes(to), {
  message: "Unsupported run state transition",
});

export { normalizedDataSchema } from "./jsonb.js";

export const coreRunSchema = z.object({
  id: uuidSchema,
  userId: userIdSchema,
  conversationId: uuidSchema,
  requestId: uuidSchema,
  idempotencyKey: nonEmptyStringSchema.max(200),
  status: runStatusSchema,
  assistantIds: z.array(uuidSchema).min(1),
  trace: z.array(assistantReferenceSchema),
  inputMessageId: uuidSchema,
  finalMessageId: uuidSchema.optional(),
  parentRunId: uuidSchema.optional(),
  parentStepId: uuidSchema.optional(),
  delegationDepth: z.number().int().nonnegative().optional(),
  startedAt: timestampSchema.optional(),
  finishedAt: timestampSchema.optional(),
  createdAt: timestampSchema,
  formatVersion: schemaVersionSchema,
  metadata: normalizedDataSchema.optional(),
}).superRefine((value, ctx) => {
  const hasParentRun = value.parentRunId !== undefined;
  const hasParentStep = value.parentStepId !== undefined;
  if (hasParentRun !== hasParentStep) {
    ctx.addIssue({
      code: "custom",
      path: [hasParentRun ? "parentStepId" : "parentRunId"],
      message: "Delegated child executions must define both parentRunId and parentStepId",
    });
  }
  if (hasParentRun && value.parentRunId === value.id) {
    ctx.addIssue({
      code: "custom",
      path: ["parentRunId"],
      message: "Execution cannot reference itself as parentRunId",
    });
  }
  if (hasParentRun && value.delegationDepth !== undefined && value.delegationDepth < 1) {
    ctx.addIssue({
      code: "custom",
      path: ["delegationDepth"],
      message: "Delegated child executions must have delegationDepth >= 1",
    });
  }
  if (!hasParentRun && value.delegationDepth !== undefined && value.delegationDepth !== 0) {
    ctx.addIssue({
      code: "custom",
      path: ["delegationDepth"],
      message: "Root executions cannot have delegationDepth > 0",
    });
  }
});

export const runStepSchema = z.object({
  id: uuidSchema,
  userId: userIdSchema,
  runId: uuidSchema,
  order: z.number().int().nonnegative(),
  assistant: assistantReferenceSchema,
  status: stepStatusSchema,
  objective: nonEmptyStringSchema,
  inputReferenceIds: z.array(uuidSchema),
  resultId: uuidSchema.optional(),
  startedAt: timestampSchema.optional(),
  finishedAt: timestampSchema.optional(),
  metadata: jsonObjectSchema.optional(),
});

export const sourceReferenceSchema = z.object({
  id: nonEmptyStringSchema,
  uri: z.string().url().optional(),
  title: z.string().optional(),
  sourceType: nonEmptyStringSchema,
  retrievedAt: timestampSchema.optional(),
  metadata: jsonObjectSchema.optional(),
});

export const toolEventSchema = z.object({
  id: uuidSchema,
  userId: userIdSchema,
  runId: uuidSchema,
  stepId: uuidSchema.optional(),
  tool: nonEmptyStringSchema,
  eventType: nonEmptyStringSchema,
  status: toolEventStatusSchema,
  normalizedData: normalizedDataSchema,
  references: z.array(sourceReferenceSchema),
  origin: nonEmptyStringSchema,
  occurredAt: timestampSchema,
  formatVersion: schemaVersionSchema,
  metadata: toolEventMetadataSchema.optional(),
}).strict();

export const runResultSchema = z.object({
  id: uuidSchema,
  userId: userIdSchema,
  runId: uuidSchema,
  stepId: uuidSchema.optional(),
  status: resultStatusSchema,
  content: z.array(z.object({ type: z.enum(["text", "reference", "structured"]), data: jsonObjectSchema })),
  references: z.array(sourceReferenceSchema),
  formatVersion: schemaVersionSchema,
  createdAt: timestampSchema,
  metadata: jsonObjectSchema.optional(),
});

export const runResultsSchema = z.object({
  runId: uuidSchema,
  status: resultStatusSchema,
  resultIds: z.array(uuidSchema),
  consolidatedResultId: uuidSchema.optional(),
  summary: z.string().optional(),
  createdAt: timestampSchema,
});

export interface DelegationTaskSpec {
  /**
   * Identifier of the assistant that receives the task. `AssistantKey`, not the frozen enum:
   * which assistants may actually be delegated to is a policy decision (Fase 3 derives it from
   * the profile registry), not a property of the identifier format.
   */
  targetAssistant: AssistantKey;
  objective: string;
  contextNotes?: string;
  inputReferenceIds?: string[];
  completionCriteria?: string;
  subDelegations?: DelegationTaskSpec[];
}

export const delegationTaskSpecSchema: z.ZodType<DelegationTaskSpec> = z.lazy(() =>
  z.object({
    targetAssistant: assistantKeySchema,
    objective: nonEmptyStringSchema.max(2_000),
    contextNotes: nonEmptyStringSchema.max(4_000).optional(),
    inputReferenceIds: z.array(uuidSchema).max(50).optional(),
    completionCriteria: nonEmptyStringSchema.max(1_000).optional(),
    subDelegations: z.array(delegationTaskSpecSchema).max(10).optional(),
  }).strict(),
);

export const COORDINATION_ENVELOPE_KIND = "nexus.core.coordination.v1" as const;

export const coordinatorDecisionEnvelopeSchema = z.discriminatedUnion("action", [
  z.object({
    kind: z.literal(COORDINATION_ENVELOPE_KIND),
    action: z.literal("delegate"),
    rationale: nonEmptyStringSchema.max(2_000).optional(),
    delegations: z.array(delegationTaskSpecSchema).min(1).max(10),
  }).strict(),
  z.object({
    kind: z.literal(COORDINATION_ENVELOPE_KIND),
    action: z.literal("respond"),
    response: nonEmptyStringSchema,
  }).strict(),
]);

export const delegationOutcomeRecordSchema = z.object({
  childRunId: uuidSchema,
  parentRunId: uuidSchema,
  parentStepId: uuidSchema,
  childStepId: uuidSchema,
  childResultId: uuidSchema,
  assistant: assistantReferenceSchema,
  objective: nonEmptyStringSchema,
  status: z.literal("succeeded"),
  outputText: nonEmptyStringSchema,
  providerKey: nonEmptyStringSchema,
  modelKey: nonEmptyStringSchema,
  delegationDepth: z.number().int().positive(),
}).strict();

export const coreExecutionRequestSchema = z.object({
  content: z.array(messageContentPartSchema).min(1),
  requestId: uuidSchema,
  idempotencyKey: nonEmptyStringSchema.max(140),
  assistantId: uuidSchema.optional(),
  assistantKey: assistantKeySchema.optional(),
  delegations: z.array(delegationTaskSpecSchema).min(1).max(10).optional(),
  parameters: generationParametersSchema.optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  metadata: normalizedDataSchema.optional(),
}).strict();

export const coreExecutionErrorCodeSchema = z.enum([
  "CORE_NOT_CONFIGURED",
  "CONVERSATION_NOT_FOUND",
  "CONVERSATION_INACTIVE",
  "EXECUTION_NOT_FOUND",
  "ASSISTANT_NOT_FOUND",
  "ASSISTANT_NOT_IN_CONVERSATION",
  "EXECUTION_IN_PROGRESS",
  "EXECUTION_ALREADY_TERMINAL",
  "EXECUTION_CANCELLED",
  "IDEMPOTENCY_CONFLICT",
  "CONTEXT_LIMIT_EXCEEDED",
  "INVALID_DELEGATION_CONTRACT",
  "DELEGATION_NOT_ALLOWED",
  "DELEGATION_CYCLE_DETECTED",
  "DELEGATION_DEPTH_EXCEEDED",
  "DELEGATION_LIMIT_EXCEEDED",
  "DELEGATED_EXECUTION_FAILED",
  "EMPTY_MODEL_RESPONSE",
  "PERSISTENCE_FAILED",
  "RATE_LIMITED",
]);

export const coreContextReportSchema = z.object({
  effectiveContextWindow: z.number().int().positive(),
  usedFallbackWindow: z.boolean(),
  reservedOutputBudget: z.number().int().nonnegative(),
  availableInputBudget: z.number().int().positive(),
  estimatedInputUnits: z.number().int().positive(),
  includedHistoryCount: z.number().int().nonnegative(),
  omittedHistoryCount: z.number().int().nonnegative(),
}).strict();

export const coreExecutionModelSummarySchema = z.object({
  resolvedScope: selectionScopeSchema,
  providerId: uuidSchema,
  providerKey: nonEmptyStringSchema,
  providerName: nonEmptyStringSchema,
  modelId: uuidSchema,
  modelKey: nonEmptyStringSchema,
  modelName: nonEmptyStringSchema,
  contextWindow: z.number().int().positive().nullable(),
  freeEligibility: freeEligibilitySchema,
}).strict();

export const coreExecutionResponseSchema = z.object({
  execution: coreRunSchema,
  inputMessage: messageSchema,
  assistantMessage: messageSchema,
  steps: z.array(runStepSchema),
  results: z.array(runResultSchema),
  delegations: z.array(delegationOutcomeRecordSchema),
  childExecutions: z.array(coreRunSchema),
  modelSelection: coreExecutionModelSummarySchema,
  contextReport: coreContextReportSchema,
  replayed: z.boolean(),
}).strict();

export const coreExecutionInspectionSchema = z.object({
  execution: coreRunSchema,
  steps: z.array(runStepSchema),
  results: z.array(runResultSchema),
  childExecutions: z.array(coreRunSchema),
}).strict();

export type RunStatus = z.infer<typeof runStatusSchema>;
export type StepStatus = z.infer<typeof stepStatusSchema>;
export type ToolEventStatus = z.infer<typeof toolEventStatusSchema>;
export type ResultStatus = z.infer<typeof resultStatusSchema>;
export type RunTransition = z.infer<typeof runTransitionSchema>;
export type CoreRun = z.infer<typeof coreRunSchema>;
export type RunStep = z.infer<typeof runStepSchema>;
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export type ToolEvent = z.infer<typeof toolEventSchema>;
export type RunResult = z.infer<typeof runResultSchema>;
export type RunResults = z.infer<typeof runResultsSchema>;
export type CoordinatorDecisionEnvelope = z.infer<typeof coordinatorDecisionEnvelopeSchema>;
export type DelegationOutcomeRecord = z.infer<typeof delegationOutcomeRecordSchema>;
export type CoreExecutionRequest = z.infer<typeof coreExecutionRequestSchema>;
export type CoreExecutionErrorCode = z.infer<typeof coreExecutionErrorCodeSchema>;
export type CoreContextReport = z.infer<typeof coreContextReportSchema>;
export type CoreExecutionModelSummary = z.infer<typeof coreExecutionModelSummarySchema>;
export type CoreExecutionResponse = z.infer<typeof coreExecutionResponseSchema>;
export type CoreExecutionInspection = z.infer<typeof coreExecutionInspectionSchema>;
