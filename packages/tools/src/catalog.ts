import { z } from "zod";
import { toolDataSchema, toolDefinitionMetadataSchema, type ToolDefinitionMetadata, type ToolError } from "./schemas.js";

type DeepReadonly<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer TItem)[]
    ? readonly DeepReadonly<TItem>[]
    : T extends object
      ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
      : T;

export type ToolDefinition<TParameters extends z.ZodType, TResult extends z.ZodType> = DeepReadonly<ToolDefinitionMetadata> & {
  readonly parametersSchema: TParameters;
  readonly resultSchema: TResult;
};

export type AnyToolDefinition = ToolDefinition<z.ZodType, z.ZodType>;
export type ToolValidationResult<T> = { success: true; data: T } | { success: false; error: ToolError };

const freezeDeep = (value: object): void => {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object" && !Object.isFrozen(child)) freezeDeep(child);
  }
};

export class ToolCatalogError extends Error {
  readonly toolError: ToolError;

  constructor(error: ToolError) {
    super(error.message);
    this.name = "ToolCatalogError";
    this.toolError = error;
  }
}

const catalogError = (code: ToolError["code"], message: string): ToolCatalogError =>
  new ToolCatalogError({ code, message, retryable: false });

export const defineTool = <TParameters extends z.ZodType, TResult extends z.ZodType>(
  definition: ToolDefinition<TParameters, TResult>,
): ToolDefinition<TParameters, TResult> => {
  const { parametersSchema, resultSchema, ...metadata } = definition;
  const parsed = toolDefinitionMetadataSchema.safeParse(metadata);
  if (!parsed.success) throw catalogError("INVALID_TOOL_DEFINITION", "Tool definition failed metadata validation");
  const parsedMetadata = parsed.data;
  freezeDeep(parsedMetadata);
  return Object.freeze({ ...parsedMetadata, parametersSchema, resultSchema });
};

export class ToolCatalog {
  private readonly definitions = new Map<string, AnyToolDefinition>();

  register<TParameters extends z.ZodType, TResult extends z.ZodType>(
    definition: ToolDefinition<TParameters, TResult>,
  ): ToolDefinition<TParameters, TResult> {
    if (this.definitions.has(definition.id)) {
      throw catalogError("DUPLICATE_TOOL_ID", "Tool ID is already registered");
    }
    const registered = defineTool(definition);
    this.definitions.set(registered.id, registered);
    return registered;
  }

  list(): readonly AnyToolDefinition[] {
    return Object.freeze([...this.definitions.values()]);
  }

  getById(id: string): AnyToolDefinition | undefined {
    return this.definitions.get(id);
  }

  requireById(id: string): AnyToolDefinition {
    const definition = this.getById(id);
    if (!definition) throw catalogError("TOOL_NOT_FOUND", "Tool ID is not registered");
    return definition;
  }

  validateParametersById(id: string, input: unknown, requestId?: string): ToolValidationResult<unknown> {
    const definition = this.getById(id);
    if (!definition) return { success: false, error: { code: "TOOL_NOT_FOUND", message: "Tool ID is not registered", ...(requestId ? { requestId } : {}), retryable: false } };
    return this.validateParameters(definition, input, requestId);
  }

  validateParameters<TParameters extends z.ZodType, TResult extends z.ZodType>(
    definition: ToolDefinition<TParameters, TResult>,
    input: unknown,
    requestId?: string,
  ): ToolValidationResult<z.output<TParameters>> {
    const safeInput = toolDataSchema.safeParse(input);
    if (!safeInput.success) return { success: false, error: validationError("INVALID_PARAMETERS", requestId) };
    const result = definition.parametersSchema.safeParse(safeInput.data);
    if (!result.success) return { success: false, error: validationError("INVALID_PARAMETERS", requestId) };
    return { success: true, data: result.data };
  }

  validateResult<TResult extends z.ZodType>(
    definition: ToolDefinition<z.ZodType, TResult>,
    input: unknown,
    requestId?: string,
  ): ToolValidationResult<z.output<TResult>> {
    const safeInput = toolDataSchema.safeParse(input);
    if (!safeInput.success) return { success: false, error: validationError("INVALID_RESULT", requestId) };
    const result = definition.resultSchema.safeParse(safeInput.data);
    if (!result.success) return { success: false, error: validationError("INVALID_RESULT", requestId) };
    return { success: true, data: result.data };
  }
}

const validationError = (code: "INVALID_PARAMETERS" | "INVALID_RESULT", requestId?: string): ToolError => ({
  code,
  message: code === "INVALID_PARAMETERS" ? "Tool parameters failed validation" : "Tool result failed validation",
  ...(requestId ? { requestId } : {}),
  retryable: false,
});

export const toolCatalog = new ToolCatalog();
