import { z } from "zod";
import { jsonObjectSchema, nonEmptyStringSchema, timestampSchema, uuidSchema } from "./common.js";

/**
 * Validatable assistant identifier.
 *
 * This is a **format** rule, not an authorization: matching the regex says the string is
 * *shaped* like an assistant key, never that an assistant with that key exists. Existence is
 * resolved against the canonical profile registry on the server (see
 * `resolveCanonicalAssistantProfile` / `getAssistantProfileByKey`).
 *
 * Before Etapa 3C.3 this concept did not exist: `initialAssistantKeySchema` was a closed enum
 * of three literals, and every contract that accepted an assistant key inherited the frozen
 * catalog as a side effect. The enum is still the catalog — but now it is only *one* input to
 * the lookup, not the shape of the identifier itself.
 */
export const assistantKeySchema = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);

/**
 * Frozen initial catalog of assistant keys.
 *
 * Kept verbatim on purpose: these are the assistants seeded by the database migrations and
 * referenced by the frozen profiles. Widening it is a data decision — a new profile plus a new
 * seed migration —, never something a contract change should do implicitly.
 *
 * Growth so far: the three assistants of migration 00001, plus VIVY in migration 00006 (Fase 4).
 * The enum is the catalog, so it changes only when the catalog does; identifiers outside it remain
 * valid `AssistantKey`s, and which assistant may actually answer is decided by the profile
 * registry, not here.
 */
export const initialAssistantKeySchema = z.enum(["yui", "alice", "schwi", "vivy"]);

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

/** Any valid assistant identifier — including keys of assistants not in the initial catalog. */
export type AssistantKey = z.infer<typeof assistantKeySchema>;
/** Keys of the frozen initial catalog. */
export type InitialAssistantKey = z.infer<typeof initialAssistantKeySchema>;
export type Assistant = z.infer<typeof assistantSchema>;
export type InitialAssistantProfile = z.infer<typeof initialAssistantProfileSchema>;
export type AssistantReference = z.infer<typeof assistantReferenceSchema>;
