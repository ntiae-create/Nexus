import { z } from "zod";
import { jsonObjectSchema, opaqueCursorSchema, timestampSchema, uuidSchema } from "./common.js";
import { userIdSchema } from "./identity.js";

export const syncCursorSchema = z.object({
  userId: userIdSchema,
  cursor: opaqueCursorSchema.nullable(),
});

export const tombstoneSchema = z.object({
  id: uuidSchema,
  userId: userIdSchema,
  entityType: z.enum(["conversation", "message", "memory"]),
  entityId: uuidSchema,
  deletedAt: timestampSchema,
  sequence: z.number().int().nonnegative(),
});

export const syncChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upsert"), entityType: z.enum(["conversation", "message", "memory"]), entityId: uuidSchema, version: z.number().int().positive(), data: jsonObjectSchema }),
  z.object({ kind: z.literal("tombstone"), tombstone: tombstoneSchema }),
]);

export const incrementalSyncRequestSchema = z.object({
  cursor: opaqueCursorSchema.nullable(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const incrementalSyncResponseSchema = z.object({
  changes: z.array(syncChangeSchema),
  nextCursor: opaqueCursorSchema,
  hasMore: z.boolean(),
  generatedAt: timestampSchema,
});

export const deviceSettingsSchema = z.object({
  deviceId: uuidSchema,
  settings: jsonObjectSchema,
  updatedAt: timestampSchema,
});

export type SyncCursor = z.infer<typeof syncCursorSchema>;
export type Tombstone = z.infer<typeof tombstoneSchema>;
export type SyncChange = z.infer<typeof syncChangeSchema>;
export type IncrementalSyncRequest = z.infer<typeof incrementalSyncRequestSchema>;
export type IncrementalSyncResponse = z.infer<typeof incrementalSyncResponseSchema>;
export type DeviceSettings = z.infer<typeof deviceSettingsSchema>;
