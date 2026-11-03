import { z } from "zod";
import { jsonObjectSchema, nonEmptyStringSchema, schemaVersionSchema, timestampSchema, uuidSchema } from "./common.js";
import { assistantReferenceSchema } from "./assistants.js";
import { userIdSchema } from "./identity.js";

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
  startedAt: timestampSchema.optional(),
  finishedAt: timestampSchema.optional(),
  createdAt: timestampSchema,
  formatVersion: schemaVersionSchema,
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

const forbiddenSecretKey = /(^|[_-])(secret|credential|password|token|api[_-]?key|authorization)([_-]|$)/i;
export const normalizedDataSchema = jsonObjectSchema.superRefine((data, ctx) => {
  const inspect = (value: unknown, path: (string | number)[]): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => inspect(item, [...path, index]));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (forbiddenSecretKey.test(key)) {
          ctx.addIssue({ code: "custom", path: [...path, key], message: "Secret or credential fields are forbidden" });
        }
        inspect(item, [...path, key]);
      }
    }
  };
  inspect(data, []);
});
export const toolEventMetadataSchema = normalizedDataSchema;

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
