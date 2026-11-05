import type { PoolClient } from "pg";
import {
  providerPreferenceSetSchema,
  providerSelectionSchema,
  resolveProviderSelection,
  type AssistantProviderPreference,
  type ConversationProviderPreference,
  type GlobalProviderPreference,
  type ProviderPreferenceSet,
  type ProviderSelection,
} from "@nexus/shared";
import type { ProviderPreferenceRepository } from "../../contracts.js";

type SelectionMode = "automatic" | "manual";

interface PreferenceRow {
  owner_id: string;
  selection_mode: SelectionMode;
  provider_id: string | null;
  model_id: string | null;
  updated_at: Date;
}

interface AssistantPreferenceRow extends PreferenceRow {
  assistant_id: string;
}

interface ConversationPreferenceRow extends PreferenceRow {
  conversation_id: string;
}

function mapSelection(row: PreferenceRow): ProviderSelection {
  if (row.selection_mode === "automatic") return { mode: "automatic" };
  if (!row.provider_id || !row.model_id) {
    throw new Error("Manual provider preference is missing its provider or model");
  }
  return {
    mode: "manual",
    providerId: row.provider_id,
    modelId: row.model_id,
  };
}

function selectionToColumns(selection: ProviderSelection): {
  selectionMode: SelectionMode;
  providerId: string | null;
  modelId: string | null;
} {
  if (selection.mode === "automatic") {
    return { selectionMode: "automatic", providerId: null, modelId: null };
  }
  return {
    selectionMode: "manual",
    providerId: selection.providerId,
    modelId: selection.modelId,
  };
}

