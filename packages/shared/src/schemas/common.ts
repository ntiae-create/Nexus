import { z } from "zod";

export const uuidSchema = z.uuid();
export const timestampSchema = z.iso.datetime({ offset: true });
export const schemaVersionSchema = z.number().int().positive();
export const nonEmptyStringSchema = z.string().trim().min(1);
export const opaqueCursorSchema = z.string().min(1).max(4096);

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export const entityReferenceSchema = z.object({
  id: uuidSchema,
});
export type EntityReference = z.infer<typeof entityReferenceSchema>;

export const healthResponseSchema = z.object({ status: z.literal("ok") });
export type HealthResponse = z.infer<typeof healthResponseSchema>;
