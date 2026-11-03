import { z } from "zod";
import { jsonObjectSchema, nonEmptyStringSchema, timestampSchema, uuidSchema } from "./common.js";

export const initialAssistantKeySchema = z.enum(["yui", "alice", "schwi"]);
export const assistantSchema = z.object({
  id: uuidSchema,
  key: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  description: z.string().optional(),
  configVersion: nonEmptyStringSchema,
  configuration: jsonObjectSchema,
  status: z.enum(["active", "disabled"]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const initialAssistantProfileSchema = assistantSchema.extend({
  key: initialAssistantKeySchema,
});

export const assistantReferenceSchema = z.object({
  assistantId: uuidSchema,
  assistantKey: nonEmptyStringSchema,
  configVersion: nonEmptyStringSchema,
});

export type InitialAssistantKey = z.infer<typeof initialAssistantKeySchema>;
export type Assistant = z.infer<typeof assistantSchema>;
export type InitialAssistantProfile = z.infer<typeof initialAssistantProfileSchema>;
export type AssistantReference = z.infer<typeof assistantReferenceSchema>;
