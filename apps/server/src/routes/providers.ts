import {
  getAssistantProfileById,
  getAssistantProfileByKey,
} from "@nexus/assistant-profiles";
import {
  initialAssistantKeySchema,
  modelCapabilitySchema,
  modelParameterNameSchema,
  uuidSchema,
  type ApiError,
  type JsonValue,
  type ModelCapability,
  type ModelParameterName,
  type ProviderPreferenceSet,
} from "@nexus/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import type { PostgresNexusDatabase } from "../database.js";
import {
  createDefaultProviderRuntime,
  DEFAULT_PROVIDER_PREFERENCE_SET,
  OPENROUTER_PROVIDER_ID,
  OPENROUTER_PROVIDER_KEY,
  OPENROUTER_SUPPORTED_CAPABILITIES,
  OPENROUTER_SUPPORTED_PARAMETERS,
  ProviderError,
  createProviderCatalogService,
  createModelSelectionService,
  type ProviderAdapter,
  type ProviderRuntime,
  type ProviderRuntimeEnv,
} from "../providers/index.js";

export class ResourceNotFoundRouteError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ResourceNotFoundRouteError";
    this.code = code;
  }
}

export interface PreferenceReadInput {
  readonly ownerId: string;
  readonly conversationId?: string;
}

export type ProviderPreferenceReader = (
  input: PreferenceReadInput,
) => Promise<ProviderPreferenceSet>;

export interface ProviderRoutesOptions {
  readonly runtime?: ProviderRuntime;
  readonly env?: ProviderRuntimeEnv;
  readonly readPreferences?: ProviderPreferenceReader;
}

function buildFallbackMisconfiguredRuntime(err: ProviderError): ProviderRuntime {
  const brokenAdapter: ProviderAdapter = {
    id: OPENROUTER_PROVIDER_ID,
    key: OPENROUTER_PROVIDER_KEY,
    name: "OpenRouter",
    kind: "cloud",
    supportedCapabilities: OPENROUTER_SUPPORTED_CAPABILITIES,
    supportedParameters: OPENROUTER_SUPPORTED_PARAMETERS,
    isConfigured: () => false,
    getStatus: () => ({
      provider: {
        id: OPENROUTER_PROVIDER_ID,
        key: OPENROUTER_PROVIDER_KEY,
        name: "OpenRouter",
        kind: "cloud",
      },
      configured: false,
      availability: "unavailable",
      costPolicy: "free_only",
      costStatus: "unknown",
      capabilities: OPENROUTER_SUPPORTED_CAPABILITIES,
      supportedParameters: OPENROUTER_SUPPORTED_PARAMETERS,
      unavailableReason: "provider_misconfigured",
    }),
    listModels: async () => {
      throw err;
    },
    verifyModelEligibility: async () => {
      throw err;
    },
    generate: async () => {
      throw err;
    },
    complete: async () => {
      throw err;
    },
  };
  const catalog = createProviderCatalogService({ adapters: [brokenAdapter] });
  const selection = createModelSelectionService({ catalog });
  return {
    adapters: [brokenAdapter],
    catalog,
    selection,
  };
}

function resolveRuntime(options: ProviderRoutesOptions): ProviderRuntime {
  if (options.runtime) {
    return options.runtime;
  }
  try {
    return createDefaultProviderRuntime({ env: options.env });
  } catch (err) {
    if (err instanceof ProviderError) {
      return buildFallbackMisconfiguredRuntime(err);
    }
    throw err;
  }
}

const booleanFlagQuerySchema = z
  .enum(["true", "false"])
  .transform((val) => val === "true")
  .optional();

const listProvidersQuerySchema = z
  .object({
    refresh: booleanFlagQuerySchema,
  })
  .strict();

const listEligibleModelsQuerySchema = z
  .object({
    provider: z.string().trim().min(1).max(64).optional(),
    capability: modelCapabilitySchema.optional(),
    refresh: booleanFlagQuerySchema,
  })
  .strict();

