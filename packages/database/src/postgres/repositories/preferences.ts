import type { PoolClient } from "pg";
import type { ProviderPreferenceRepository } from "../../contracts.js";
import type { ProviderPreferenceSet } from "@nexus/shared";

/**
 * ProviderPreferenceRepository.
 *
 * LIMITATION (explicit, not silent):
 * The current migration (00001_initial_schema.sql) does not yet contain
 * dedicated tables for global / per-assistant / per-conversation provider
 * preferences that match the full ProviderPreferenceSet shape in
 * @nexus/shared. Therefore getAll and replaceAll cannot persist or load
 * real preference data without a new migration.
 *
 * Until a migration that introduces the preference tables is approved and
 * applied, these methods throw a clear error so callers do not believe data
 * is being stored.
 */
export function createProviderPreferenceRepository(
  _client: PoolClient,
): ProviderPreferenceRepository {
  return {
    async getAll(): Promise<ProviderPreferenceSet> {
      throw new Error(
        "ProviderPreferenceRepository.getAll is not implemented: preference tables are absent from the current schema migration. A follow-up migration is required.",
      );
    },

    async replaceAll(_preferences: ProviderPreferenceSet): Promise<ProviderPreferenceSet> {
      throw new Error(
        "ProviderPreferenceRepository.replaceAll is not implemented: preference tables are absent from the current schema migration. A follow-up migration is required.",
      );
    },
  };
}
