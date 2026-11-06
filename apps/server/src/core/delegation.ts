import type { AssistantProfile } from "@nexus/assistant-profiles";
import {
  COORDINATION_ENVELOPE_KIND,
  coordinatorDecisionEnvelopeSchema,
  type DelegationTaskSpec,
  type InitialAssistantKey,
} from "@nexus/shared";
import { CoreExecutionError } from "./errors.js";

/**
 * Explicit, catalog-driven delegation policy.
 *
 * Only YUI holds the coordinator role in Etapa 3B. ALICE and SCHWI are leaves:
 * they never self-initiate delegation and never receive authority to reinterpret
 * another assistant's instructions.
 */
export const DELEGATION_TARGETS: Readonly<
  Record<InitialAssistantKey, readonly InitialAssistantKey[]>
> = Object.freeze({
  yui: Object.freeze(["alice", "schwi"] as const),
  alice: Object.freeze([] as const),
  schwi: Object.freeze([] as const),
});

export const COORDINATOR_ASSISTANT_KEY: InitialAssistantKey = "yui";

export function delegationTargetsFor(key: InitialAssistantKey): readonly InitialAssistantKey[] {
  return DELEGATION_TARGETS[key];
}

export function canDelegate(key: InitialAssistantKey): boolean {
  return DELEGATION_TARGETS[key].length > 0;
}

export interface DelegationPlanNode {
  readonly depth: number;
  readonly spec: DelegationTaskSpec;
}

export interface DelegationLimits {
  readonly maxDelegationDepth: number;
  readonly maxDelegationsPerExecution: number;
  readonly maxTotalDelegations: number;
}

export interface ValidateDelegationPlanInput {
  readonly specs: readonly DelegationTaskSpec[];
  /** Assistant keys already present in the execution ancestry, oldest first. */
  readonly chainKeys: readonly InitialAssistantKey[];
  /** Delegation depth of the run that owns this plan. */
  readonly baseDepth: number;
  readonly limits: DelegationLimits;
}

/** Flattens the structured plan (including nested sub-delegations) deterministically. */
export function flattenDelegationPlan(
  specs: readonly DelegationTaskSpec[],
  baseDepth: number,
): readonly DelegationPlanNode[] {
  const nodes: DelegationPlanNode[] = [];
  const visit = (items: readonly DelegationTaskSpec[], depth: number): void => {
    for (const spec of items) {
      nodes.push({ depth, spec });
      if (spec.subDelegations && spec.subDelegations.length > 0) {
        visit(spec.subDelegations, depth + 1);
      }
    }
  };
  visit(specs, baseDepth + 1);
  return nodes;
}

/**
 * Validates a structured delegation plan before any provider call or child
 * execution is created. Rejection is always explicit — never silently truncated.
 *
 * Validation order is intentional: cycles, then depth, then authorization, then
 * volume, so that reported error codes stay stable and auditable.
 */
export function validateDelegationPlan(input: ValidateDelegationPlanInput): void {
  const { specs, chainKeys, baseDepth, limits } = input;
  const owner = chainKeys[chainKeys.length - 1];

  if (!owner) {
    throw new CoreExecutionError(
      "INVALID_DELEGATION_CONTRACT",
      "Delegation requires an identified originating assistant",
    );
  }

  const nodes = flattenDelegationPlan(specs, baseDepth);

  for (const node of nodes) {
    const target = node.spec.targetAssistant;
    const chain = [...chainKeys];

    // 1. Cycles: delegating to any assistant already present in the ancestry chain
    //    (including the originating assistant itself) is blocked.
    if (chain.includes(target)) {
      throw new CoreExecutionError(
        "DELEGATION_CYCLE_DETECTED",
        `Delegation cycle blocked: '${target}' is already part of the execution chain (${chain.join(" -> ")})`,
        {
          details: {
            targetAssistant: target,
            chain: [...chain],
          },
        },
      );
    }

    // 2. Depth limit: prevents recursive/infinite nesting regardless of contract depth.
    if (node.depth > limits.maxDelegationDepth) {
      throw new CoreExecutionError(
        "DELEGATION_DEPTH_EXCEEDED",
        `Delegation depth ${node.depth} exceeds the configured limit of ${limits.maxDelegationDepth}`,
        {
          details: {
            requestedDepth: node.depth,
            maxDelegationDepth: limits.maxDelegationDepth,
            targetAssistant: target,
          },
        },
      );
    }

    // 3. Authorization: only catalog-authorized coordinator targets are accepted.
    const allowedTargets = delegationTargetsFor(owner);
    if (!allowedTargets.includes(target)) {
      throw new CoreExecutionError(
        "DELEGATION_NOT_ALLOWED",
        allowedTargets.length === 0
          ? `Assistant '${owner}' is not allowed to delegate tasks in this stage`
          : `Assistant '${owner}' cannot delegate to '${target}'; allowed targets: ${allowedTargets.join(", ")}`,
        {
          details: {
            sourceAssistant: owner,
            targetAssistant: target,
            allowedTargets: [...allowedTargets],
          },
        },
      );
    }
  }

  // 4. Volume limits: per-execution and total plan size.
  if (nodes.length > limits.maxDelegationsPerExecution) {
    throw new CoreExecutionError(
      "DELEGATION_LIMIT_EXCEEDED",
      `Delegation plan requests ${nodes.length} tasks, exceeding the limit of ${limits.maxDelegationsPerExecution} per execution`,
      {
        details: {
          requestedDelegations: nodes.length,
          maxDelegationsPerExecution: limits.maxDelegationsPerExecution,
        },
      },
    );
  }
  if (nodes.length > limits.maxTotalDelegations) {
    throw new CoreExecutionError(
      "DELEGATION_LIMIT_EXCEEDED",
      `Delegation plan requests ${nodes.length} tasks, exceeding the global limit of ${limits.maxTotalDelegations}`,
      {
        details: {
          requestedDelegations: nodes.length,
          maxTotalDelegations: limits.maxTotalDelegations,
        },
      },
    );
  }
}

