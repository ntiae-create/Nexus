import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  createConversationSchema,
  type Conversation,
  type CreateConversation,
  type ProviderSelection,
} from "@nexus/shared";
import type { ConversationRepository } from "../../contracts.js";
import { createProviderPreferenceRepository } from "./preferences.js";

interface ConversationRow {
  id: string;
  owner_id: string;
  title: string | null;
  status: Conversation["status"];
  created_at: Date;
  updated_at: Date;
  metadata: Conversation["metadata"] | null;
  preference_selection_mode: "automatic" | "manual" | null;
  preference_provider_id: string | null;
  preference_model_id: string | null;
}

const conversationColumns = `
  conversation.id, conversation.owner_id, conversation.title, conversation.status,
  conversation.created_at, conversation.updated_at, conversation.metadata,
  preference.selection_mode AS preference_selection_mode,
  preference.provider_id AS preference_provider_id,
  preference.model_id AS preference_model_id
`;

function mapConversation(row: ConversationRow, assistantIds: string[]): Conversation {
  let providerPreference: ProviderSelection | undefined;
  if (row.preference_selection_mode === "automatic") {
    providerPreference = { mode: "automatic" };
  } else if (
    row.preference_selection_mode === "manual" &&
    row.preference_provider_id &&
    row.preference_model_id
  ) {
    providerPreference = {
      mode: "manual",
      providerId: row.preference_provider_id,
      modelId: row.preference_model_id,
    };
  }

  return {
    id: row.id,
    userId: row.owner_id,
    title: row.title,
    status: row.status,
    assistantIds,
    providerPreference,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    metadata: row.metadata ?? undefined,
  };
}

export function createConversationRepository(client: PoolClient): ConversationRepository {
  const preferences = createProviderPreferenceRepository(client);

  const getById = async (conversationId: string): Promise<Conversation | null> => {
    const result = await client.query<ConversationRow>(
      `SELECT ${conversationColumns}
       FROM nexus.conversations AS conversation
       LEFT JOIN nexus.conversation_provider_preferences AS preference
         ON preference.conversation_id = conversation.id
        AND preference.owner_id = conversation.owner_id
       WHERE conversation.id = $1 AND conversation.status <> 'deleted'`,
      [conversationId],
    );
    const row = result.rows[0];
    if (!row) return null;

    const assistants = await client.query<{ assistant_id: string }>(
      `SELECT assistant_id FROM nexus.conversation_assistants
       WHERE conversation_id = $1
       ORDER BY added_at, assistant_id`,
      [conversationId],
    );
    return mapConversation(
      row,
      assistants.rows.map((assistant) => assistant.assistant_id),
    );
  };

  return {
    async list(): Promise<readonly Conversation[]> {
      const conversations = await client.query<ConversationRow>(
        `SELECT ${conversationColumns}
         FROM nexus.conversations AS conversation
         LEFT JOIN nexus.conversation_provider_preferences AS preference
           ON preference.conversation_id = conversation.id
          AND preference.owner_id = conversation.owner_id
         WHERE conversation.status <> 'deleted'
         ORDER BY conversation.updated_at DESC, conversation.id`,
      );
      if (conversations.rows.length === 0) return [];

      const ids = conversations.rows.map((row) => row.id);
      const assistants = await client.query<{
        conversation_id: string;
        assistant_id: string;
      }>(
        `SELECT conversation_id, assistant_id
         FROM nexus.conversation_assistants
         WHERE conversation_id = ANY($1::uuid[])
         ORDER BY added_at, assistant_id`,
        [ids],
      );
      const byConversation = new Map<string, string[]>();
      for (const assistant of assistants.rows) {
        const list = byConversation.get(assistant.conversation_id) ?? [];
        list.push(assistant.assistant_id);
        byConversation.set(assistant.conversation_id, list);
      }
      return conversations.rows.map((row) =>
        mapConversation(row, byConversation.get(row.id) ?? []),
      );
    },

    getById,

    async create(rawInput: CreateConversation): Promise<Conversation> {
      const input = createConversationSchema.parse(rawInput);
      const id = randomUUID();
      await client.query(
        `INSERT INTO nexus.conversations (id, owner_id, title, status, metadata)
         VALUES ($1, nexus.current_owner_id(), $2, 'active', '{}'::jsonb)`,
        [id, input.title ?? null],
      );

      for (const assistantId of input.assistantIds ?? []) {
        await client.query(
          `INSERT INTO nexus.conversation_assistants (owner_id, conversation_id, assistant_id)
           VALUES (nexus.current_owner_id(), $1, $2)
           ON CONFLICT DO NOTHING`,
          [id, assistantId],
        );
      }

      if (input.providerPreference) {
        await preferences.setConversation(id, input.providerPreference);
      }

      const created = await getById(id);
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
