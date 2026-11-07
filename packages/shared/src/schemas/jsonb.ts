import { z } from "zod";
import { jsonObjectSchema } from "./common.js";

/**
 * Leaf-level JSONB guard shared by execution, provider and tool contracts.
 *
 * Kept in its own module so `executions.ts` can depend on `providers.ts` without
 * creating a module-evaluation cycle (which would leave schemas undefined).
 */
const forbiddenSecretKey = /(^|[_-])(secret|credential|password|token|api[_-]?key|authorization)([_-]|$)/i;

export const normalizedDataSchema = jsonObjectSchema.superRefine((data, ctx) => {
  const inspect = (value: unknown, path: (string | number)[]): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => inspect(item, [...path, index]));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (forbiddenSecretKey.test(key)) {
          ctx.addIssue({
            code: "custom",
            path: [...path, key],
            message: "Secret or credential fields are forbidden",
          });
        }
        inspect(item, [...path, key]);
      }
    }
  };
  inspect(data, []);
});

export const toolEventMetadataSchema = normalizedDataSchema;
