import { z } from "zod";
import { timestampSchema, uuidSchema } from "./common.js";
import { userIdSchema } from "./identity.js";
import { providerAuthorizationSchema, providerCatalogEntrySchema } from "./providers.js";

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

export const resolveProviderSelection = (
  preferences: z.infer<typeof providerPreferenceSetSchema>,
  context: { assistantId: string; conversationId?: string },
): z.infer<typeof providerSelectionSchema> => {
  const conversationPreference = context.conversationId
    ? preferences.byConversation.find((item) => item.conversationId === context.conversationId)
    : undefined;
  if (conversationPreference) return conversationPreference.selection;
  const assistantPreference = preferences.byAssistant.find((item) => item.assistantId === context.assistantId);
  return assistantPreference?.selection ?? preferences.global.selection;
};

export type ProviderSelection = z.infer<typeof providerSelectionSchema>;
export type GlobalProviderPreference = z.infer<typeof globalProviderPreferenceSchema>;
export type AssistantProviderPreference = z.infer<typeof assistantProviderPreferenceSchema>;
export type ConversationProviderPreference = z.infer<typeof conversationProviderPreferenceSchema>;
export type ProviderPreferenceSet = z.infer<typeof providerPreferenceSetSchema>;
export type ProviderPreferencePolicy = z.infer<typeof providerPreferencePolicySchema>;