export type CoordinatorDecision =
  | { readonly kind: "direct"; readonly text: string }
  | { readonly kind: "delegate"; readonly delegations: readonly DelegationTaskSpec[] };

function stripCodeFence(text: string): string | null {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim());
  return fenced?.[1]?.trim() ?? null;
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * Interprets YUI's structured coordination output.
 *
 * Delegation is only ever recognized through the explicit
 * `nexus.core.coordination.v1` contract. Any other free text is treated as a
 * direct answer — never parsed as an improvised command.
 */
export function extractCoordinatorDecision(rawText: string): CoordinatorDecision {
  const text = rawText.trim();
  if (!text) {
    throw new CoreExecutionError(
      "EMPTY_MODEL_RESPONSE",
      "Coordinator produced an empty response",
    );
  }

  const candidates = [text, stripCodeFence(text), extractJsonObject(text)].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).kind !== COORDINATION_ENVELOPE_KIND
    ) {
      continue;
    }

    const envelope = coordinatorDecisionEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      throw new CoreExecutionError(
        "INVALID_DELEGATION_CONTRACT",
        "Coordinator returned a malformed nexus.core.coordination.v1 envelope",
        {
          details: {
            issues: envelope.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        },
      );
    }

    if (envelope.data.action === "delegate") {
      return { kind: "delegate", delegations: envelope.data.delegations };
    }
    return { kind: "direct", text: envelope.data.response };
  }

  return { kind: "direct", text };
}

export function truncateForPrompt(text: string, maxChars: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  const keep = Math.max(1, maxChars - 40);
  return `${normalized.slice(0, keep)}\n[... saída resumida pelo NEXUS CORE ...]`;
}

export interface DelegationPromptInput {
  readonly sourceProfile: AssistantProfile;
  readonly targetProfile: AssistantProfile;
  readonly spec: DelegationTaskSpec;
  readonly userRequest: string;
  readonly maxChars: number;
}

export function buildDelegationUserPrompt(input: DelegationPromptInput): string {
  const sections = [
    `Coordenação do NEXUS CORE — delegação de ${input.sourceProfile.name} para ${input.targetProfile.name}.`,
    "Solicitação original do usuário:",
    truncateForPrompt(input.userRequest, input.maxChars),
    "Objetivo delegado (definido pelo contrato estruturado):",
    input.spec.objective,
  ];

  if (input.spec.contextNotes) {
    sections.push("Contexto adicional fornecido pelo coordenador:", input.spec.contextNotes);
  }
  if (input.spec.completionCriteria) {
    sections.push("Critério de conclusão exigido:", input.spec.completionCriteria);
  }
  if (input.spec.inputReferenceIds && input.spec.inputReferenceIds.length > 0) {
    sections.push(
      `Referências de contexto informadas: ${input.spec.inputReferenceIds.join(", ")}`,
    );
  }

  sections.push(
    "Responda somente com o conteúdo referente à sua especialidade; o resultado será retornado ao coordenador.",
  );

  return sections.join("\n\n");
}

export interface SynthesisPromptInput {
  readonly coordinatorProfile: AssistantProfile;
  readonly userRequest: string;
  readonly outcomes: readonly {
    readonly assistantName: string;
    readonly assistantKey: string;
    readonly objective: string;
    readonly status: "succeeded" | "failed";
    readonly outputText?: string;
    readonly failureMessage?: string;
  }[];
  readonly maxCharsPerOutcome: number;
}

export function buildSynthesisUserPrompt(input: SynthesisPromptInput): string {
  const blocks = input.outcomes.map((outcome, index) => {
    const header = `### Delegação ${index + 1} — ${outcome.assistantName} (${outcome.assistantKey})`;
    const body =
      outcome.status === "succeeded" && outcome.outputText
        ? truncateForPrompt(outcome.outputText, input.maxCharsPerOutcome)
        : `Falha explícita na execução delegada: ${outcome.failureMessage ?? "erro não detalhado"}`;
    return `${header}\nObjetivo: ${outcome.objective}\nStatus: ${outcome.status}\nResultado:\n${body}`;
  });

  return [
    "Solicitação original do usuário:",
    input.userRequest,
    `Resultados das delegações executadas pelo NEXUS CORE (${input.outcomes.length}):`,
    blocks.join("\n\n"),
    `Formule a resposta final como ${input.coordinatorProfile.name}, integrando apenas os resultados acima. Se alguma delegação falhou, informe a limitação com transparência e não invente o conteúdo ausente.`,
  ].join("\n\n");
}
