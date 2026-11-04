import type { PoolClient } from "pg";
import type { NexusRepositories } from "../../contracts.js";
import { createOwnerRepository } from "./owner.js";
import { createConversationRepository } from "./conversations.js";
import { createMessageRepository } from "./messages.js";
import { createExecutionRepository } from "./executions.js";
import { createMemoryRepository } from "./memories.js";
import { createProviderPreferenceRepository } from "./preferences.js";
import { createSyncRepository } from "./sync.js";

/**
 * Builds the typed repository bag that is the ONLY surface given to business callbacks.
 * The PoolClient remains private; no raw query method is exposed.
 */
export function createRepositories(client: PoolClient): NexusRepositories {
  return {
    owner: createOwnerRepository(client),
    conversations: createConversationRepository(client),
    messages: createMessageRepository(client),
    executions: createExecutionRepository(client),
    memories: createMemoryRepository(client),
    providerPreferences: createProviderPreferenceRepository(client),
    sync: createSyncRepository(client),
  };
}
