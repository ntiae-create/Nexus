import { z } from "zod";
import { timestampSchema, uuidSchema } from "./common.js";
import { userIdSchema } from "./identity.js";
import {
  providerAuthorizationSchema,
  providerCatalogEntrySchema,
  providerKindSchema,
  publicEligibleModelSchema,
} from "./providers.js";

export const providerSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("automatic") }),
  z.object({
    mode: z.literal("manual"),
    providerId: uuidSchema,
    modelId: uuidSchema,
  }),
]);

export const globalProviderPreferenceSchema = z.object({
  id: uuidSchema,
  userId: userIdSchema,
  selection: providerSelectionSchema,
  updatedAt: timestampSchema,
});

export const assistantProviderPreferenceSchema = z.object({
  id: uuidSchema,
  userId: userIdSchema,
  assistantId: uuidSchema,
  selection: providerSelectionSchema,
  updatedAt: timestampSchema,
});

export const conversationProviderPreferenceSchema = z.object({
  userId: userIdSchema,
  conversationId: uuidSchema,
  selection: providerSelectionSchema,
  updatedAt: timestampSchema,
});

export const providerPreferenceSetSchema = z.object({
  global: globalProviderPreferenceSchema,
  byAssistant: z.array(assistantProviderPreferenceSchema),
  byConversation: z.array(conversationProviderPreferenceSchema),
});

export const providerPreferencePolicySchema = z.object({
  preferences: providerPreferenceSetSchema,
  authorizations: z.array(providerAuthorizationSchema),
  catalog: z.array(providerCatalogEntrySchema),
}).superRefine((value, ctx) => {
  const accountUserId = value.preferences.global.userId;
  value.preferences.byAssistant.forEach((preference, index) => {
    if (preference.userId !== accountUserId) {
      ctx.addIssue({ code: "custom", path: ["preferences", "byAssistant", index, "userId"], message: "Preference must belong to the global preference owner" });
    }
  });
  value.preferences.byConversation.forEach((preference, index) => {
    if (preference.userId !== accountUserId) {
      ctx.addIssue({ code: "custom", path: ["preferences", "byConversation", index, "userId"], message: "Preference must belong to the global preference owner" });
    }
  });
  value.authorizations.forEach((authorization, index) => {
    if (authorization.userId !== accountUserId) {
      ctx.addIssue({ code: "custom", path: ["authorizations", index, "userId"], message: "Authorization must belong to the preference owner" });
    }
  });
  const allowed = new Map(value.authorizations.map((item) => [item.providerId, item]));
  const selections: Array<{ selection: z.infer<typeof providerSelectionSchema>; path: (string | number)[] }> = [
    { selection: value.preferences.global.selection, path: ["preferences", "global", "selection"] },
    ...value.preferences.byAssistant.map((item, index) => ({
      selection: item.selection,
      path: ["preferences", "byAssistant", index, "selection"],
    })),
    ...value.preferences.byConversation.map((item, index) => ({
      selection: item.selection,
      path: ["preferences", "byConversation", index, "selection"],
    })),
  ];
  for (const { selection, path } of selections) {
    if (selection.mode !== "manual") continue;
    const authorization = allowed.get(selection.providerId);
    const catalogEntry = value.catalog.find((entry) => entry.provider.id === selection.providerId);
    const modelExists = catalogEntry?.provider.availability === "available"
      && catalogEntry.provider.costStatus !== "unknown"
      && catalogEntry.models.some((model) => model.id === selection.modelId && model.availability === "available");
    if (!modelExists) {
      ctx.addIssue({ code: "custom", path, message: "Model must be available in the selected provider catalog" });
    }
    if (!authorization?.authorized) {
      ctx.addIssue({ code: "custom", path, message: "Provider is not authorized for this user" });
    } else if (catalogEntry?.provider.costStatus === "paid" && !authorization.paidUseAuthorized) {
      ctx.addIssue({ code: "custom", path, message: "This preference cannot authorize paid provider use" });
    }
  }
});

export const resolveProviderSelectionWithScope = (
  preferences: z.infer<typeof providerPreferenceSetSchema>,
  context: { assistantId?: string; conversationId?: string },
): {
  readonly scope: "conversation" | "assistant" | "global";
  readonly selection: z.infer<typeof providerSelectionSchema>;
} => {
  if (context.conversationId) {
    const conversationPreference = preferences.byConversation.find(
      (item) => item.conversationId === context.conversationId,
    );
    if (conversationPreference) {
      return { scope: "conversation", selection: conversationPreference.selection };
    }
  }
  if (context.assistantId) {
    const assistantPreference = preferences.byAssistant.find(
      (item) => item.assistantId === context.assistantId,
    );
    if (assistantPreference) {
      return { scope: "assistant", selection: assistantPreference.selection };
    }
  }
  return { scope: "global", selection: preferences.global.selection };
};

export const resolveProviderSelection = (
  preferences: z.infer<typeof providerPreferenceSetSchema>,
  context: { assistantId: string; conversationId?: string },
): z.infer<typeof providerSelectionSchema> =>
  resolveProviderSelectionWithScope(preferences, context).selection;

export const selectionScopeSchema = z.enum(["conversation", "assistant", "global"]);

export const effectiveModelSelectionResponseSchema = z.object({
  resolvedScope: selectionScopeSchema,
  preference: providerSelectionSchema,
  context: z.object({
    assistantId: uuidSchema.optional(),
    conversationId: uuidSchema.optional(),
  }).strict(),
  selectedProvider: z.object({
    id: uuidSchema,
    key: z.string().trim().min(1),
    name: z.string().trim().min(1),
    kind: providerKindSchema,
  }).strict(),
  selectedModel: publicEligibleModelSchema,
  policy: z.object({
    freeVerified: z.literal(true),
    paidFallbackUsed: z.literal(false),
  }).strict(),
  evaluatedAt: timestampSchema,
}).strict();

export type ProviderSelection = z.infer<typeof providerSelectionSchema>;
export type SelectionScope = z.infer<typeof selectionScopeSchema>;
export type EffectiveModelSelectionResponse = z.infer<typeof effectiveModelSelectionResponseSchema>;
export type GlobalProviderPreference = z.infer<typeof globalProviderPreferenceSchema>;
export type AssistantProviderPreference = z.infer<typeof assistantProviderPreferenceSchema>;
export type ConversationProviderPreference = z.infer<typeof conversationProviderPreferenceSchema>;
export type ProviderPreferenceSet = z.infer<typeof providerPreferenceSetSchema>;
export type ProviderPreferencePolicy = z.infer<typeof providerPreferencePolicySchema>;
