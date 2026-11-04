import type { PoolClient } from "pg";
import type { ExecutionRepository } from "../../contracts.js";
import type { CoreRun, RunStep, ToolEvent, RunResult } from "@nexus/shared";

/**
 * ExecutionRepository — partial concrete implementation.
 *
 * LIMITATIONS (documented, not silent):
 * - CoreRun.assistantIds and CoreRun.trace are not stored as first-class columns
 *   in the current migration; the DB has conversation-level assistants and
 *   run_steps with assistant_id. Full reconstruction of the shared CoreRun
 *   shape requires additional joins that are not yet finalized.
 * - RunStep.assistant is an AssistantReference object in shared types; the
 *   table stores assistant_id + assistant_config_version. Mapping is lossy
 *   until a join to assistants is standardized.
 * - Therefore create / appendStep / record* perform parameterized writes of
 *   the columns that exist, and getById / listResults return the best
 *   structural mapping possible. Callers must not assume complete fidelity
 *   of complex nested fields until a follow-up migration or view is approved.
 */
export function createExecutionRepository(client: PoolClient): ExecutionRepository {
  return {
    async getById(runId: string): Promise<CoreRun | null> {
      const res = await client.query(
        `SELECT id, owner_id, conversation_id, request_id, idempotency_key, status,
                input_message_id, final_message_id, format_version,
                created_at, started_at, finished_at, metadata
         FROM nexus.core_runs WHERE id = $1`,
        [runId],
      );
      const row = res.rows[0];
      if (!row) return null;

      // assistantIds / trace are not fully reconstructible from core_runs alone.
      // Return a CoreRun with empty arrays and document the gap.
      return {
        id: row.id,
        userId: row.owner_id,
        conversationId: row.conversation_id,
        requestId: row.request_id,
        idempotencyKey: row.idempotency_key,
        status: row.status,
        assistantIds: [],
        trace: [],
        inputMessageId: row.input_message_id,
        finalMessageId: row.final_message_id ?? undefined,
        startedAt: row.started_at?.toISOString(),
        finishedAt: row.finished_at?.toISOString(),
        createdAt: row.created_at.toISOString(),
        formatVersion: row.format_version,
      };
    },

    async create(run: CoreRun): Promise<CoreRun> {
      await client.query(
        `INSERT INTO nexus.core_runs (
           id, owner_id, conversation_id, request_id, idempotency_key, status,
           input_message_id, format_version, metadata
         ) VALUES (
           $1, nexus.current_owner_id(), $2, $3, $4, $5,
           $6, $7, $8::jsonb
         )`,
        [
          run.id,
          run.conversationId,
          run.requestId,
          run.idempotencyKey,
          run.status,
          run.inputMessageId,
          run.formatVersion,
          JSON.stringify({}),
        ],
      );
      return run;
    },

    async appendStep(step: RunStep): Promise<RunStep> {
      const assistantId = step.assistant?.assistantId;
      if (!assistantId) {
        throw new Error(
          "RunStep.assistant.assistantId is required for persistence; shared AssistantReference mapping is incomplete",
        );
      }
      await client.query(
        `INSERT INTO nexus.run_steps (
           id, owner_id, run_id, step_order, assistant_id, assistant_config_version,
           status, objective, input_reference_ids, metadata
         ) VALUES (
           $1, nexus.current_owner_id(), $2, $3, $4, $5,
           $6, $7, $8::jsonb, $9::jsonb
         )`,
        [
          step.id,
          step.runId,
          step.order,
          assistantId,
          step.assistant?.configVersion ?? "1.0.0",
          step.status,
          step.objective,
          JSON.stringify(step.inputReferenceIds ?? []),
          JSON.stringify(step.metadata ?? {}),
        ],
      );
      return step;
    },

    async recordToolEvent(event: ToolEvent): Promise<ToolEvent> {
      await client.query(
        `INSERT INTO nexus.tool_events (
           id, owner_id, run_id, step_id, tool_id, tool_version, event_type, status,
           normalized_data, references_data, origin, format_version, metadata
         ) VALUES (
           $1, nexus.current_owner_id(), $2, $3, $4, $5, $6, $7,
           $8::jsonb, $9::jsonb, $10, $11, $12::jsonb
         )`,
        [
          event.id,
          event.runId,
          event.stepId ?? null,
          event.tool,
          "1",
          event.eventType,
          event.status,
          JSON.stringify(event.normalizedData ?? {}),
          JSON.stringify(event.references ?? []),
          event.origin,
          event.formatVersion,
          JSON.stringify(event.metadata ?? {}),
        ],
      );
      return event;
    },

    async recordResult(result: RunResult): Promise<RunResult> {
      await client.query(
        `INSERT INTO nexus.run_results (
           id, owner_id, run_id, step_id, status, content, references_data,
           format_version, metadata
         ) VALUES (
           $1, nexus.current_owner_id(), $2, $3, $4, $5::jsonb, $6::jsonb,
           $7, $8::jsonb
         )`,
        [
          result.id,
          result.runId,
          result.stepId ?? null,
          result.status,
          JSON.stringify(result.content ?? []),
          JSON.stringify(result.references ?? []),
          result.formatVersion,
          JSON.stringify(result.metadata ?? {}),
        ],
      );
      return result;
    },

    async listResults(runId: string): Promise<readonly RunResult[]> {
      const res = await client.query(
        `SELECT id, owner_id, run_id, step_id, status, content, references_data,
                format_version, created_at, metadata
         FROM nexus.run_results WHERE run_id = $1 ORDER BY created_at`,
        [runId],
      );
      return res.rows.map((row) => ({
        id: row.id,
        userId: row.owner_id,
        runId: row.run_id,
        stepId: row.step_id ?? undefined,
        status: row.status,
        content: row.content,
        references: row.references_data ?? [],
        formatVersion: row.format_version,
        createdAt: row.created_at.toISOString(),
        metadata: row.metadata ?? undefined,
      }));
    },
  };
}
