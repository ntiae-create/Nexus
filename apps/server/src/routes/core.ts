import {
  coreExecutionRequestSchema,
  createConversationSchema,
  sendMessageSchema,
  uuidSchema,
  type ApiError,
  type JsonValue,
} from "@nexus/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import { ProviderError } from "../providers/index.js";
import { CoreExecutionError } from "../core/errors.js";
import type { NexusCoreEngine } from "../core/engine.js";

export interface CoreRoutesOptions {
  /** Omitted -> every core route answers 503 CORE_NOT_CONFIGURED. */
  readonly core?: NexusCoreEngine;
}

const listMessagesQuerySchema = z
  .object({
    afterSequence: z.coerce.number().int().min(0).optional(),
  })
  .strict();

const listExecutionsQuerySchema = z.object({}).strict();

const appendMessageBodySchema = z
  .object({
    content: sendMessageSchema.shape.content,
    requestId: sendMessageSchema.shape.requestId,
    idempotencyKey: sendMessageSchema.shape.idempotencyKey,
    metadata: sendMessageSchema.shape.metadata,
    /** When true (default) the message starts a NEXUS CORE execution. */
    execute: z.boolean().optional(),
    assistantId: sendMessageSchema.shape.assistantId,
    assistantKey: z.enum(["yui", "alice", "schwi"]).optional(),
  })
  .strict();

function buildApiError(
  code: string,
  message: string,
  options: { retryable: boolean; details?: Record<string, JsonValue>; requestId?: string },
): ApiError {
  return {
    error: {
      code,
      message,
      ...(options.details ? { details: options.details } : {}),
      ...(options.requestId ? { requestId: options.requestId } : {}),
      retryable: options.retryable,
    },
    timestamp: new Date().toISOString(),
  };
}

function notConfigured(reply: FastifyReply): FastifyReply {
  return reply
    .code(503)
    .send(
      buildApiError("CORE_NOT_CONFIGURED", "NEXUS CORE is not configured", {
        retryable: true,
      }),
    );
}

function sendRouteError(
  req: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof CoreExecutionError) {
    req.log.warn(
      {
        code: error.code,
        statusCode: error.statusCode,
        retryable: error.retryable,
      },
      "NEXUS CORE execution error",
    );
    return reply.code(error.statusCode).send(error.toApiError());
  }

  if (error instanceof ProviderError) {
    req.log.warn(
      {
        code: error.code,
        provider: error.providerKey,
        statusCode: error.statusCode,
        retryable: error.retryable,
      },
      "Provider failed during NEXUS CORE execution",
    );
    return reply.code(error.statusCode).send(error.toApiError());
  }

  if (error instanceof z.ZodError) {
    return reply.code(400).send(
      buildApiError("INVALID_REQUEST", "Request payload failed contract validation", {
        retryable: false,
        details: {
          issues: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      }),
    );
  }

  req.log.error({ err: error instanceof Error ? error.name : "unknown" }, "Unexpected NEXUS CORE failure");
  return reply.code(503).send(
    buildApiError("CORE_INTERNAL_FAILURE", "Failed to process NEXUS CORE request", {
      retryable: true,
    }),
  );
}

function parseId(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new CoreExecutionError("CONVERSATION_NOT_FOUND", "Conversation not found");
  }
  return parsed.data;
}

