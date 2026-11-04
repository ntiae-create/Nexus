import type { PoolClient } from "pg";
import type { OwnerRepository } from "../../contracts.js";
import type { UserAccount } from "@nexus/shared";

export function createOwnerRepository(client: PoolClient): OwnerRepository {
  return {
    async getCurrent(): Promise<UserAccount | null> {
      const res = await client.query<{
        id: string;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT id, created_at, updated_at
         FROM nexus.owner_identity
         WHERE singleton = true
         LIMIT 1`,
      );
      const row = res.rows[0];
      if (!row) return null;
      return {
        userId: row.id,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      };
    },
  };
}
