import { z } from "zod";
import { jsonObjectSchema, nonEmptyStringSchema, timestampSchema, uuidSchema } from "./common.js";
import { normalizedDataSchema } from "./executions.js";

export const providerAvailabilitySchema = z.enum(["available", "unavailable", "restricted"]);
export const providerSchema = z.object({
  id: uuidSchema,
  key: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  availability: providerAvailabilitySchema,
  costStatus: z.enum(["free_confirmed", "paid", "unknown"]),
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

export type ProviderAvailability = z.infer<typeof providerAvailabilitySchema>;
export type Provider = z.infer<typeof providerSchema>;
export type Model = z.infer<typeof modelSchema>;
export type ProviderCatalogEntry = z.infer<typeof providerCatalogEntrySchema>;
export type ProviderAuthorization = z.infer<typeof providerAuthorizationSchema>;