export async function registerCoreRoutes(
  app: FastifyInstance,
  options: CoreRoutesOptions = {},
): Promise<void> {
  app.get("/v1/conversations", { preHandler: requireAuth }, async (req, reply) => {
    if (!options.core) return notConfigured(reply);
    try {
      const conversations = await options.core.listConversations(req.session!.ownerId);
      return reply.code(200).send({ conversations: [...conversations] });
    } catch (error) {
      return sendRouteError(req, reply, error);
    }
  });

  app.post("/v1/conversations", { preHandler: requireAuth }, async (req, reply) => {
    if (!options.core) return notConfigured(reply);
    const parsed = createConversationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(
        buildApiError("INVALID_REQUEST", "Invalid conversation payload", {
          retryable: false,
          details: {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        }),
      );
    }
    try {
      const conversation = await options.core.createConversation(
        req.session!.ownerId,
        parsed.data,
      );
      return reply.code(201).send({ conversation });
    } catch (error) {
      return sendRouteError(req, reply, error);
    }
  });

  app.get<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!options.core) return notConfigured(reply);
      try {
        const conversation = await options.core.getConversation(
          req.session!.ownerId,
          parseId(req.params.conversationId),
        );
        return reply.code(200).send({ conversation });
      } catch (error) {
        return sendRouteError(req, reply, error);
      }
    },
  );

  app.get<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId/messages",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!options.core) return notConfigured(reply);
      const parsedQuery = listMessagesQuerySchema.safeParse(req.query ?? {});
      if (!parsedQuery.success) {
        return reply.code(400).send(
          buildApiError("INVALID_QUERY_PARAMETERS", "Invalid query parameters", {
            retryable: false,
          }),
        );
      }
      try {
        const messages = await options.core.listMessages(
          req.session!.ownerId,
          parseId(req.params.conversationId),
          parsedQuery.data.afterSequence,
        );
        return reply.code(200).send({ messages: [...messages] });
      } catch (error) {
        return sendRouteError(req, reply, error);
      }
    },
  );

  app.post<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId/messages",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!options.core) return notConfigured(reply);
      const parsedBody = appendMessageBodySchema.safeParse(req.body ?? {});
      if (!parsedBody.success) {
        return reply.code(400).send(
          buildApiError("INVALID_REQUEST", "Invalid message payload", {
            retryable: false,
            details: {
              issues: parsedBody.error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
              })),
            },
          }),
        );
      }

      const conversationId = parseId(req.params.conversationId);
      const body = parsedBody.data;
      const ownerId = req.session!.ownerId;

      try {
        if (body.execute === false) {
          const message = await options.core.appendUserMessage(ownerId, conversationId, {
            content: body.content,
            requestId: body.requestId,
            idempotencyKey: body.idempotencyKey,
            ...(body.metadata ? { metadata: body.metadata } : {}),
          });
          return reply.code(201).send({ message, execution: null });
        }

        const request = coreExecutionRequestSchema.parse({
          content: body.content,
          requestId: body.requestId,
          idempotencyKey: body.idempotencyKey,
          ...(body.assistantId ? { assistantId: body.assistantId } : {}),
          ...(body.assistantKey ? { assistantKey: body.assistantKey } : {}),
          ...(body.metadata ? { metadata: body.metadata } : {}),
        });

        const result = await options.core.execute({
          ownerId,
          conversationId,
          request,
        });
        return reply.code(result.replayed ? 200 : 201).send(result);
      } catch (error) {
        return sendRouteError(req, reply, error);
      }
    },
  );

  app.post<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId/executions",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!options.core) return notConfigured(reply);
      const parsed = coreExecutionRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(
          buildApiError("INVALID_REQUEST", "Invalid execution payload", {
            retryable: false,
            details: {
              issues: parsed.error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
              })),
            },
          }),
        );
      }
      try {
        const result = await options.core.execute({
          ownerId: req.session!.ownerId,
          conversationId: parseId(req.params.conversationId),
          request: parsed.data,
        });
        return reply.code(result.replayed ? 200 : 201).send(result);
      } catch (error) {
        return sendRouteError(req, reply, error);
      }
    },
  );

  app.get<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId/executions",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!options.core) return notConfigured(reply);
      const parsedQuery = listExecutionsQuerySchema.safeParse(req.query ?? {});
      if (!parsedQuery.success) {
        return reply.code(400).send(
          buildApiError("INVALID_QUERY_PARAMETERS", "Invalid query parameters", {
            retryable: false,
          }),
        );
      }
      try {
        const executions = await options.core.listExecutions(
          req.session!.ownerId,
          parseId(req.params.conversationId),
        );
        return reply.code(200).send({ executions: [...executions] });
      } catch (error) {
        return sendRouteError(req, reply, error);
      }
    },
  );

  app.get<{ Params: { runId: string } }>(
    "/v1/executions/:runId",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!options.core) return notConfigured(reply);
      const runId = uuidSchema.safeParse(req.params.runId);
      if (!runId.success) {
        return reply.code(404).send(
          buildApiError("EXECUTION_NOT_FOUND", "Execution not found", {
            retryable: false,
          }),
        );
      }
      try {
        const inspection = await options.core.inspect(req.session!.ownerId, runId.data);
        return reply.code(200).send(inspection);
      } catch (error) {
        return sendRouteError(req, reply, error);
      }
    },
  );

  app.post<{ Params: { runId: string } }>(
    "/v1/executions/:runId/cancel",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!options.core) return notConfigured(reply);
      const runId = uuidSchema.safeParse(req.params.runId);
      if (!runId.success) {
        return reply.code(404).send(
          buildApiError("EXECUTION_NOT_FOUND", "Execution not found", {
            retryable: false,
          }),
        );
      }
      try {
        const inspection = await options.core.cancel(req.session!.ownerId, runId.data);
        return reply.code(200).send(inspection);
      } catch (error) {
        return sendRouteError(req, reply, error);
      }
    },
  );
}

