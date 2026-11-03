import { z } from "zod";
import { normalizedDataSchema, userIdSchema, uuidSchema } from "@nexus/shared";

const credentialFieldPattern = /(?:secret|credential|password|token|api.?key|authorization|private.?key|client.?secret)/i;

export const toolDataSchema = normalizedDataSchema.superRefine((data, ctx) => {
  const inspect = (value: unknown, path: (string | number)[]): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => inspect(item, [...path, index]));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (credentialFieldPattern.test(key)) {
          ctx.addIssue({ code: "custom", path: [...path, key], message: "Credential fields are forbidden in tool data" });
        }
        inspect(child, [...path, key]);
      }
    }
  };
  inspect(data, []);
});

export const toolAvailabilitySchema = z.enum(["available", "unavailable", "disabled", "demonstration_only"]);
export const toolRiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export const toolCostStatusSchema = z.enum(["free_confirmed", "may_involve_cost", "unknown"]);
export const toolNetworkRequirementSchema = z.enum(["none", "internet"]);
export const confirmationStatusSchema = z.enum(["not_requested", "pending", "confirmed", "rejected"]);

export const toolDefinitionMetadataSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/),
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  category: z.string().trim().min(1),
  authorizedAssistantKeys: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).min(1),
  riskLevel: toolRiskLevelSchema,
  requiresUserConfirmation: z.boolean(),
  mayInvolveCost: z.boolean(),
  costStatus: toolCostStatusSchema,
  networkRequirement: toolNetworkRequirementSchema,
  requiresExternalPermission: z.boolean(),
  availability: toolAvailabilitySchema,
  enabledByDefault: z.literal(false),
  demonstrationOnly: z.boolean(),
  treatExternalDataAsUntrusted: z.literal(true),
  authorizationAuthority: z.literal("backend"),
  metadata: toolDataSchema,
}).strict().superRefine((tool, ctx) => {
  if (tool.costStatus === "free_confirmed" && tool.mayInvolveCost) {
    ctx.addIssue({ code: "custom", path: ["mayInvolveCost"], message: "Confirmed free tools cannot be marked as cost-involving" });
  }
  if (tool.costStatus !== "free_confirmed" && !tool.mayInvolveCost) {
    ctx.addIssue({ code: "custom", path: ["mayInvolveCost"], message: "Unknown or possible cost must not be represented as free" });
  }
  if ((tool.riskLevel === "high" || tool.riskLevel === "critical") && !tool.requiresUserConfirmation) {
    ctx.addIssue({ code: "custom", path: ["requiresUserConfirmation"], message: "High-risk tools require user confirmation" });
  }
  if (tool.networkRequirement === "internet" && !tool.requiresExternalPermission) {
    ctx.addIssue({ code: "custom", path: ["requiresExternalPermission"], message: "External tools require external permission" });
  }
  if (tool.demonstrationOnly !== (tool.availability === "demonstration_only")) {
    ctx.addIssue({ code: "custom", path: ["availability"], message: "Demonstration definitions must use demonstration-only availability" });
  }
});

export const toolRequestContextSchema = z.object({
  requestId: uuidSchema,
  userId: userIdSchema,
  assistantKey: z.string().regex(/^[a-z][a-z0-9-]*$/),
  connection: z.enum(["online", "offline"]),
});

export const toolRequestSchema = toolRequestContextSchema.extend({
  toolId: z.string().trim().min(1),
  parameters: toolDataSchema,
});

export const toolExecutionPolicySchema = z.object({
  toolEnabledByBackend: z.boolean(),
  userAuthorization: z.object({
    status: z.enum(["not_authorized", "authorized", "revoked"]),
    userId: userIdSchema,
    toolId: z.string().trim().min(1).optional(),
    authority: z.literal("backend"),
    paidUseExplicitlyAuthorized: z.boolean(),
  }).strict(),
  externalPermission: z.object({
    userId: userIdSchema,
    toolId: z.string().trim().min(1),
    granted: z.boolean(),
    authority: z.literal("backend"),
  }).strict(),
  confirmation: z.object({
    status: confirmationStatusSchema,
    userId: userIdSchema,
    toolId: z.string().trim().min(1),
    authority: z.literal("backend"),
  }).strict(),
}).strict();

export const confirmationRequirementSchema = z.enum(["not_required", "required", "confirmed", "rejected"]);

export const toolPolicyDecisionSchema = z.object({
  eligible: z.boolean(),
  reason: z.enum([
    "eligible_for_future_backend_execution",
    "demonstration_only",
    "unavailable",
    "disabled_by_default",
    "not_enabled_by_backend",
    "assistant_not_authorized",
    "user_not_authorized",
    "authorization_scope_mismatch",
    "paid_use_not_explicitly_authorized",
    "connection_required",
    "external_permission_required",
    "user_confirmation_required",
    "user_confirmation_rejected",
  ]),
  confirmationRequirement: confirmationRequirementSchema,
  executionImplemented: z.literal(false),
  authorizationAuthority: z.literal("backend"),
});

export const toolErrorSchema = z.object({
  code: z.enum(["TOOL_NOT_FOUND", "DUPLICATE_TOOL_ID", "INVALID_TOOL_DEFINITION", "INVALID_PARAMETERS", "INVALID_RESULT"]),
  message: z.string().trim().min(1),
  requestId: uuidSchema.optional(),
  retryable: z.boolean(),
}).strict();

export type ToolAvailability = z.infer<typeof toolAvailabilitySchema>;
export type ToolRiskLevel = z.infer<typeof toolRiskLevelSchema>;
export type ToolCostStatus = z.infer<typeof toolCostStatusSchema>;
export type ConfirmationStatus = z.infer<typeof confirmationStatusSchema>;
export type ToolDefinitionMetadata = z.infer<typeof toolDefinitionMetadataSchema>;
export type ToolRequestContext = z.infer<typeof toolRequestContextSchema>;
export type ToolRequest = z.infer<typeof toolRequestSchema>;
export type ToolExecutionPolicy = z.infer<typeof toolExecutionPolicySchema>;
export type ConfirmationRequirement = z.infer<typeof confirmationRequirementSchema>;
export type ToolPolicyDecision = z.infer<typeof toolPolicyDecisionSchema>;
export type ToolError = z.infer<typeof toolErrorSchema>;