function splitCsvValues(raw: string | readonly string[] | undefined): string[] {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const selectionQuerySchema = z
  .object({
    assistantId: z.string().trim().min(1).max(64).optional(),
    conversationId: uuidSchema.optional(),
    capability: z.union([z.string(), z.array(z.string())]).optional(),
    parameter: z.union([z.string(), z.array(z.string())]).optional(),
    refresh: booleanFlagQuerySchema,
  })
  .strict();

function buildApiError(
  code: string,
  message: string,
  options: {
    retryable: boolean;
    details?: Record<string, JsonValue>;
  },
): ApiError {
  return {
    error: {
      code,
      message,
      retryable: options.retryable,
      ...(options.details ? { details: options.details } : {}),
    },
    timestamp: new Date().toISOString(),
  };
}

function resolveCanonicalAssistantId(rawAssistantRef: string): string {
  const uuidParsed = uuidSchema.safeParse(rawAssistantRef);
  if (uuidParsed.success) {
    const profile = getAssistantProfileById(uuidParsed.data);
    if (!profile) {
      throw new ResourceNotFoundRouteError(
        "ASSISTANT_NOT_FOUND",
        `Assistant '${uuidParsed.data}' does not exist`,
      );
    }
    return profile.id;
  }

  const keyParsed = initialAssistantKeySchema.safeParse(
    rawAssistantRef.toLowerCase(),
  );
  if (keyParsed.success) {
    const profile = getAssistantProfileByKey(keyParsed.data);
    if (profile) {
      return profile.id;
    }
  }

  throw new ResourceNotFoundRouteError(
    "ASSISTANT_NOT_FOUND",
    `Assistant '${rawAssistantRef}' does not exist`,
  );
}

function sendRouteError(
  req: FastifyRequest,
  reply: FastifyReply,
  err: unknown,
): FastifyReply {
  if (err instanceof ResourceNotFoundRouteError) {
    return reply.code(404).send(
      buildApiError(err.code, err.message, {
        retryable: false,
      }),
    );
  }

  if (err instanceof ProviderError) {
    req.log.warn(
      {
        code: err.code,
        provider: err.providerKey,
        statusCode: err.statusCode,
        retryable: err.retryable,
      },
      "Provider operation failed",
    );
    return reply.code(err.statusCode).send(err.toApiError());
  }

  req.log.error("Unexpected internal failure in provider route");
  return reply.code(503).send(
    buildApiError("PROVIDER_INTERNAL_FAILURE", "Failed to process provider request", {
      retryable: true,
    }),
  );
}

export function createDatabasePreferenceReader(
  getDb: () => PostgresNexusDatabase,
): ProviderPreferenceReader {
  return async ({ ownerId, conversationId }) => {
    const db = getDb();
    return db.withOwnerTransaction(
      {
        ownerId,
        actor: { type: "owner" },
      },
      async (repos) => {
        if (conversationId) {
          const conversation = await repos.conversations.getById(conversationId);
          if (!conversation) {
            throw new ResourceNotFoundRouteError(
              "CONVERSATION_NOT_FOUND",
              `Conversation '${conversationId}' does not exist`,
            );
          }
        }
        return repos.providerPreferences.getAll();
      },
    );
  };
}

export async function registerProviderRoutes(
  app: FastifyInstance,
  options: ProviderRoutesOptions = {},
): Promise<void> {
  const runtime = resolveRuntime(options);
  const readPreferences: ProviderPreferenceReader =
    options.readPreferences ??
    (async () => DEFAULT_PROVIDER_PREFERENCE_SET);

  // 1. Consultar provedores disponíveis
  app.get("/v1/providers", { preHandler: requireAuth }, async (req, reply) => {
    const parsedQuery = listProvidersQuerySchema.safeParse(req.query ?? {});
    if (!parsedQuery.success) {
      return reply.code(400).send(
        buildApiError("INVALID_QUERY_PARAMETERS", "Invalid query parameters", {
          retryable: false,
        }),
      );
    }

    try {
      const result = await runtime.catalog.listProviders({
        forceRefresh: parsedQuery.data.refresh,
      });
      return reply.code(200).send(result);
    } catch (err) {
      return sendRouteError(req, reply, err);
    }
  });

  // 2. Consultar modelos elegíveis
  app.get(
    "/v1/providers/models",
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsedQuery = listEligibleModelsQuerySchema.safeParse(req.query ?? {});
      if (!parsedQuery.success) {
        return reply.code(400).send(
          buildApiError("INVALID_QUERY_PARAMETERS", "Invalid query parameters", {
            retryable: false,
          }),
        );
      }

      try {
        const result = await runtime.catalog.listEligibleModels({
          provider: parsedQuery.data.provider,
          capability: parsedQuery.data.capability,
          forceRefresh: parsedQuery.data.refresh,
        });
        return reply.code(200).send(result);
      } catch (err) {
        return sendRouteError(req, reply, err);
      }
    },
  );

  // 3. Consultar capacidades públicas
  app.get(
    "/v1/providers/capabilities",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const result = runtime.catalog.getPublicCapabilities();
        return reply.code(200).send(result);
      } catch (err) {
        return sendRouteError(req, reply, err);
      }
    },
  );

  // 4. Consultar a configuração efetiva de seleção
  app.get(
    "/v1/providers/selection",
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsedQuery = selectionQuerySchema.safeParse(req.query ?? {});
      if (!parsedQuery.success) {
        return reply.code(400).send(
          buildApiError("INVALID_QUERY_PARAMETERS", "Invalid query parameters", {
            retryable: false,
          }),
        );
      }

      const rawCapabilities = splitCsvValues(parsedQuery.data.capability);
      const requiredCapabilities: ModelCapability[] = [];
      for (const rawCap of rawCapabilities) {
        const capParsed = modelCapabilitySchema.safeParse(rawCap);
        if (!capParsed.success) {
          return reply.code(400).send(
            buildApiError(
              "INVALID_QUERY_PARAMETERS",
              `Unsupported capability '${rawCap}'`,
              { retryable: false },
            ),
          );
        }
        requiredCapabilities.push(capParsed.data);
      }

      const rawParameters = splitCsvValues(parsedQuery.data.parameter);
      const requiredParameters: ModelParameterName[] = [];
      for (const rawParam of rawParameters) {
        const paramParsed = modelParameterNameSchema.safeParse(rawParam);
        if (!paramParsed.success) {
          return reply.code(400).send(
            buildApiError(
              "INVALID_QUERY_PARAMETERS",
              `Unsupported parameter '${rawParam}'`,
              { retryable: false },
            ),
          );
        }
        requiredParameters.push(paramParsed.data);
      }

      try {
        const assistantId = parsedQuery.data.assistantId
          ? resolveCanonicalAssistantId(parsedQuery.data.assistantId)
          : undefined;

        const preferences = await readPreferences({
          ownerId: req.session!.ownerId,
          conversationId: parsedQuery.data.conversationId,
        });

        const resolved = await runtime.selection.resolveEffectiveSelection(
          preferences,
          {
            assistantId,
            conversationId: parsedQuery.data.conversationId,
            ...(requiredCapabilities.length > 0
              ? { requiredCapabilities }
              : {}),
            ...(requiredParameters.length > 0 ? { requiredParameters } : {}),
            forceRefresh: parsedQuery.data.refresh,
          },
        );

        return reply.code(200).send(resolved.response);
      } catch (err) {
        return sendRouteError(req, reply, err);
      }
    },
  );
}
