import type { PoolClient } from "pg";
import type { SyncRepository } from "../../contracts.js";
import type { IncrementalSyncRequest, IncrementalSyncResponse } from "@nexus/shared";

/**
 * SyncRepository.
 *
 * LIMITATION (explicit, not silent):
 * Incremental sync requires a stable cursor protocol, tombstone retention
 * policy, and ordered change stream that are not fully defined in the
 * current schema/contracts for production use. The migration creates a
 * tombstone_entity_type enum and related structures, but the concrete
 * pullIncremental algorithm (cursor encoding, limit, ordering, hasMore)
 * still needs product-level decisions.
 *
 * This method therefore throws so that callers do not receive empty
 * responses that could be misinterpreted as "no changes".
 */
export function createSyncRepository(_client: PoolClient): SyncRepository {
  return {
    async pullIncremental(
      _input: IncrementalSyncRequest,
    ): Promise<IncrementalSyncResponse> {
      throw new Error(
        "SyncRepository.pullIncremental is not implemented: incremental sync cursor protocol and tombstone retention policy are not finalized. Do not treat an empty response as authoritative.",
      );
    },
  };
}
