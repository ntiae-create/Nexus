import { z } from "zod";
import { jsonObjectSchema, nonEmptyStringSchema, schemaVersionSchema, timestampSchema, uuidSchema } from "./common.js";
import { userIdSchema } from "./identity.js";

export const memoryVisibilitySchema = z.enum(["individual", "shared"]);
export const memoryStatusSchema = z.enum(["active", "deleted"]);

export const assistantMemorySchema = z.object({
  id: uuidSchema,
  userId: userIdSchema,
  visibility: memoryVisibilitySchema,
  source: nonEmptyStringSchema,
  sourceMessageId: uuidSchema.optional(),
  originAssistantId: uuidSchema.optional(),
  content: nonEmptyStringSchema,
  formatVersion: schemaVersionSchema,
  status: memoryStatusSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  metadata: jsonObjectSchema.optional(),
  authorizedAssistantIds: z.array(uuidSchema),
}).superRefine((memory, ctx) => {
  if (memory.visibility === "individual" && memory.authorizedAssistantIds.length !== 0) {
    ctx.addIssue({ code: "custom", path: ["authorizedAssistantIds"], message: "Individual memories do not grant cross-assistant access" });
  }
  if (memory.visibility === "individual" && !memory.originAssistantId) {
    ctx.addIssue({ code: "custom", path: ["originAssistantId"], message: "Individual memories must identify their assistant" });
  }
  if (memory.visibility === "shared" && memory.authorizedAssistantIds.length === 0) {
    ctx.addIssue({ code: "custom", path: ["authorizedAssistantIds"], message: "Shared memories require explicit assistant grants" });
  }
});

export const memoryPermissionSchema = z.object({
  id: uuidSchema,
  userId: userIdSchema,
  memoryId: uuidSchema,
  assistantId: uuidSchema,
  status: z.enum(["granted", "revoked"]),
  grantedByUserId: userIdSchema,
  grantedAt: timestampSchema,
  revokedByUserId: userIdSchema.optional(),
  revokedAt: timestampSchema.optional(),
}).superRefine((permission, ctx) => {
  if (permission.status === "revoked" && (!permission.revokedByUserId || !permission.revokedAt)) {
    ctx.addIssue({ code: "custom", path: ["revokedAt"], message: "Revocation requires actor and timestamp" });
  }
  if (permission.status === "granted" && (permission.revokedByUserId || permission.revokedAt)) {
    ctx.addIssue({ code: "custom", path: ["revokedAt"], message: "Active grants cannot contain revocation metadata" });
  }
});

export const memoryAccessRequestSchema = z.object({
  userId: userIdSchema,
  memory: assistantMemorySchema,
  requestingAssistantId: uuidSchema,
  permissions: z.array(memoryPermissionSchema),
});

export const memoryAccessDecisionSchema = z.object({
  memoryId: uuidSchema,
  requestingAssistantId: uuidSchema,
  allowed: z.boolean(),
  reason: z.enum(["owner_assistant", "explicit_grant", "not_shared", "missing_grant", "revoked_grant", "wrong_owner"]),
});

export const memoryAccessDecision = (input: z.infer<typeof memoryAccessRequestSchema>): z.infer<typeof memoryAccessDecisionSchema> => {
  const { memory, requestingAssistantId, permissions, userId } = input;
  let reason: z.infer<typeof memoryAccessDecisionSchema>["reason"];
  let allowed = false;
  if (memory.userId !== userId) reason = "wrong_owner";
  else if (memory.visibility === "individual") {
    allowed = memory.originAssistantId === requestingAssistantId;
    reason = allowed ? "owner_assistant" : "not_shared";
  }
  else {
    const grant = permissions.find((permission) => permission.userId === userId && permission.memoryId === memory.id && permission.assistantId === requestingAssistantId);
    if (grant?.status === "granted" && memory.authorizedAssistantIds.includes(requestingAssistantId)) {
      allowed = true;
      reason = "explicit_grant";
    } else if (grant?.status === "revoked") reason = "revoked_grant";
    else reason = "missing_grant";
  }
  return memoryAccessDecisionSchema.parse({ memoryId: memory.id, requestingAssistantId, allowed, reason });
};

export type MemoryVisibility = z.infer<typeof memoryVisibilitySchema>;
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;
export type AssistantMemory = z.infer<typeof assistantMemorySchema>;
export type MemoryPermission = z.infer<typeof memoryPermissionSchema>;
export type MemoryAccessRequest = z.infer<typeof memoryAccessRequestSchema>;
export type MemoryAccessDecision = z.infer<typeof memoryAccessDecisionSchema>;
