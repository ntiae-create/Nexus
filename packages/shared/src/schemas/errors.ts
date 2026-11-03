import { z } from "zod";
import { jsonObjectSchema, nonEmptyStringSchema, timestampSchema, uuidSchema } from "./common.js";

export const apiErrorSchema = z.object({
  error: z.object({
    code: nonEmptyStringSchema,
    message: nonEmptyStringSchema,
    requestId: uuidSchema.optional(),
    retryable: z.boolean(),
    details: jsonObjectSchema.optional(),
  }),
  timestamp: timestampSchema,
});

export type ApiError = z.infer<typeof apiErrorSchema>;
