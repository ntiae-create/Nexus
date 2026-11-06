import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import {
  coreRunSchema,
  runResultSchema,
  runStepSchema,
  runTransitionSchema,
  toolEventSchema,
  type CoreRun,
  type RunResult,
  type RunStep,
  type ToolEvent,
} from "@nexus/shared";
import type { ExecutionRepository } from "../../contracts.js";

interface CoreRunRow {
  id: string;
  owner_id: string;
  conversation_id: string;
  request_id: string;
  idempotency_key: string;
  status: CoreRun["status"];
  input_message_id: string;
  final_message_id: string | null;
  parent_run_id: string | null;
  parent_step_id: string | null;
  delegation_depth: number;
  trace: CoreRun["trace"];
  format_version: number;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  metadata: CoreRun["metadata"] | null;
}

interface RunStepRow {
  id: string;
  owner_id: string;
  run_id: string;
  step_order: number;
  assistant_id: string;
  assistant_key: string;
  assistant_config_version: string;
  status: RunStep["status"];
  objective: string;
  input_reference_ids: RunStep["inputReferenceIds"];
  result_id: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  metadata: RunStep["metadata"] | null;
}

interface RunResultRow {
  id: string;
  owner_id: string;
  run_id: string;
  step_id: string | null;
  status: RunResult["status"];
  content: RunResult["content"];
  references_data: RunResult["references"];
  format_version: number;
  created_at: Date;
  metadata: RunResult["metadata"] | null;
}

interface ToolEventRow {
  id: string;
  owner_id: string;
  run_id: string;
  step_id: string | null;
  tool_id: string;
  event_type: string;
  status: ToolEvent["status"];
  normalized_data: ToolEvent["normalizedData"];
  references_data: ToolEvent["references"];
  origin: string;
  occurred_at: Date;
  format_version: number;
  metadata: ToolEvent["metadata"] | null;
}

const runColumns = `
  id, owner_id, conversation_id, request_id, idempotency_key, status,
  input_message_id, final_message_id, parent_run_id, parent_step_id, delegation_depth,
  trace, format_version, created_at, started_at, finished_at, metadata
`;

function mapRun(row: CoreRunRow, assistantIds: string[]): CoreRun {
  const hasMetadata =
    row.metadata !== null &&
    typeof row.metadata === "object" &&
    Object.keys(row.metadata).length > 0;

  return {
    id: row.id,
    userId: row.owner_id,
    conversationId: row.conversation_id,
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    assistantIds,
    trace: row.trace ?? [],
    inputMessageId: row.input_message_id,
    finalMessageId: row.final_message_id ?? undefined,
    ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
    ...(row.parent_step_id ? { parentStepId: row.parent_step_id } : {}),
    ...(row.parent_run_id || row.delegation_depth > 0
      ? { delegationDepth: row.delegation_depth }
      : {}),
    startedAt: row.started_at?.toISOString(),
    finishedAt: row.finished_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
    formatVersion: row.format_version,
    ...(hasMetadata ? { metadata: row.metadata! } : {}),
  };
}

function mapStep(row: RunStepRow): RunStep {
  return {
    id: row.id,
    userId: row.owner_id,
    runId: row.run_id,
    order: row.step_order,
    assistant: {
      assistantId: row.assistant_id,
      assistantKey: row.assistant_key,
      configVersion: row.assistant_config_version,
    },
    status: row.status,
    objective: row.objective,
    inputReferenceIds: row.input_reference_ids ?? [],
    resultId: row.result_id ?? undefined,
    startedAt: row.started_at?.toISOString(),
    finishedAt: row.finished_at?.toISOString(),
    metadata: row.metadata ?? undefined,
  };
}

function mapResult(row: RunResultRow): RunResult {
  return {
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
  };
}

function mapToolEvent(row: ToolEventRow): ToolEvent {
  return {
    id: row.id,
    userId: row.owner_id,
    runId: row.run_id,
    stepId: row.step_id ?? undefined,
    tool: row.tool_id,
    eventType: row.event_type,
    status: row.status,
    normalizedData: row.normalized_data,
    references: row.references_data ?? [],
    origin: row.origin,
    occurredAt: row.occurred_at.toISOString(),
    formatVersion: row.format_version,
    metadata: row.metadata ?? undefined,
  };
}

