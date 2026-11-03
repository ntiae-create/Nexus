import { toolPolicyDecisionSchema, type ToolExecutionPolicy, type ToolPolicyDecision } from "./schemas.js";
import type { AnyToolDefinition } from "./catalog.js";
import { toolExecutionPolicySchema, toolRequestContextSchema, type ToolRequestContext } from "./schemas.js";
import { getAssistantProfileByKey } from "@nexus/assistant-profiles";

export const evaluateToolPolicy = (
  tool: AnyToolDefinition,
  context: ToolRequestContext,
  policy: ToolExecutionPolicy,
): ToolPolicyDecision => {
  const requestContext = toolRequestContextSchema.parse(context);
  const verifiedPolicy = toolExecutionPolicySchema.parse(policy);
  const assistantProfile = getAssistantProfileByKey(requestContext.assistantKey);
  const assistantPermissionDeclared = assistantProfile?.tools.some((permission) =>
    permission.toolId === tool.id && permission.allowed,
  ) ?? false;

  const confirmationRequirement = !tool.requiresUserConfirmation
    ? "not_required"
    : verifiedPolicy.confirmation.userId !== requestContext.userId || verifiedPolicy.confirmation.toolId !== tool.id
      ? "required"
      : verifiedPolicy.confirmation.status === "confirmed"
        ? "confirmed"
        : verifiedPolicy.confirmation.status === "rejected"
        ? "rejected"
        : "required";

  let reason: ToolPolicyDecision["reason"] = "eligible_for_future_backend_execution";
  if (tool.demonstrationOnly || tool.availability === "demonstration_only") reason = "demonstration_only";
  else if (tool.availability === "unavailable") reason = "unavailable";
  else if (tool.availability === "disabled") reason = "disabled_by_default";
  else if (!verifiedPolicy.toolEnabledByBackend) reason = "not_enabled_by_backend";
  else if (!tool.authorizedAssistantKeys.includes(requestContext.assistantKey) || !assistantPermissionDeclared) reason = "assistant_not_authorized";
  else if (verifiedPolicy.userAuthorization.userId !== requestContext.userId || (verifiedPolicy.userAuthorization.toolId !== undefined && verifiedPolicy.userAuthorization.toolId !== tool.id)) reason = "authorization_scope_mismatch";
  else if (verifiedPolicy.userAuthorization.status !== "authorized" || verifiedPolicy.userAuthorization.toolId !== tool.id) reason = "user_not_authorized";
  else if (tool.costStatus !== "free_confirmed" && !verifiedPolicy.userAuthorization.paidUseExplicitlyAuthorized) reason = "paid_use_not_explicitly_authorized";
  else if (tool.networkRequirement === "internet" && requestContext.connection !== "online") reason = "connection_required";
  else if (tool.requiresExternalPermission && (verifiedPolicy.externalPermission.userId !== requestContext.userId || verifiedPolicy.externalPermission.toolId !== tool.id || !verifiedPolicy.externalPermission.granted)) reason = "external_permission_required";
  else if (confirmationRequirement === "rejected") reason = "user_confirmation_rejected";
  else if (confirmationRequirement === "required") reason = "user_confirmation_required";

  return toolPolicyDecisionSchema.parse({
    eligible: reason === "eligible_for_future_backend_execution",
    reason,
    confirmationRequirement,
    executionImplemented: false,
    authorizationAuthority: "backend",
  });
};