export function createProviderPreferenceRepository(
  client: PoolClient,
): ProviderPreferenceRepository {
  const requireOwnerId = async (): Promise<string> => {
    const result = await client.query<{ owner_id: string | null }>(
      `SELECT CASE
         WHEN nexus.current_owner_id() = nexus.configured_owner_id()
           THEN nexus.current_owner_id()
       END AS owner_id`,
    );
    const ownerId = result.rows[0]?.owner_id;
    if (!ownerId) throw new Error("Owner context is missing or not authorized");
    return ownerId;
  };

  // Full replacements and scoped writes use one transaction-local database lock,
  // preventing a replacement from interleaving with a concurrent scoped update.
  const lockPreferences = async (): Promise<void> => {
    await client.query("SELECT pg_advisory_xact_lock(127854, 2)");
  };

  const getAll = async (): Promise<ProviderPreferenceSet> => {
    const ownerId = await requireOwnerId();
    // Keep all three reads on one stable state while concurrent writers hold
    // the same transaction-local lock (READ COMMITTED otherwise snapshots each
    // SELECT independently).
    await lockPreferences();
    // A PoolClient executes one query at a time; keep the calls sequential to
    // avoid relying on pg's deprecated implicit query queueing behavior.
    const globalResult = await client.query<PreferenceRow>(
      `SELECT owner_id, selection_mode, provider_id, model_id, updated_at
       FROM nexus.global_provider_preferences WHERE owner_id = $1`,
      [ownerId],
    );
    const assistantResult = await client.query<AssistantPreferenceRow>(
      `SELECT owner_id, assistant_id, selection_mode, provider_id, model_id, updated_at
       FROM nexus.assistant_provider_preferences
       WHERE owner_id = $1 ORDER BY assistant_id`,
      [ownerId],
    );
    const conversationResult = await client.query<ConversationPreferenceRow>(
      `SELECT owner_id, conversation_id, selection_mode, provider_id, model_id, updated_at
       FROM nexus.conversation_provider_preferences
       WHERE owner_id = $1 ORDER BY conversation_id`,
      [ownerId],
    );

    const globalRow = globalResult.rows[0];
    if (!globalRow) {
      throw new Error("Global provider preference is missing; apply migration 00003");
    }

    const global: GlobalProviderPreference = {
      id: globalRow.owner_id,
      userId: globalRow.owner_id,
      selection: mapSelection(globalRow),
      updatedAt: globalRow.updated_at.toISOString(),
    };
    const byAssistant: AssistantProviderPreference[] = assistantResult.rows.map((row) => ({
      id: row.assistant_id,
      userId: row.owner_id,
      assistantId: row.assistant_id,
      selection: mapSelection(row),
      updatedAt: row.updated_at.toISOString(),
    }));
    const byConversation: ConversationProviderPreference[] = conversationResult.rows.map(
      (row) => ({
        userId: row.owner_id,
        conversationId: row.conversation_id,
        selection: mapSelection(row),
        updatedAt: row.updated_at.toISOString(),
      }),
    );
    return { global, byAssistant, byConversation };
  };

  const setGlobal = async (rawSelection: ProviderSelection): Promise<GlobalProviderPreference> => {
    const selection = providerSelectionSchema.parse(rawSelection);
    const ownerId = await requireOwnerId();
    await lockPreferences();
    const columns = selectionToColumns(selection);
    const result = await client.query<PreferenceRow>(
      `INSERT INTO nexus.global_provider_preferences
         (owner_id, selection_mode, provider_id, model_id, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (owner_id) DO UPDATE SET
         selection_mode = EXCLUDED.selection_mode,
         provider_id = EXCLUDED.provider_id,
         model_id = EXCLUDED.model_id,
         updated_at = now()
       RETURNING owner_id, selection_mode, provider_id, model_id, updated_at`,
      [ownerId, columns.selectionMode, columns.providerId, columns.modelId],
    );
    const row = result.rows[0]!;
    return {
      id: row.owner_id,
      userId: row.owner_id,
      selection: mapSelection(row),
      updatedAt: row.updated_at.toISOString(),
    };
  };

  const setAssistant = async (
    assistantId: string,
    rawSelection: ProviderSelection,
  ): Promise<AssistantProviderPreference> => {
    const selection = providerSelectionSchema.parse(rawSelection);
    const ownerId = await requireOwnerId();
    await lockPreferences();
    const columns = selectionToColumns(selection);
    const result = await client.query<AssistantPreferenceRow>(
      `INSERT INTO nexus.assistant_provider_preferences
         (owner_id, assistant_id, selection_mode, provider_id, model_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (assistant_id) DO UPDATE SET
         selection_mode = EXCLUDED.selection_mode,
         provider_id = EXCLUDED.provider_id,
         model_id = EXCLUDED.model_id,
         updated_at = now()
       RETURNING owner_id, assistant_id, selection_mode, provider_id, model_id, updated_at`,
      [ownerId, assistantId, columns.selectionMode, columns.providerId, columns.modelId],
    );
    const row = result.rows[0]!;
    return {
      id: row.assistant_id,
      userId: row.owner_id,
      assistantId: row.assistant_id,
      selection: mapSelection(row),
      updatedAt: row.updated_at.toISOString(),
    };
  };

  const setConversation = async (
    conversationId: string,
    rawSelection: ProviderSelection,
  ): Promise<ConversationProviderPreference> => {
    const selection = providerSelectionSchema.parse(rawSelection);
    const ownerId = await requireOwnerId();
    await lockPreferences();
    const columns = selectionToColumns(selection);
    const result = await client.query<ConversationPreferenceRow>(
      `INSERT INTO nexus.conversation_provider_preferences
         (owner_id, conversation_id, selection_mode, provider_id, model_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (conversation_id) DO UPDATE SET
         selection_mode = EXCLUDED.selection_mode,
         provider_id = EXCLUDED.provider_id,
         model_id = EXCLUDED.model_id,
         updated_at = now()
       RETURNING owner_id, conversation_id, selection_mode, provider_id, model_id, updated_at`,
      [ownerId, conversationId, columns.selectionMode, columns.providerId, columns.modelId],
    );
    const row = result.rows[0]!;
    return {
      userId: row.owner_id,
      conversationId: row.conversation_id,
      selection: mapSelection(row),
      updatedAt: row.updated_at.toISOString(),
    };
  };

  return {
    getAll,

    async resolve(context) {
      const preferences = await getAll();
      return resolveProviderSelection(preferences, context);
    },

    setGlobal,
    setAssistant,
    setConversation,

    async clearAssistant(assistantId: string): Promise<void> {
      const ownerId = await requireOwnerId();
      await lockPreferences();
      await client.query(
        `DELETE FROM nexus.assistant_provider_preferences
         WHERE owner_id = $1 AND assistant_id = $2`,
        [ownerId, assistantId],
      );
    },

    async clearConversation(conversationId: string): Promise<void> {
      const ownerId = await requireOwnerId();
      await lockPreferences();
      await client.query(
        `DELETE FROM nexus.conversation_provider_preferences
         WHERE owner_id = $1 AND conversation_id = $2`,
        [ownerId, conversationId],
      );
    },

    async replaceAll(rawPreferences: ProviderPreferenceSet): Promise<ProviderPreferenceSet> {
      const preferences = providerPreferenceSetSchema.parse(rawPreferences);
      const ownerId = await requireOwnerId();
      await lockPreferences();

      const scopedPreferences = [
        preferences.global,
        ...preferences.byAssistant,
        ...preferences.byConversation,
      ];
      if (scopedPreferences.some((preference) => preference.userId !== ownerId)) {
        throw new Error("Preference owner does not match the authenticated owner");
      }
      if (new Set(preferences.byAssistant.map((item) => item.assistantId)).size !== preferences.byAssistant.length) {
        throw new Error("Duplicate assistant preference scope");
      }
      if (new Set(preferences.byConversation.map((item) => item.conversationId)).size !== preferences.byConversation.length) {
        throw new Error("Duplicate conversation preference scope");
      }

      const globalColumns = selectionToColumns(preferences.global.selection);
      await client.query(
        `INSERT INTO nexus.global_provider_preferences
           (owner_id, selection_mode, provider_id, model_id, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (owner_id) DO UPDATE SET
           selection_mode = EXCLUDED.selection_mode,
           provider_id = EXCLUDED.provider_id,
           model_id = EXCLUDED.model_id,
           updated_at = now()`,
        [ownerId, globalColumns.selectionMode, globalColumns.providerId, globalColumns.modelId],
      );

      await client.query(
        `DELETE FROM nexus.assistant_provider_preferences WHERE owner_id = $1`,
        [ownerId],
      );
      for (const preference of preferences.byAssistant) {
        const columns = selectionToColumns(preference.selection);
        await client.query(
          `INSERT INTO nexus.assistant_provider_preferences
             (owner_id, assistant_id, selection_mode, provider_id, model_id, updated_at)
           VALUES ($1, $2, $3, $4, $5, now())`,
          [ownerId, preference.assistantId, columns.selectionMode, columns.providerId, columns.modelId],
        );
      }

      await client.query(
        `DELETE FROM nexus.conversation_provider_preferences WHERE owner_id = $1`,
        [ownerId],
      );
      for (const preference of preferences.byConversation) {
        const columns = selectionToColumns(preference.selection);
        await client.query(
          `INSERT INTO nexus.conversation_provider_preferences
             (owner_id, conversation_id, selection_mode, provider_id, model_id, updated_at)
           VALUES ($1, $2, $3, $4, $5, now())`,
          [ownerId, preference.conversationId, columns.selectionMode, columns.providerId, columns.modelId],
        );
      }

      return getAll();
    },
  };
}
