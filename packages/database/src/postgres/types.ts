import type { PoolClient } from "pg";
import type { OwnerTransactionContext, NexusRepositories } from "../contracts.js";

/** Internal only — never exposed to business callbacks. */
export type InternalClient = PoolClient;

export type CreateRepositories = (client: InternalClient) => NexusRepositories;

export interface PostgresDatabaseOptions {
  connectionString: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  /** Optional application_name for observability */
  applicationName?: string;
}

export type { OwnerTransactionContext };
