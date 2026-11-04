import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type { MemoryRepository, MemoryPermissionAuditEvent } from "../../contracts.js";
import type { AssistantMemory, MemoryPermission } from "@nexus/shared";

/**
 * MemoryRepository.
 *
 * LIMITATIONS:
 * - Shared AssistantMemory.authorizedAssistantIds is derived from
 *   memory_permissions at read time; writes of grants/revokes go through
 *   grant/revoke methods (which also fire the audit trigger in the schema).
 * - The shared type uses "source" while the table column is "origin". Mapped.
 * - listForCurrentAssistant relies on RLS + nexus.current_assistant_id().
 */
function mapMemory(
  row: any,
  authorizedAssistantIds: string[] = [],
): AssistantMemory {
  return {
    id: row.id,
    userId: row.owner_id,
    visibility: row.visibility,
    source: row.origin,
    sourceMessageId: row.source_message_id ?? undefined,
    originAssistantId: row.origin_assistant_id ?? undefined,
    content: row.content,
    formatVersion: row.format_version,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    metadata: row.metadata ?? undefined,
    authorizedAssistantIds,
  };
}

export function createMemoryRepository(client: PoolClient): MemoryRepository {
  return {
    async listOwned(): Promise<readonly AssistantMemory[]> {
      const res = await client.query(
        `SELECT id, owner_id, visibility, origin, source_message_id, origin_assistant_id,
                content, format_version, status, created_at, updated_at, metadata
         FROM nexus.assistant_memories
         WHERE status = 'active'
         ORDER BY updated_at DESC`,
      );
      if (res.rows.length === 0) return [];

      const ids = res.rows.map((r) => r.id);
      const permRes = await client.query(
        `SELECT memory_id, assistant_id
         FROM nexus.memory_permissions
         WHERE memory_id = ANY($1::uuid[]) AND status = 'granted'`,
        [ids],
      );
      const byMemory = new Map<string, string[]>();
      for (const p of permRes.rows) {
        const list = byMemory.get(p.memory_id) ?? [];
        list.push(p.assistant_id);
        byMemory.set(p.memory_id, list);
      }
      return res.rows.map((r) => mapMemory(r, byMemory.get(r.id) ?? []));
    },

    async listForCurrentAssistant(): Promise<readonly AssistantMemory[]> {
      const res = await client.query(
        `SELECT m.id, m.owner_id, m.visibility, m.origin, m.source_message_id,
                m.origin_assistant_id, m.content, m.format_version, m.status,
                m.created_at, m.updated_at, m.metadata
         FROM nexus.assistant_memories m
         WHERE m.status = 'active'
           AND (
             (m.visibility = 'individual' AND m.origin_assistant_id = nexus.current_assistant_id())
             OR (
               m.visibility = 'shared'
               AND EXISTS (
                 SELECT 1 FROM nexus.memory_permissions p
                 WHERE p.memory_id = m.id
                   AND p.assistant_id = nexus.current_assistant_id()
                   AND p.status = 'granted'
               )
             )
           )
         ORDER BY m.updated_at DESC`,
      );
      return res.rows.map((r) => mapMemory(r, []));
    },

    async delete(memoryId: string): Promise<void> {
      await client.query(
        `UPDATE nexus.assistant_memories
         SET status = 'deleted', updated_at = now()
         WHERE id = $1 AND status = 'active'`,
        [memoryId],
      );
    },

    async grant(memoryId: string, assistantId: string): Promise<MemoryPermission> {
      const id = randomUUID();
      const res = await client.query(
        `INSERT INTO nexus.memory_permissions (
           id, owner_id, memory_id, assistant_id, status,
           granted_by_owner_id, granted_at
         ) VALUES (
           $1, nexus.current_owner_id(), $2, $3, 'granted',
           nexus.current_owner_id(), now()
         )
         ON CONFLICT (memory_id, assistant_id) DO UPDATE
         SET status = 'granted',
             granted_by_owner_id = nexus.current_owner_id(),
             granted_at = now(),
             revoked_by_owner_id = NULL,
             revoked_at = NULL
         RETURNING id, owner_id, memory_id, assistant_id, status, granted_at`,
        [id, memoryId, assistantId],
      );
      const row = res.rows[0];
      return {
        id: row.id,
        userId: row.owner_id,
        memoryId: row.memory_id,
        assistantId: row.assistant_id,
        status: row.status,
        grantedByUserId: row.owner_id,
        grantedAt: row.granted_at.toISOString(),
      };
    },

    async revoke(memoryId: string, assistantId: string): Promise<MemoryPermission> {
      const res = await client.query(
        `UPDATE nexus.memory_permissions
         SET status = 'revoked',
             revoked_by_owner_id = nexus.current_owner_id(),
             revoked_at = now()
         WHERE memory_id = $1 AND assistant_id = $2
         RETURNING id, owner_id, memory_id, assistant_id, status,
                   granted_by_owner_id, granted_at, revoked_by_owner_id, revoked_at`,
        [memoryId, assistantId],
      );
      const row = res.rows[0];
      if (!row) {
        throw new Error(`No memory_permission found for memory=${memoryId} assistant=${assistantId}`);
      }
      return {
        id: row.id,
        userId: row.owner_id,
        memoryId: row.memory_id,
        assistantId: row.assistant_id,
        status: row.status,
        grantedByUserId: row.granted_by_owner_id,
        grantedAt: row.granted_at.toISOString(),
        revokedByUserId: row.revoked_by_owner_id ?? undefined,
        revokedAt: row.revoked_at?.toISOString(),
      };
    },

    async listPermissionAudit(memoryId: string): Promise<readonly MemoryPermissionAuditEvent[]> {
      const res = await client.query(
        `SELECT id, owner_id, permission_id, memory_id, assistant_id, action,
                actor_owner_id, occurred_at
         FROM nexus.memory_permission_audit
         WHERE memory_id = $1
         ORDER BY occurred_at DESC`,
        [memoryId],
      );
      return res.rows.map((row) => ({
        id: Number(row.id),
        ownerId: row.owner_id,
        permissionId: row.permission_id,
        memoryId: row.memory_id,
        assistantId: row.assistant_id,
        action: row.action,
        actorOwnerId: row.actor_owner_id,
        occurredAt: row.occurred_at.toISOString(),
      }));
    },
  };
}
