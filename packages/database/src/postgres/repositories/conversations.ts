import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type { ConversationRepository } from "../../contracts.js";
import type { Conversation, CreateConversation } from "@nexus/shared";

function mapConversation(row: any, assistantIds: string[]): Conversation {
  return {
    id: row.id,
    userId: row.owner_id,
    title: row.title,
    status: row.status,
    assistantIds,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    metadata: row.metadata ?? undefined,
  };
}

export function createConversationRepository(client: PoolClient): ConversationRepository {
  return {
    async list(): Promise<readonly Conversation[]> {
      const convRes = await client.query(
        `SELECT id, owner_id, title, status, created_at, updated_at, metadata
         FROM nexus.conversations
         WHERE status <> 'deleted'
         ORDER BY updated_at DESC, id`,
      );
      if (convRes.rows.length === 0) return [];

      const ids = convRes.rows.map((r) => r.id);
      const assistRes = await client.query(
        `SELECT conversation_id, assistant_id
         FROM nexus.conversation_assistants
         WHERE conversation_id = ANY($1::uuid[])`,
        [ids],
      );
      const byConv = new Map<string, string[]>();
      for (const a of assistRes.rows) {
        const list = byConv.get(a.conversation_id) ?? [];
        list.push(a.assistant_id);
        byConv.set(a.conversation_id, list);
      }
      return convRes.rows.map((r) => mapConversation(r, byConv.get(r.id) ?? []));
    },

    async getById(conversationId: string): Promise<Conversation | null> {
      const res = await client.query(
        `SELECT id, owner_id, title, status, created_at, updated_at, metadata
         FROM nexus.conversations
         WHERE id = $1 AND status <> 'deleted'`,
        [conversationId],
      );
      const row = res.rows[0];
      if (!row) return null;
      const assistRes = await client.query(
        `SELECT assistant_id FROM nexus.conversation_assistants WHERE conversation_id = $1`,
        [conversationId],
      );
      return mapConversation(
        row,
        assistRes.rows.map((r) => r.assistant_id),
      );
    },

    async create(input: CreateConversation): Promise<Conversation> {
      const id = randomUUID();
      const title = input.title ?? null;
      const assistantIds = input.assistantIds ?? [];

      await client.query(
        `INSERT INTO nexus.conversations (id, owner_id, title, status, metadata)
         VALUES ($1, nexus.current_owner_id(), $2, 'active', $3::jsonb)`,
        [id, title, JSON.stringify(input.providerPreference ? { providerPreference: input.providerPreference } : {})],
      );

      for (const assistantId of assistantIds) {
        await client.query(
          `INSERT INTO nexus.conversation_assistants (owner_id, conversation_id, assistant_id)
           VALUES (nexus.current_owner_id(), $1, $2)
           ON CONFLICT DO NOTHING`,
          [id, assistantId],
        );
      }

      const created = await this.getById(id);
      if (!created) throw new Error("Failed to load conversation after create");
      return created;
    },

    async delete(conversationId: string): Promise<void> {
      await client.query(
        `UPDATE nexus.conversations
         SET status = 'deleted', updated_at = now()
         WHERE id = $1 AND status <> 'deleted'`,
        [conversationId],
      );
    },
  };
}
