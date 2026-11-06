import { z } from "zod";
import { nonEmptyStringSchema, timestampSchema, uuidSchema } from "./common.js";
import { normalizedDataSchema } from "./executions.js";

export const providerAvailabilitySchema = z.enum(["available", "unavailable", "restricted"]);
export const providerCostStatusSchema = z.enum(["free_confirmed", "paid", "unknown"]);
export const providerKindSchema = z.enum(["cloud", "local"]);

export const modelCapabilitySchema = z.enum([
  "chat",
  "system_prompt",
  "streaming",
  "structured_output",
  "reasoning",
  "vision",
  "code",
]);

export const modelParameterNameSchema = z.enum([
  "temperature",
  "topP",
  "maxOutputTokens",
  "stopSequences",
  "seed",
  "presencePenalty",
  "frequencyPenalty",
  "responseFormat",
]);

export const freeEligibilityReasonSchema = z.enum([
  "verified_free",
  "paid_model",
  "missing_free_suffix",
  "unverifiable_pricing",
  "provider_not_configured",
  "model_unavailable",
]);

export const modelPricingSummarySchema = z.object({
  promptPerToken: z.number().nonnegative().nullable(),
  completionPerToken: z.number().nonnegative().nullable(),
  requestFixed: z.number().nonnegative().nullable(),
}).strict();

export const freeEligibilitySchema = z.object({
  eligible: z.boolean(),
  costStatus: providerCostStatusSchema,
  verifiedAt: timestampSchema,
  requiresPreCallVerification: z.literal(true),
  reason: freeEligibilityReasonSchema,
  pricingSummary: modelPricingSummarySchema,
}).strict().superRefine((value, ctx) => {
  if (value.eligible && value.costStatus !== "free_confirmed") {
    ctx.addIssue({
      code: "custom",
      path: ["costStatus"],
      message: "Eligible models must have costStatus set to free_confirmed",
    });
  }
  if (value.eligible && value.reason !== "verified_free") {
    ctx.addIssue({
      code: "custom",
      path: ["reason"],
      message: "Eligible models must have reason set to verified_free",
    });
  }
});

export const providerSchema = z.object({
  id: uuidSchema,
  key: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  availability: providerAvailabilitySchema,
  costStatus: providerCostStatusSchema,
  capabilities: z.array(nonEmptyStringSchema),
  metadata: normalizedDataSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const modelSchema = z.object({
  id: uuidSchema,
  providerId: uuidSchema,
  key: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  availability: providerAvailabilitySchema,
  capabilities: z.array(nonEmptyStringSchema),
  metadata: normalizedDataSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const providerCatalogEntrySchema = z.object({ provider: providerSchema, models: z.array(modelSchema) }).superRefine((entry, ctx) => {
  entry.models.forEach((model, index) => {
    if (model.providerId !== entry.provider.id) {
      ctx.addIssue({ code: "custom", path: ["models", index, "providerId"], message: "Model must belong to this provider" });
    }
  });
});

export const providerAuthorizationSchema = z.object({
  userId: uuidSchema,
  providerId: uuidSchema,
  authorized: z.boolean(),
  paidUseAuthorized: z.boolean(),
});

export const generationResponseFormatSchema = z.object({
  type: z.enum(["text", "json_object"]),
}).strict();

export const generationParametersSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().gt(0).lte(1).optional(),
  maxOutputTokens: z.number().int().positive().max(131_072).optional(),
  stopSequences: z.array(nonEmptyStringSchema).max(16).optional(),
  seed: z.number().int().optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  responseFormat: generationResponseFormatSchema.optional(),
}).strict();

export const generationMessageRoleSchema = z.enum(["system", "user", "assistant"]);

export const generationMessageSchema = z.object({
  role: generationMessageRoleSchema,
  content: nonEmptyStringSchema,
}).strict();

export const modelGenerationRequestSchema = z.object({
  model: nonEmptyStringSchema,
  messages: z.array(generationMessageSchema).min(1),
  parameters: generationParametersSchema.optional(),
  requestId: uuidSchema.optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
}).strict();

export const generationFinishReasonSchema = z.enum([
  "stop",
  "length",
  "content_filter",
  "error",
  "unknown",
]);

export const tokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
}).strict();

export const modelGenerationResponseSchema = z.object({
  id: nonEmptyStringSchema,
  providerId: uuidSchema,
  providerKey: nonEmptyStringSchema,
  modelId: uuidSchema,
  modelKey: nonEmptyStringSchema,
  content: z.string(),
  finishReason: generationFinishReasonSchema,
  usage: tokenUsageSchema.optional(),
  createdAt: timestampSchema,
  freeEligibility: freeEligibilitySchema,
}).strict();

export const providerErrorCodeSchema = z.enum([
  "NOT_CONFIGURED",
  "PAID_MODEL_BLOCKED",
  "UNVERIFIED_PRICING_BLOCKED",
  "MODEL_NOT_FOUND",
  "MODEL_UNAVAILABLE",
  "INVALID_SELECTION",
  "INCOMPATIBLE_PARAMETERS",
  "AUTHENTICATION_FAILED",
  "RATE_LIMITED",
  "TIMEOUT",
  "CANCELLED",
  "UNAVAILABLE",
  "UPSTREAM_ERROR",
  "INVALID_RESPONSE",
]);

