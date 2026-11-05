import type { PoolClient } from "pg";
import type { ProviderPreferenceRepository } from "../../contracts.js";
import type {
  ProviderPreferenceSet,
  ProviderSelection,
  GlobalProviderPreference,
  AssistantProviderPreference,
  ConversationProviderPreference,
} from "@nexus/shared";

type SelectionMode = "automatic" | "manual";

function mapSelection(
  mode: SelectionMode,
  providerId: string | null,
  modelId: string | null,
): ProviderSelection {
  if (mode === "automatic") return { mode: "automatic" };
  if (!providerId || !modelId) return { mode: "automatic" };
  return { mode: "manual", providerId, modelId };
}

function selectionToColumns(selection: ProviderSelection): {
  selection_mode: SelectionMode;
  provider_id: string | null;
  model_id: string | null;
} {
  if (selection.mode === "automatic") {
    return { selection_mode: "automatic", provider_id: null, model_id: null };
  }
  return {
    selection_mode: "manual",
    provider_id: selection.providerId,
    model_id: selection.modelId,
  };
}

/**
 * Concrete ProviderPreferenceRepository against tables in 00001_initial_schema.sql.
 * Maps shared nested `selection` shape to SQL selection_mode + provider_id/model_id.
 */
export function createProviderPreferenceRepository(
  client: PoolClient,
): ProviderPreferenceRepository {
  return {
    async getAll(): Promise<ProviderPreferenceSet> {
      const ownerRes = await client.query<{ id: string }>(
        `SELECT id FROM nexus.owner_identity WHERE singleton = true LIMIT 1`,
      );
      const ownerId = ownerRes.rows[0]?.id;
      if (!ownerId) {
        throw new Error(
          "ProviderPreferenceRepository.getAll: owner_identity singleton is missing",
        );
      }

      const globalRes = await client.query<{
        owner_id: string;
        selection_mode: SelectionMode;
        provider_id: string | null;
        model_id: string | null;
        updated_at: Date;
      }>(
        `SELECT owner_id, selection_mode, provider_id, model_id, updated_at
         FROM nexus.global_provider_preferences WHERE owner_id = $1`,
        [ownerId],
      );

      let global: GlobalProviderPreference;
      if (globalRes.rows[0]) {
        const row = globalRes.rows[0];
        global = {
          id: row.owner_id,
          userId: row.owner_id,
          selection: mapSelection(row.selection_mode, row.provider_id, row.model_id),
          updatedAt: row.updated_at.toISOString(),
        };
      } else {
        global = {
          id: ownerId,
          userId: ownerId,
          selection: { mode: "automatic" },
          updatedAt: new Date().toISOString(),
        };
      }

      const assistantRes = await client.query<{
        owner_id: string;
        assistant_id: string;
        selection_mode: SelectionMode;
        provider_id: string | null;
        model_id: string | null;
        updated_at: Date;
      }>(
        `SELECT owner_id, assistant_id, selection_mode, provider_id, model_id, updated_at
         FROM nexus.assistant_provider_preferences WHERE owner_id = $1`,
        [ownerId],
      );

      const byAssistant: AssistantProviderPreference[] = assistantRes.rows.map((row) => ({
        id: row.assistant_id,
        userId: row.owner_id,
        assistantId: row.assistant_id,
        selection: mapSelection(row.selection_mode, row.provider_id, row.model_id),
        updatedAt: row.updated_at.toISOString(),
      }));

      const conversationRes = await client.query<{
        owner_id: string;
        conversation_id: string;
        selection_mode: SelectionMode;
        provider_id: string | null;
        model_id: string | null;
        updated_at: Date;
      }>(
        `SELECT owner_id, conversation_id, selection_mode, provider_id, model_id, updated_at
         FROM nexus.conversation_provider_preferences WHERE owner_id = $1`,
        [ownerId],
      );

      const byConversation: ConversationProviderPreference[] = conversationRes.rows.map(
        (row) => ({
          userId: row.owner_id,
          conversationId: row.conversation_id,
          selection: mapSelection(row.selection_mode, row.provider_id, row.model_id),
          updatedAt: row.updated_at.toISOString(),
        }),
      );

      return { global, byAssistant, byConversation };
    },

    async replaceAll(preferences: ProviderPreferenceSet): Promise<ProviderPreferenceSet> {
      const ownerRes = await client.query<{ id: string }>(
        `SELECT id FROM nexus.owner_identity WHERE singleton = true LIMIT 1`,
      );
      const ownerId = ownerRes.rows[0]?.id;
      if (!ownerId) {
        throw new Error(
          "ProviderPreferenceRepository.replaceAll: owner_identity singleton is missing",
        );
      }
      if (preferences.global.userId !== ownerId) {
        throw new Error(
          "ProviderPreferenceRepository.replaceAll: preference owner does not match singleton",
        );
      }

      const globalCols = selectionToColumns(preferences.global.selection);
      await client.query(
        `INSERT INTO nexus.global_provider_preferences
           (owner_id, selection_mode, provider_id, model_id, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (owner_id) DO UPDATE SET
           selection_mode = EXCLUDED.selection_mode,
           provider_id = EXCLUDED.provider_id,
           model_id = EXCLUDED.model_id,
           updated_at = now()`,
        [ownerId, globalCols.selection_mode, globalCols.provider_id, globalCols.model_id],
      );

      await client.query(
        `DELETE FROM nexus.assistant_provider_preferences WHERE owner_id = $1`,
        [ownerId],
      );
      for (const pref of preferences.byAssistant) {
        if (pref.userId !== ownerId) {
          throw new Error(
            "ProviderPreferenceRepository.replaceAll: assistant preference owner mismatch",
          );
        }
        const cols = selectionToColumns(pref.selection);
        await client.query(
          `INSERT INTO nexus.assistant_provider_preferences
             (owner_id, assistant_id, selection_mode, provider_id, model_id, updated_at)
           VALUES ($1, $2, $3, $4, $5, now())`,
          [ownerId, pref.assistantId, cols.selection_mode, cols.provider_id, cols.model_id],
        );
      }

      await client.query(
        `DELETE FROM nexus.conversation_provider_preferences WHERE owner_id = $1`,
        [ownerId],
      );
      for (const pref of preferences.byConversation) {
        if (pref.userId !== ownerId) {
          throw new Error(
            "ProviderPreferenceRepository.replaceAll: conversation preference owner mismatch",
          );
        }
        const cols = selectionToColumns(pref.selection);
        await client.query(
          `INSERT INTO nexus.conversation_provider_preferences
             (owner_id, conversation_id, selection_mode, provider_id, model_id, updated_at)
           VALUES ($1, $2, $3, $4, $5, now())`,
          [
            ownerId,
            pref.conversationId,
            cols.selection_mode,
            cols.provider_id,
            cols.model_id,
          ],
        );
      }

      return this.getAll();
    },
  };
}
