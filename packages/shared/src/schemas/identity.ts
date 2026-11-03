import { z } from "zod";
import { timestampSchema, uuidSchema } from "./common.js";

export const userIdSchema = uuidSchema;
export const userIdentitySchema = z.object({
  userId: userIdSchema,
});
export const userAccountSchema = userIdentitySchema.extend({
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export const ownedEntitySchema = z.object({
  id: uuidSchema,
  userId: userIdSchema,
});

export type UserId = z.infer<typeof userIdSchema>;
export type UserIdentity = z.infer<typeof userIdentitySchema>;
export type UserAccount = z.infer<typeof userAccountSchema>;
export type OwnedEntity = z.infer<typeof ownedEntitySchema>;
