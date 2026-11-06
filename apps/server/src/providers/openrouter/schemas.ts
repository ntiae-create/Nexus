import { z } from "zod";

export const openRouterRawModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  context_length: z.number().int().nullable().optional(),
  expiration_date: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  disabled: z.boolean().nullable().optional(),
  unavailable: z.boolean().nullable().optional(),
  architecture: z
    .object({
      modality: z.string().nullable().optional(),
      input_modalities: z.array(z.string()).nullable().optional(),
      output_modalities: z.array(z.string()).nullable().optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
  pricing: z.record(z.string(), z.unknown()).nullable().optional(),
  top_provider: z
    .object({
      context_length: z.number().int().nullable().optional(),
      max_completion_tokens: z.number().int().nullable().optional(),
      is_moderated: z.boolean().nullable().optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
  supported_parameters: z.array(z.string()).nullable().optional(),
}).passthrough();

export const openRouterModelsResponseSchema = z.object({
  data: z.array(openRouterRawModelSchema),
}).passthrough();

export const openRouterErrorEnvelopeSchema = z.object({
  error: z
    .object({
      code: z.union([z.number(), z.string()]).optional(),
      message: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
}).passthrough();

const openRouterContentPartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
}).passthrough();

export const openRouterChatCompletionResponseSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1).optional(),
  created: z.number().finite().optional(),
  choices: z
    .array(
      z.object({
        index: z.number().int().optional(),
        finish_reason: z.string().nullable().optional(),
        message: z.object({
          role: z.string().optional(),
          content: z
            .union([
              z.string(),
              z.array(openRouterContentPartSchema),
              z.null(),
            ])
            .optional(),
        }).passthrough(),
      }).passthrough(),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
      cost: z.union([z.number(), z.string()]).optional(),
      total_cost: z.union([z.number(), z.string()]).optional(),
    })
    .passthrough()
    .optional(),
}).passthrough();

export type OpenRouterRawModel = z.infer<typeof openRouterRawModelSchema>;
export type OpenRouterModelsResponse = z.infer<typeof openRouterModelsResponseSchema>;
export type OpenRouterChatCompletionResponse = z.infer<
  typeof openRouterChatCompletionResponseSchema
>;
