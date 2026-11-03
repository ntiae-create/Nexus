import { z } from "zod";
import { jsonObjectSchema, nonEmptyStringSchema, timestampSchema, uuidSchema } from "./common.js";
import { userIdSchema } from "./identity.js";
import { providerSelectionSchema } from "./preferences.js";

export const conversationStatusSchema = z.enum(["active", "archived", "deleted"]);
export const conversationSchema = z.object({
  id: uuidSchema,
  userId: userIdSchema,
  title: nonEmptyStringSchema.nullable(),
  status: conversationStatusSchema,
  assistantIds: z.array(uuidSchema),
  providerPreference: providerSelectionSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  metadata: jsonObjectSchema.optional(),
});

export const createConversationSchema = z.object({
  title: nonEmptyStringSchema.max(200).optional(),
  assistantIds: z.array(uuidSchema).min(1).optional(),
  providerPreference: providerSelectionSchema.optional(),
});

export const conversationAssistantSchema = z.object({
  conversationId: uuidSchema,
  assistantId: uuidSchema,
  addedAt: timestampSchema,
});

export type ConversationStatus = z.infer<typeof conversationStatusSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type CreateConversation = z.infer<typeof createConversationSchema>;
export type ConversationAssistant = z.infer<typeof conversationAssistantSchema>;
