import { describe, expect, it } from "vitest";
import { listAssistantProfiles } from "@nexus/assistant-profiles";
import { ToolCatalog, ToolCatalogError, defineTool, toolCatalog, type AnyToolDefinition } from "./catalog.js";
import { demonstrationTools } from "./examples.js";
import { evaluateToolPolicy } from "./policy.js";
import { toolDefinitionMetadataSchema, toolRequestSchema } from "./schemas.js";
import { z } from "zod";

describe("tool catalog and demonstration definitions", () => {
  it("registers, lists, finds, and rejects duplicate IDs", () => {
    expect(toolCatalog.list()).toHaveLength(5);
    expect(toolCatalog.getById("research.search")?.name).toContain("demonstrativa");
    expect(Object.isFrozen(toolCatalog.requireById("research.search").authorizedAssistantKeys)).toBe(true);
    expect(toolCatalog.getById("missing.tool")).toBeUndefined();
    expect(new Set(toolCatalog.list().map((tool) => tool.id)).size).toBe(5);

    const catalog = new ToolCatalog();
    const first = demonstrationTools[0];
    expect(() => catalog.register(first)).not.toThrow();
    try {
      catalog.register(first);
      throw new Error("Expected duplicate registration to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolCatalogError);
      expect((error as ToolCatalogError).toolError.code).toBe("DUPLICATE_TOOL_ID");
    }
    expect(catalog.validateParametersById("missing.tool", {}).success).toBe(false);
    expect(() => catalog.requireById("missing.tool")).toThrow(ToolCatalogError);
  });

  it("validates parameters and results with each registered schema", () => {
    const definition = toolCatalog.getById("research.search");
    expect(definition).toBeDefined();
    const validParameters = toolCatalog.validateParameters(definition!, { query: "clima", maxResults: 3 });
    expect(validParameters).toMatchObject({ success: true, data: { query: "clima", maxResults: 3 } });
    expect(toolCatalog.validateParameters(definition!, { query: "", maxResults: 99 }).success).toBe(false);
    expect(toolCatalog.validateParameters(definition!, { query: "clima", maxResults: 3, unexpected: true }).success).toBe(false);
    expect(toolCatalog.validateResult(definition!, { demonstration: true, execution: "not_implemented" }).success).toBe(true);
    expect(toolCatalog.validateResult(definition!, { demonstration: false, execution: "done" }).success).toBe(false);
  });

  it("rejects credentials in nested parameters and results", () => {
    const definition = toolCatalog.getById("research.search");
    expect(toolCatalog.validateParameters(definition!, { query: "hello", maxResults: 2, apiKey: "dummy" }).success).toBe(false);
    expect(toolCatalog.validateParameters(definition!, { query: "hello", maxResults: 2, nested: { accessToken: "dummy" } }).success).toBe(false);
    expect(toolCatalog.validateResult(definition!, { demonstration: true, execution: "not_implemented", credentials: { password: "dummy" } }).success).toBe(false);
    expect(toolRequestSchema.safeParse({
      requestId: "d9428888-122b-4c81-8f6d-5f9b1f3b5b21",
      userId: "d9428888-122b-4c81-8f6d-5f9b1f3b5b22",
      assistantKey: "alice",
      connection: "online",
      toolId: "research.search",
      parameters: { query: "search", nested: { bearerToken: "dummy" } },
    }).success).toBe(false);
  });

  it("requires disabled-by-default, demo-only metadata and validates risk/network rules", () => {
    for (const tool of toolCatalog.list()) {
      expect(tool.enabledByDefault).toBe(false);
      expect(tool.demonstrationOnly).toBe(true);
      expect(tool.availability).toBe("demonstration_only");
    }
    const metadata = { ...demonstrationTools[0] };
    const { parametersSchema: _parametersSchema, resultSchema: _resultSchema, ...definitionMetadata } = metadata;
    expect(toolDefinitionMetadataSchema.safeParse({ ...definitionMetadata, requiresExternalPermission: false }).success).toBe(false);
    expect(toolDefinitionMetadataSchema.safeParse({ ...definitionMetadata, mayInvolveCost: false }).success).toBe(false);
    expect(toolDefinitionMetadataSchema.safeParse({ ...definitionMetadata, enabledByDefault: true }).success).toBe(false);
  });

  it("keeps tool authorization declarations aligned with assistant profiles", () => {
    const profileTools = new Map(listAssistantProfiles().map((profile) => [
      profile.key,
      new Set(profile.tools.map((permission) => permission.toolId)),
    ]));
    for (const tool of toolCatalog.list()) {
      for (const assistantKey of tool.authorizedAssistantKeys) {
        expect(profileTools.get(assistantKey)?.has(tool.id)).toBe(true);
      }
    }
  });
});

const policyTool = (): AnyToolDefinition => defineTool({
  id: "research.search",
  name: "Tool test",
  description: "Tool used to test policy gates.",
  version: "1.0.0",
  category: "test",
  authorizedAssistantKeys: ["alice"],
  parametersSchema: z.object({ value: z.string() }).strict(),
  resultSchema: z.object({ value: z.string() }).strict(),
  riskLevel: "low",
  requiresUserConfirmation: false,
  mayInvolveCost: false,
  costStatus: "free_confirmed",
  networkRequirement: "internet",
  requiresExternalPermission: true,
  availability: "available",
  enabledByDefault: false,
  demonstrationOnly: false,
  treatExternalDataAsUntrusted: true,
  authorizationAuthority: "backend",
  metadata: {},
});

const allowedPolicy = () => ({
  toolEnabledByBackend: true,
  userAuthorization: {
    status: "authorized" as const,
    userId: "d9428888-122b-4c81-8f6d-5f9b1f3b5b22",
    toolId: "research.search",
    authority: "backend" as const,
    paidUseExplicitlyAuthorized: false,
  },
  externalPermission: {
    userId: "d9428888-122b-4c81-8f6d-5f9b1f3b5b22",
    toolId: "research.search",
    granted: true,
    authority: "backend" as const,
  },
  confirmation: {
    status: "not_requested" as const,
    userId: "d9428888-122b-4c81-8f6d-5f9b1f3b5b22",
    toolId: "research.search",
    authority: "backend" as const,
  },
});

const requestContext = {
  requestId: "d9428888-122b-4c81-8f6d-5f9b1f3b5b21",
  userId: "d9428888-122b-4c81-8f6d-5f9b1f3b5b22",
  assistantKey: "alice" as const,
  connection: "online" as const,
};

describe("tool execution policy declarations", () => {
  it("separates availability, profile permission, user authorization, and external requirements", () => {
    const tool = policyTool();
    expect(evaluateToolPolicy(tool, requestContext, allowedPolicy()).eligible).toBe(true);
    expect(evaluateToolPolicy(tool, requestContext, { ...allowedPolicy(), toolEnabledByBackend: false }).reason).toBe("not_enabled_by_backend");
    expect(evaluateToolPolicy(tool, { ...requestContext, assistantKey: "schwi" }, allowedPolicy()).reason).toBe("assistant_not_authorized");
    expect(evaluateToolPolicy(tool, requestContext, { ...allowedPolicy(), userAuthorization: { ...allowedPolicy().userAuthorization, status: "not_authorized" } }).reason).toBe("user_not_authorized");
    expect(evaluateToolPolicy(tool, { ...requestContext, connection: "offline" }, allowedPolicy()).reason).toBe("connection_required");
    expect(evaluateToolPolicy(tool, requestContext, { ...allowedPolicy(), externalPermission: { ...allowedPolicy().externalPermission, granted: false } }).reason).toBe("external_permission_required");
    expect(evaluateToolPolicy(tool, requestContext, { ...allowedPolicy(), userAuthorization: { ...allowedPolicy().userAuthorization, userId: "d9428888-122b-4c81-8f6d-5f9b1f3b5b23" } }).reason).toBe("authorization_scope_mismatch");
  });

  it("blocks unknown or paid costs without explicit authorization", () => {
    const tool = defineTool({
      ...policyTool(),
      costStatus: "unknown",
      mayInvolveCost: true,
    });
    expect(evaluateToolPolicy(tool, requestContext, allowedPolicy()).reason).toBe("paid_use_not_explicitly_authorized");
    expect(evaluateToolPolicy(tool, requestContext, {
      ...allowedPolicy(),
      userAuthorization: { ...allowedPolicy().userAuthorization, paidUseExplicitlyAuthorized: true },
    }).eligible).toBe(true);
  });

  it("requires confirmation for sensitive operations and never executes tools", () => {
    const tool = defineTool({ ...policyTool(), riskLevel: "high", requiresUserConfirmation: true });
    expect(evaluateToolPolicy(tool, requestContext, allowedPolicy())).toMatchObject({
      eligible: false, reason: "user_confirmation_required", confirmationRequirement: "required", executionImplemented: false,
    });
    expect(evaluateToolPolicy(tool, requestContext, {
      ...allowedPolicy(), confirmation: { ...allowedPolicy().confirmation, status: "confirmed" },
    })).toMatchObject({ eligible: true, confirmationRequirement: "confirmed", executionImplemented: false });
    expect(evaluateToolPolicy(demonstrationTools[0], requestContext, allowedPolicy()).reason).toBe("demonstration_only");
  });
});
