import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import {
  appendAssistantMessageSchema,
  sendMessageSchema,
  type AppendAssistantMessage,
  type Message,
  type SendMessage,
} from "@nexus/shared";
import type { MessageRepository } from "../../contracts.js";

interface MessageRow {
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
  metadata: Message["metadata"] | null;
}

const messageColumns = `
  id, owner_id, conversation_id, sequence, role, assistant_id, core_run_id,
  status, content, format_version, created_at, updated_at, metadata
`;

function mapMessage(row: MessageRow): Message {
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

interface MessageAuthor {
  readonly role: "user" | "assistant";
  readonly assistantId: string | null;
  readonly runId: string | null;
}

export function createMessageRepository(client: PoolClient): MessageRepository {
  const appendInternal = async (
    conversationId: string,
    input: SendMessage,
    author: MessageAuthor,
  ): Promise<Message> => {
    // All append paths lock the parent before reading MAX(sequence). This both
    // authorizes the conversation and serializes concurrent sequence assignment.
    const conversation = await client.query(
      `SELECT id FROM nexus.conversations
       WHERE id = $1 AND status <> 'deleted'
       FOR UPDATE`,
      [conversationId],
    );
    if (!conversation.rows[0]) {
      throw new Error("Conversation not found or not accessible");
    }

    const existing = await client.query<MessageRow>(
      `SELECT ${messageColumns}
       FROM nexus.messages
       WHERE conversation_id = $1 AND idempotency_key = $2`,
      [conversationId, input.idempotencyKey],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      const sameOperation =
        row.role === author.role &&
        row.assistant_id === author.assistantId &&
        row.core_run_id === author.runId &&
        isDeepStrictEqual(row.content, input.content) &&
        isDeepStrictEqual(row.metadata ?? {}, input.metadata ?? {});
      if (!sameOperation) {
        throw new Error(
          "Idempotency key conflict: the key belongs to a different message operation",
        );
      }
      // Retries return the original row and never advance sequence/updated_at.
      return mapMessage(row);
    }

    const sequenceResult = await client.query<{ next_sequence: string }>(
      `SELECT COALESCE(MAX(sequence) + 1, 0)::text AS next_sequence
       FROM nexus.messages
       WHERE conversation_id = $1`,
      [conversationId],
    );
    const sequence = Number(sequenceResult.rows[0]!.next_sequence);

    const inserted = await client.query<MessageRow>(
      `INSERT INTO nexus.messages (
         id, owner_id, conversation_id, sequence, role, assistant_id, core_run_id,
         status, content, format_version, request_id, idempotency_key, metadata
       ) VALUES (
         $1, nexus.current_owner_id(), $2, $3, $4, $5, $6,
         'complete', $7::jsonb, 1, $8, $9, $10::jsonb
       )
       RETURNING ${messageColumns}`,
      [
        randomUUID(),
        conversationId,
        sequence,
        author.role,
        author.assistantId,
        author.runId,
        JSON.stringify(input.content),
        input.requestId,
        input.idempotencyKey,
        JSON.stringify(input.metadata ?? {}),
      ],
    );

    await client.query(
      `UPDATE nexus.conversations SET updated_at = now() WHERE id = $1`,
      [conversationId],
    );

    return mapMessage(inserted.rows[0]!);
  };

  return {
    async list(conversationId: string, afterSequence?: number): Promise<readonly Message[]> {
      if (
        afterSequence !== undefined &&
        (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
      ) {
        throw new Error("afterSequence must be a non-negative safe integer");
      }
      const params: unknown[] = [conversationId];
      let sql = `
        SELECT ${messageColumns}
        FROM nexus.messages
        WHERE conversation_id = $1`;
      if (afterSequence !== undefined) {
        params.push(afterSequence);
        sql += ` AND sequence > $2`;
      }
      sql += ` ORDER BY sequence ASC, id ASC`;
      const result = await client.query<MessageRow>(sql, params);
      return result.rows.map(mapMessage);
    },

    async append(conversationId: string, rawInput: SendMessage): Promise<Message> {
      const input = sendMessageSchema.parse(rawInput);
      if (input.assistantId) {
        throw new Error(
          "User-authored messages cannot claim assistant authorship; use appendAssistant",
        );
      }
      return appendInternal(conversationId, input, {
        role: "user",
        assistantId: null,
        runId: null,
      });
    },

    async appendAssistant(
      conversationId: string,
      rawInput: AppendAssistantMessage,
    ): Promise<Message> {
      const input = appendAssistantMessageSchema.parse(rawInput);
      return appendInternal(conversationId, input, {
        role: "assistant",
        assistantId: input.assistantId,
        runId: input.runId ?? null,
      });
    },
  };
}