export const publicProviderSummarySchema = z.object({
  id: uuidSchema,
  key: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  kind: providerKindSchema,
  configured: z.boolean(),
  availability: providerAvailabilitySchema,
  costPolicy: z.literal("free_only"),
  costStatus: providerCostStatusSchema,
  capabilities: z.array(modelCapabilitySchema),
  supportedParameters: z.array(modelParameterNameSchema),
  eligibleModelCount: z.number().int().nonnegative(),
  unavailableReason: nonEmptyStringSchema.optional(),
  verifiedAt: timestampSchema.optional(),
}).strict();

export const providersListResponseSchema = z.object({
  providers: z.array(publicProviderSummarySchema),
  generatedAt: timestampSchema,
}).strict();

export const publicEligibleModelSchema = z.object({
  id: uuidSchema,
  providerId: uuidSchema,
  providerKey: nonEmptyStringSchema,
  key: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  availability: z.literal("available"),
  capabilities: z.array(modelCapabilitySchema),
  supportedParameters: z.array(modelParameterNameSchema),
  contextWindow: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  freeEligibility: freeEligibilitySchema.refine(
    (item) => item.eligible && item.costStatus === "free_confirmed",
    "Public eligible models must be verified as free",
  ),
}).strict();

export const publicUnavailableModelSchema = z.object({
  id: uuidSchema,
  providerId: uuidSchema,
  providerKey: nonEmptyStringSchema,
  key: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  availability: z.enum(["unavailable", "restricted"]),
  reason: freeEligibilityReasonSchema,
}).strict();

export const eligibleModelsResponseSchema = z.object({
  models: z.array(publicEligibleModelSchema),
  unavailableModels: z.array(publicUnavailableModelSchema),
  summary: z.object({
    totalEvaluated: z.number().int().nonnegative(),
    eligibleCount: z.number().int().nonnegative(),
    unavailableFreeCount: z.number().int().nonnegative(),
    blockedPaidCount: z.number().int().nonnegative(),
    blockedUnverifiedCount: z.number().int().nonnegative(),
  }).strict(),
  fetchedAt: timestampSchema,
  expiresAt: timestampSchema,
}).strict();

export const publicCapabilityDescriptorSchema = z.object({
  key: modelCapabilitySchema,
  description: nonEmptyStringSchema,
}).strict();

export const publicParameterDescriptorSchema = z.object({
  key: modelParameterNameSchema,
  description: nonEmptyStringSchema,
}).strict();

export const publicCapabilitiesResponseSchema = z.object({
  policy: z.object({
    costMode: z.literal("free_only"),
    paidModelsAllowed: z.literal(false),
    paidFallbackAllowed: z.literal(false),
    preCallPriceVerificationRequired: z.literal(true),
    openRouterFreeSuffix: z.literal(":free"),
  }).strict(),
  capabilities: z.array(publicCapabilityDescriptorSchema),
  parameters: z.array(publicParameterDescriptorSchema),
  selectionScopes: z.tuple([
    z.literal("conversation"),
    z.literal("assistant"),
    z.literal("global"),
  ]),
  selectionModes: z.tuple([z.literal("manual"), z.literal("automatic")]),
  providers: z.array(
    z.object({
      id: uuidSchema,
      key: nonEmptyStringSchema,
      name: nonEmptyStringSchema,
      kind: providerKindSchema,
      configured: z.boolean(),
      availability: providerAvailabilitySchema,
      capabilities: z.array(modelCapabilitySchema),
      supportedParameters: z.array(modelParameterNameSchema),
    }).strict(),
  ),
  generatedAt: timestampSchema,
}).strict();

export type ProviderAvailability = z.infer<typeof providerAvailabilitySchema>;
export type ProviderCostStatus = z.infer<typeof providerCostStatusSchema>;
export type ProviderKind = z.infer<typeof providerKindSchema>;
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;
export type ModelParameterName = z.infer<typeof modelParameterNameSchema>;
export type FreeEligibilityReason = z.infer<typeof freeEligibilityReasonSchema>;
export type ModelPricingSummary = z.infer<typeof modelPricingSummarySchema>;
export type FreeEligibility = z.infer<typeof freeEligibilitySchema>;
export type Provider = z.infer<typeof providerSchema>;
export type Model = z.infer<typeof modelSchema>;
export type ProviderCatalogEntry = z.infer<typeof providerCatalogEntrySchema>;
export type ProviderAuthorization = z.infer<typeof providerAuthorizationSchema>;
export type GenerationResponseFormat = z.infer<typeof generationResponseFormatSchema>;
export type GenerationParameters = z.infer<typeof generationParametersSchema>;
export type GenerationMessageRole = z.infer<typeof generationMessageRoleSchema>;
export type GenerationMessage = z.infer<typeof generationMessageSchema>;
export type ModelGenerationRequest = z.infer<typeof modelGenerationRequestSchema>;
export type GenerationFinishReason = z.infer<typeof generationFinishReasonSchema>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type ModelGenerationResponse = z.infer<typeof modelGenerationResponseSchema>;
export type ProviderErrorCode = z.infer<typeof providerErrorCodeSchema>;
export type PublicProviderSummary = z.infer<typeof publicProviderSummarySchema>;
export type ProvidersListResponse = z.infer<typeof providersListResponseSchema>;
export type PublicEligibleModel = z.infer<typeof publicEligibleModelSchema>;
export type PublicUnavailableModel = z.infer<typeof publicUnavailableModelSchema>;
export type EligibleModelsResponse = z.infer<typeof eligibleModelsResponseSchema>;
export type PublicCapabilitiesResponse = z.infer<typeof publicCapabilitiesResponseSchema>;