const terminalRunStatuses: ReadonlySet<CoreRun["status"]> = new Set([
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);

const terminalStepStatuses: ReadonlySet<RunStep["status"]> = new Set([
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
]);

export function createExecutionRepository(client: PoolClient): ExecutionRepository {
  let savepointSequence = 0;

  const withStatementSavepoint = async <T>(operation: () => Promise<T>): Promise<T> => {
    savepointSequence += 1;
    const savepoint = `nexus_execution_sp_${savepointSequence}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      const value = await operation();
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return value;
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  };

  const getRunRow = async (runId: string, forUpdate = false): Promise<CoreRunRow | null> => {
    const result = await client.query<CoreRunRow>(
      `SELECT ${runColumns} FROM nexus.core_runs WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [runId],
    );
    return result.rows[0] ?? null;
  };

  const getAssistantIds = async (runId: string): Promise<string[]> => {
    const result = await client.query<{ assistant_id: string }>(
      `SELECT assistant_id FROM nexus.core_run_assistants
       WHERE run_id = $1 ORDER BY position`,
      [runId],
    );
    return result.rows.map((row) => row.assistant_id);
  };

  const hydrateRows = async (rows: readonly CoreRunRow[]): Promise<readonly CoreRun[]> => {
    if (rows.length === 0) return [];
    const runIds = rows.map((row) => row.id);
    const assistantsResult = await client.query<{ run_id: string; assistant_id: string }>(
      `SELECT run_id, assistant_id
       FROM nexus.core_run_assistants
       WHERE run_id = ANY($1::uuid[])
       ORDER BY run_id, position`,
      [runIds],
    );
    const assistantsByRun = new Map<string, string[]>();
    for (const item of assistantsResult.rows) {
      const existing = assistantsByRun.get(item.run_id);
      if (existing) {
        existing.push(item.assistant_id);
      } else {
        assistantsByRun.set(item.run_id, [item.assistant_id]);
      }
    }
    return rows.map((row) => mapRun(row, assistantsByRun.get(row.id) ?? []));
  };

  const getById = async (runId: string): Promise<CoreRun | null> => {
    const row = await getRunRow(runId);
    return row ? mapRun(row, await getAssistantIds(runId)) : null;
  };

  const getByIdempotencyKey = async (idempotencyKey: string): Promise<CoreRun | null> => {
    const result = await client.query<CoreRunRow>(
      `SELECT ${runColumns} FROM nexus.core_runs WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row ? mapRun(row, await getAssistantIds(row.id)) : null;
  };

  const listByConversation = async (conversationId: string): Promise<readonly CoreRun[]> => {
    const result = await client.query<CoreRunRow>(
      `SELECT ${runColumns}
       FROM nexus.core_runs
       WHERE conversation_id = $1
       ORDER BY created_at ASC, id ASC`,
      [conversationId],
    );
    return hydrateRows(result.rows);
  };

  const listChildRuns = async (parentRunId: string): Promise<readonly CoreRun[]> => {
    const result = await client.query<CoreRunRow>(
      `SELECT ${runColumns}
       FROM nexus.core_runs
       WHERE parent_run_id = $1
       ORDER BY created_at ASC, id ASC`,
      [parentRunId],
    );
    return hydrateRows(result.rows);
  };

  const lockMutableRun = async (runId: string, userId: string): Promise<CoreRunRow> => {
    const result = await client.query<
      CoreRunRow & { authenticated_owner_id: string | null }
    >(
      `SELECT ${runColumns},
              CASE
                WHEN nexus.current_owner_id() = nexus.configured_owner_id()
                  AND nexus.current_actor_type() = 'owner'
                  THEN nexus.current_owner_id()
              END AS authenticated_owner_id
       FROM nexus.core_runs
       WHERE id = $1
       FOR UPDATE`,
      [runId],
    );
    const row = result.rows[0];
    if (!row || !row.authenticated_owner_id || row.owner_id !== row.authenticated_owner_id) {
      throw new Error("Execution not found or not accessible");
    }
    if (row.owner_id !== userId) {
      throw new Error("Execution owner does not match the payload");
    }
    if (terminalRunStatuses.has(row.status)) {
      throw new Error(`Terminal executions are immutable (status: ${row.status})`);
    }
    return row;
  };

  const replaceAssistants = async (run: CoreRun): Promise<void> => {
    await client.query(`DELETE FROM nexus.core_run_assistants WHERE run_id = $1`, [run.id]);
    for (const [position, assistantId] of run.assistantIds.entries()) {
      await client.query(
        `INSERT INTO nexus.core_run_assistants (owner_id, run_id, assistant_id, position)
         VALUES (nexus.current_owner_id(), $1, $2, $3)`,
        [run.id, assistantId, position],
      );
    }
  };

  const updateInternal = async (rawRun: CoreRun): Promise<CoreRun> => {
    const run = coreRunSchema.parse(rawRun);
    const existingResult = await client.query<
      CoreRunRow & { authenticated_owner_id: string | null }
    >(
      `SELECT ${runColumns},
              CASE
                WHEN nexus.current_owner_id() = nexus.configured_owner_id()
                  AND nexus.current_actor_type() = 'owner'
                  THEN nexus.current_owner_id()
              END AS authenticated_owner_id
       FROM nexus.core_runs
       WHERE id = $1
       FOR UPDATE`,
      [run.id],
    );
    const existingRow = existingResult.rows[0];
    if (
      !existingRow ||
      !existingRow.authenticated_owner_id ||
      existingRow.owner_id !== existingRow.authenticated_owner_id
    ) {
      throw new Error("Execution not found or not accessible");
    }
    const existing = mapRun(existingRow, await getAssistantIds(run.id));

    const existingDepth = existing.delegationDepth ?? 0;
    const incomingDepth = run.delegationDepth ?? 0;

    const sameIdentity =
      existing.userId === run.userId &&
      existing.conversationId === run.conversationId &&
      existing.requestId === run.requestId &&
      existing.idempotencyKey === run.idempotencyKey &&
      existing.inputMessageId === run.inputMessageId &&
      existing.parentRunId === run.parentRunId &&
      existing.parentStepId === run.parentStepId &&
      existingDepth === incomingDepth &&
      existing.formatVersion === run.formatVersion &&
      Date.parse(existing.createdAt) === Date.parse(run.createdAt);
    if (!sameIdentity) throw new Error("Execution identity fields are immutable");

    if (terminalRunStatuses.has(existing.status)) {
      throw new Error(`Terminal executions are immutable (status: ${existing.status})`);
    }
    if (isDeepStrictEqual(existing, run)) return existing;
    if (existing.status !== run.status) {
      runTransitionSchema.parse({ from: existing.status, to: run.status });
    }

    await client.query(
      `UPDATE nexus.core_runs
       SET status = $2,
           final_message_id = $3,
           trace = $4::jsonb,
           started_at = $5,
           finished_at = $6,
           metadata = $7::jsonb
       WHERE id = $1`,
      [
        run.id,
        run.status,
        run.finalMessageId ?? null,
        JSON.stringify(run.trace),
        run.startedAt ?? null,
        run.finishedAt ?? null,
        JSON.stringify(run.metadata ?? existing.metadata ?? {}),
      ],
    );
    if (!isDeepStrictEqual(existing.assistantIds, run.assistantIds)) {
      await replaceAssistants(run);
    }

    const updated = await getById(run.id);
    if (!updated) throw new Error("Failed to load execution after update");
    return updated;
  };

  const listSteps = async (runId: string): Promise<readonly RunStep[]> => {
    const result = await client.query<RunStepRow>(
      `SELECT step.id, step.owner_id, step.run_id, step.step_order,
              step.assistant_id, assistant.assistant_key, step.assistant_config_version,
              step.status, step.objective, step.input_reference_ids, step.result_id,
              step.started_at, step.finished_at, step.metadata
       FROM nexus.run_steps AS step
       JOIN nexus.assistants AS assistant ON assistant.id = step.assistant_id
       WHERE step.run_id = $1
       ORDER BY step.step_order, step.id`,
      [runId],
    );
    return result.rows.map(mapStep);
  };

  const listResults = async (runId: string): Promise<readonly RunResult[]> => {
    const result = await client.query<RunResultRow>(
      `SELECT id, owner_id, run_id, step_id, status, content, references_data,
              format_version, created_at, metadata
       FROM nexus.run_results WHERE run_id = $1
       ORDER BY created_at, id`,
      [runId],
    );
    return result.rows.map(mapResult);
  };

  const listToolEvents = async (runId: string): Promise<readonly ToolEvent[]> => {
    const result = await client.query<ToolEventRow>(
      `SELECT id, owner_id, run_id, step_id, tool_id, event_type, status,
              normalized_data, references_data, origin, occurred_at, format_version, metadata
       FROM nexus.tool_events WHERE run_id = $1
       ORDER BY occurred_at, id`,
      [runId],
    );
    return result.rows.map(mapToolEvent);
  };

  return {
    getById,
    getByIdempotencyKey,
    listByConversation,
    listChildRuns,

    async create(rawRun: CoreRun): Promise<CoreRun> {
      const run = coreRunSchema.parse(rawRun);
      const owner = await client.query<{ owner_id: string | null }>(
        `SELECT nexus.current_owner_id() AS owner_id`,
      );
      if (owner.rows[0]?.owner_id !== run.userId) {
        throw new Error("Execution owner does not match the authenticated owner");
      }

      const delegationDepth = run.parentRunId ? (run.delegationDepth ?? 1) : 0;

      await client.query(
        `INSERT INTO nexus.core_runs (
           id, owner_id, conversation_id, request_id, idempotency_key, status,
           input_message_id, final_message_id, parent_run_id, parent_step_id, delegation_depth,
           trace, format_version, created_at, started_at, finished_at, metadata
         ) VALUES (
           $1, nexus.current_owner_id(), $2, $3, $4, $5,
           $6, $7, $8, $9, $10,
           $11::jsonb, $12, $13, $14, $15, $16::jsonb
         )`,
        [
          run.id,
          run.conversationId,
          run.requestId,
          run.idempotencyKey,
          run.status,
          run.inputMessageId,
          run.finalMessageId ?? null,
          run.parentRunId ?? null,
          run.parentStepId ?? null,
          delegationDepth,
          JSON.stringify(run.trace),
          run.formatVersion,
          run.createdAt,
          run.startedAt ?? null,
          run.finishedAt ?? null,
          JSON.stringify(run.metadata ?? {}),
        ],
      );
      await replaceAssistants(run);

      const created = await getById(run.id);
      if (!created) throw new Error("Failed to load execution after create");
      return created;
    },

    update: updateInternal,

    async complete(runId, completion): Promise<CoreRun> {
      const existingRow = await getRunRow(runId, true);
      if (!existingRow) throw new Error("Execution not found or not accessible");
      const existing = mapRun(existingRow, await getAssistantIds(runId));
      const finishedAt = completion.finishedAt ?? new Date().toISOString();
      return updateInternal({
        ...existing,
        status: "succeeded",
        finalMessageId: completion.finalMessageId,
        startedAt: existing.startedAt ?? finishedAt,
        finishedAt,
      });
    },

    async fail(runId, failure = {}): Promise<CoreRun> {
      const existingRow = await getRunRow(runId, true);
      if (!existingRow) throw new Error("Execution not found or not accessible");
      const existing = mapRun(existingRow, await getAssistantIds(runId));
      const finishedAt = failure.finishedAt ?? new Date().toISOString();
      const mergedMetadata = failure.metadata
        ? { ...(existing.metadata ?? {}), ...failure.metadata }
        : existing.metadata;
      return updateInternal({
        ...existing,
        status: "failed",
        finalMessageId: failure.finalMessageId,
        startedAt: existing.startedAt ?? finishedAt,
        finishedAt,
        ...(mergedMetadata ? { metadata: mergedMetadata } : {}),
      });
    },

    async cancel(runId, cancellation = {}): Promise<CoreRun> {
      const existingRow = await getRunRow(runId, true);
      if (!existingRow) throw new Error("Execution not found or not accessible");
      const existing = mapRun(existingRow, await getAssistantIds(runId));
      const finishedAt = cancellation.finishedAt ?? new Date().toISOString();
      const mergedMetadata = cancellation.metadata
        ? { ...(existing.metadata ?? {}), ...cancellation.metadata }
        : existing.metadata;
      return updateInternal({
        ...existing,
        status: "cancelled",
        startedAt: existing.startedAt ?? finishedAt,
        finishedAt,
        ...(mergedMetadata ? { metadata: mergedMetadata } : {}),
      });
    },

    async appendStep(rawStep: RunStep): Promise<RunStep> {
      const step = runStepSchema.parse(rawStep);
      await lockMutableRun(step.runId, step.userId);
      return withStatementSavepoint(async () => {
        const assistant = await client.query(
          `SELECT assistant.id
           FROM nexus.assistants AS assistant
           JOIN nexus.assistant_config_versions AS version
             ON version.assistant_id = assistant.id
           WHERE assistant.id = $1
             AND assistant.assistant_key = $2
             AND version.config_version = $3`,
          [step.assistant.assistantId, step.assistant.assistantKey, step.assistant.configVersion],
        );
        if (!assistant.rows[0]) {
          throw new Error("RunStep assistant reference does not match the assistant catalog");
        }
        await client.query(
          `INSERT INTO nexus.run_steps (
             id, owner_id, run_id, step_order, assistant_id, assistant_config_version,
             status, objective, input_reference_ids, result_id, started_at, finished_at, metadata
           ) VALUES (
             $1, nexus.current_owner_id(), $2, $3, $4, $5,
             $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb
           )`,
          [
            step.id,
            step.runId,
            step.order,
            step.assistant.assistantId,
            step.assistant.configVersion,
            step.status,
            step.objective,
            JSON.stringify(step.inputReferenceIds),
            step.resultId ?? null,
            step.startedAt ?? null,
            step.finishedAt ?? null,
            JSON.stringify(step.metadata ?? {}),
          ],
        );
        const persisted = (await listSteps(step.runId)).find((item) => item.id === step.id);
        if (!persisted) throw new Error("Failed to load execution step after append");
        return persisted;
      });
    },

    async updateStep(rawStep: RunStep): Promise<RunStep> {
      const step = runStepSchema.parse(rawStep);
      await lockMutableRun(step.runId, step.userId);
      return withStatementSavepoint(async () => {
        const existingResult = await client.query<{
          step_order: number;
          assistant_id: string;
          assistant_config_version: string;
          status: RunStep["status"];
          result_id: string | null;
        }>(
          `SELECT step_order, assistant_id, assistant_config_version, status, result_id
           FROM nexus.run_steps
           WHERE run_id = $1 AND id = $2
           FOR UPDATE`,
          [step.runId, step.id],
        );
        const existingStep = existingResult.rows[0];
        if (!existingStep) {
          throw new Error("Execution step not found in this execution");
        }
        if (
          existingStep.step_order !== step.order ||
          existingStep.assistant_id !== step.assistant.assistantId ||
          existingStep.assistant_config_version !== step.assistant.configVersion
        ) {
          throw new Error("Execution step identity fields are immutable");
        }
        if (terminalStepStatuses.has(existingStep.status) && existingStep.status !== step.status) {
          throw new Error(`Terminal execution steps are immutable (status: ${existingStep.status})`);
        }
        await client.query(
          `UPDATE nexus.run_steps
           SET status = $3,
               objective = $4,
               input_reference_ids = $5::jsonb,
               started_at = $6,
               finished_at = $7,
               metadata = $8::jsonb
           WHERE run_id = $1 AND id = $2`,
          [
            step.runId,
            step.id,
            step.status,
            step.objective,
            JSON.stringify(step.inputReferenceIds),
            step.startedAt ?? null,
            step.finishedAt ?? null,
            JSON.stringify(step.metadata ?? {}),
          ],
        );
        const persisted = (await listSteps(step.runId)).find((item) => item.id === step.id);
        if (!persisted) throw new Error("Failed to load execution step after update");
        return persisted;
      });
    },

    listSteps,

    async recordToolEvent(rawEvent: ToolEvent): Promise<ToolEvent> {
      const event = toolEventSchema.parse(rawEvent);
      await lockMutableRun(event.runId, event.userId);
      return withStatementSavepoint(async () => {
        await client.query(
          `INSERT INTO nexus.tool_events (
             id, owner_id, run_id, step_id, tool_id, tool_version, event_type, status,
             normalized_data, references_data, origin, occurred_at, format_version, metadata
           ) VALUES (
             $1, nexus.current_owner_id(), $2, $3, $4, '1', $5, $6,
             $7::jsonb, $8::jsonb, $9, $10, $11, $12::jsonb
           )`,
          [
            event.id,
            event.runId,
            event.stepId ?? null,
            event.tool,
            event.eventType,
            event.status,
            JSON.stringify(event.normalizedData),
            JSON.stringify(event.references),
            event.origin,
            event.occurredAt,
            event.formatVersion,
            JSON.stringify(event.metadata ?? {}),
          ],
        );
        const persisted = (await listToolEvents(event.runId)).find((item) => item.id === event.id);
        if (!persisted) throw new Error("Failed to load tool event after append");
        return persisted;
      });
    },

    listToolEvents,

    async recordResult(rawResult: RunResult): Promise<RunResult> {
      const result = runResultSchema.parse(rawResult);
      await lockMutableRun(result.runId, result.userId);

      return withStatementSavepoint(async () => {
        if (!result.stepId) {
          const inserted = await client.query<RunResultRow>(
            `INSERT INTO nexus.run_results (
               id, owner_id, run_id, step_id, status, content, references_data,
               format_version, created_at, metadata
             ) VALUES (
               $1, nexus.current_owner_id(), $2, NULL, $3, $4::jsonb, $5::jsonb,
               $6, $7, $8::jsonb
             )
             RETURNING id, owner_id, run_id, step_id, status, content, references_data,
                       format_version, created_at, metadata`,
            [
              result.id,
              result.runId,
              result.status,
              JSON.stringify(result.content),
              JSON.stringify(result.references),
              result.formatVersion,
              result.createdAt,
              JSON.stringify(result.metadata ?? {}),
            ],
          );
          const row = inserted.rows[0];
          if (!row) throw new Error("Failed to load execution result after append");
          return mapResult(row);
        }

        const linkedInsert = await client.query<
          Partial<RunResultRow> & {
            matched_steps: number;
            linked_steps: number;
          }
        >(
          `WITH target_step AS (
             SELECT id, result_id
             FROM nexus.run_steps
             WHERE run_id = $2
               AND id = $3
               AND owner_id = nexus.current_owner_id()
             FOR UPDATE
           ),
           linked_step AS (
             UPDATE nexus.run_steps AS step
             SET result_id = $1
             FROM target_step
             WHERE step.run_id = $2
               AND step.id = target_step.id
               AND target_step.result_id IS NULL
             RETURNING step.id
           ),
           inserted_result AS (
             INSERT INTO nexus.run_results (
               id, owner_id, run_id, step_id, status, content, references_data,
               format_version, created_at, metadata
             )
             SELECT
               $1, nexus.current_owner_id(), $2, linked_step.id, $4, $5::jsonb, $6::jsonb,
               $7, $8, $9::jsonb
             FROM linked_step
             RETURNING id, owner_id, run_id, step_id, status, content, references_data,
                       format_version, created_at, metadata
           )
           SELECT
             (SELECT count(*)::int FROM target_step) AS matched_steps,
             (SELECT count(*)::int FROM linked_step) AS linked_steps,
             inserted_result.id,
             inserted_result.owner_id,
             inserted_result.run_id,
             inserted_result.step_id,
             inserted_result.status,
             inserted_result.content,
             inserted_result.references_data,
             inserted_result.format_version,
             inserted_result.created_at,
             inserted_result.metadata
           FROM (SELECT 1) AS anchor
           LEFT JOIN inserted_result ON true`,
          [
            result.id,
            result.runId,
            result.stepId,
            result.status,
            JSON.stringify(result.content),
            JSON.stringify(result.references),
            result.formatVersion,
            result.createdAt,
            JSON.stringify(result.metadata ?? {}),
          ],
        );

        const outcome = linkedInsert.rows[0];
        if (!outcome || outcome.matched_steps === 0) {
          throw new Error("Execution step not found in this execution");
        }
        if (outcome.linked_steps === 0 || !outcome.id) {
          throw new Error("Execution step is already linked to a different result");
        }
        return mapResult(outcome as RunResultRow);
      });
    },

    listResults,
  };
}
