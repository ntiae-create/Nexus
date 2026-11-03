import { z } from "zod";
import { assistantSchema } from "@nexus/shared";

const stableAssistantFieldsSchema = assistantSchema.pick({
  id: true,
  key: true,
  name: true,
  description: true,
  configVersion: true,
  status: true,
});

const capabilitySchema = z.string().regex(/^[a-z][a-z0-9_.-]*$/);

export const toolPermissionSchema = z.object({
  toolId: z.string().trim().min(1),
  category: z.string().trim().min(1),
  description: z.string().trim().min(1),
  allowed: z.boolean(),
  requiresUserAuthorization: z.literal(true),
  enabledByDefault: z.literal(false),
  paidUseRequiresExplicitAuthorization: z.literal(true),
}).strict();

export const assistantProfileSchema = stableAssistantFieldsSchema.extend({
  profileVersion: z.string().regex(/^\d+\.\d+\.\d+$/, "Expected a semantic profile version"),
  primaryRole: z.string().trim().min(1),
  personality: z.array(z.string().trim().min(1)).min(1),
  behaviorInstructions: z.array(z.string().trim().min(1)).min(1),
  communicationPreferences: z.object({
    tone: z.string().trim().min(1),
    style: z.string().trim().min(1),
    verbosity: z.enum(["concise", "balanced", "detailed"]),
    structure: z.array(z.string().trim().min(1)),
  }).strict(),
  capabilities: z.array(capabilitySchema).min(1),
  tools: z.array(toolPermissionSchema),
  usageRestrictions: z.array(z.string().trim().min(1)).min(1),
  memoryPolicy: z.object({
    individual: z.literal("own_assistant_only"),
    shared: z.literal("explicit_item_grant_required"),
    permissionAuthority: z.literal("backend"),
  }).strict(),
  metadata: z.object({
    lifecycle: z.literal("initial"),
    tags: z.array(z.string().trim().min(1)),
    extensible: z.literal(true),
  }).strict(),
  configuration: z.object({
    instructions: z.array(z.string().trim().min(1)).min(1),
    profileSchemaVersion: z.literal(1),
  }).strict(),
}).strict().superRefine((profile, ctx) => {
  if (profile.profileVersion !== profile.configVersion) {
    ctx.addIssue({
      code: "custom",
      path: ["configVersion"],
      message: "Profile and assistant configuration versions must match",
    });
  }
  const seen = new Set<string>();
  profile.tools.forEach((tool, index) => {
    if (seen.has(tool.toolId)) {
      ctx.addIssue({ code: "custom", path: ["tools", index, "toolId"], message: "Tool IDs must be unique within a profile" });
    }
    seen.add(tool.toolId);
  });
});

export const assistantProfileCatalogSchema = z.array(assistantProfileSchema).superRefine((profiles, ctx) => {
  const ids = new Set<string>();
  const keys = new Set<string>();
  profiles.forEach((profile, index) => {
    if (ids.has(profile.id)) {
      ctx.addIssue({ code: "custom", path: [index, "id"], message: "Assistant profile IDs must be unique" });
    }
    if (keys.has(profile.key)) {
      ctx.addIssue({ code: "custom", path: [index, "key"], message: "Assistant profile keys must be unique" });
    }
    ids.add(profile.id);
    keys.add(profile.key);
  });
});

export type ToolPermission = z.infer<typeof toolPermissionSchema>;
export type AssistantProfile = z.infer<typeof assistantProfileSchema>;
export type AssistantProfileCatalog = z.infer<typeof assistantProfileCatalogSchema>;
