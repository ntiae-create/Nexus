import { z } from "zod";
import { jsonObjectSchema, nonEmptyStringSchema, schemaVersionSchema, timestampSchema, uuidSchema } from "./common.js";
import { userIdSchema } from "./identity.js";

export const messageRoleSchema = z.enum(["user", "assistant", "core"]);
export const messageStatusSchema = z.enum(["pending", "complete", "failed", "cancelled"]);
export const messageContentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("reference"), referenceId: nonEmptyStringSchema, label: z.string().optional(), uri: z.string().url().optional() }),
  z.object({ type: z.literal("structured"), format: nonEmptyStringSchema, data: jsonObjectSchema }),
]);

export const messageSchema = z.object({
  id: uuidSchema,
  userId: userIdSchema,
  conversationId: uuidSchema,
  sequence: z.number().int().nonnegative(),
  role: messageRoleSchema,
  assistantId: uuidSchema.optional(),
  runId: uuidSchema.optional(),
  status: messageStatusSchema,
  content: z.array(messageContentPartSchema),
  formatVersion: schemaVersionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema.optional(),
  metadata: jsonObjectSchema.optional(),
});

export const sendMessageSchema = z.object({
  content: z.array(messageContentPartSchema).min(1),
  assistantId: uuidSchema.optional(),
  idempotencyKey: nonEmptyStringSchema.max(200),
  requestId: uuidSchema,
  metadata: jsonObjectSchema.optional(),
});

export type MessageRole = z.infer<typeof messageRoleSchema>;
export type MessageStatus = z.infer<typeof messageStatusSchema>;
export type MessageContentPart = z.infer<typeof messageContentPartSchema>;
export type Message = z.infer<typeof messageSchema>;
export type SendMessage = z.infer<typeof sendMessageSchema>;
