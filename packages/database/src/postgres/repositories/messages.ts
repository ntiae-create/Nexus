import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type { MessageRepository } from "../../contracts.js";
import type { Message, SendMessage } from "@nexus/shared";

function mapMessage(row: {
  id: string;
  owner_id: string;
  conversation_id: string;
  sequence: string | number;
  role: Message["role"];
  assistant_id: string | null;
  core_run_id: string | null;
  status: Message["status"];
  content: Message["content"];
  format_version: number;
  created_at: Date;
  updated_at: Date | null;
  metadata: Record<string, unknown> | null;
}): Message {
  return {
    id: row.id,
    userId: row.owner_id,
    conversationId: row.conversation_id,
    sequence: Number(row.sequence),
    role: row.role,
    assistantId: row.assistant_id ?? undefined,
    runId: row.core_run_id ?? undefined,
    status: row.status,
    content: row.content,
    formatVersion: row.format_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at ? row.updated_at.toISOString() : undefined,
    metadata: row.metadata ?? undefined,
  };
}

export function createMessageRepository(client: PoolClient): MessageRepository {
  return {
    async list(conversationId: string, afterSequence?: number): Promise<readonly Message[]> {
      const params: unknown[] = [conversationId];
      let sql = `
        SELECT id, owner_id, conversation_id, sequence, role, assistant_id, core_run_id,
               status, content, format_version, created_at, updated_at, metadata
        FROM nexus.messages
        WHERE conversation_id = $1`;
      if (afterSequence !== undefined) {
        params.push(afterSequence);
        sql += ` AND sequence > $2`;
      }
      sql += ` ORDER BY sequence ASC`;
      const res = await client.query(sql, params);
      return res.rows.map(mapMessage);
    },

    async append(conversationId: string, input: SendMessage): Promise<Message> {
      const seqRes = await client.query(
        `SELECT COALESCE(MAX(sequence), -1) + 1 AS next_seq
         FROM nexus.messages WHERE conversation_id = $1`,
        [conversationId],
      );
      const sequence = Number(seqRes.rows[0].next_seq);
      const id = randomUUID();
      const role = input.assistantId ? "assistant" : "user";
      const status = "complete" as const;

      await client.query(
        `INSERT INTO nexus.messages (
           id, owner_id, conversation_id, sequence, role, assistant_id,
           status, content, format_version, metadata
         ) VALUES (
           $1, nexus.current_owner_id(), $2, $3, $4, $5,
           $6, $7::jsonb, 1, $8::jsonb
         )`,
        [
          id,
          conversationId,
          sequence,
          role,
          input.assistantId ?? null,
          status,
          JSON.stringify(input.content),
          JSON.stringify(input.metadata ?? {}),
        ],
      );

      await client.query(
        `UPDATE nexus.conversations SET updated_at = now() WHERE id = $1`,
        [conversationId],
      );

      const res = await client.query(
        `SELECT id, owner_id, conversation_id, sequence, role, assistant_id, core_run_id,
                status, content, format_version, created_at, updated_at, metadata
         FROM nexus.messages WHERE id = $1`,
        [id],
      );
      return mapMessage(res.rows[0]);
    },
  };
}
