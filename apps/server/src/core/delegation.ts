import {
  CANONICAL_PROFILE_REGISTRY,
  effectiveDelegationTargets,
  type AssistantProfile,
  type AssistantProfileRegistry,
} from "@nexus/assistant-profiles";
import {
  COORDINATION_ENVELOPE_KIND,
  coordinatorDecisionEnvelopeSchema,
  type AssistantKey,
  type DelegationTaskSpec,
} from "@nexus/shared";
import { CoreExecutionError } from "./errors.js";

/**
 * Delegation policy, derived from the profile registry.
 *
 * Etapa 3C.3, Fase 3 (G2): until this phase the policy was a literal map in this file —
 * `{ yui: ["alice","schwi"], alice: [], schwi: [] }` — and `engine.ts` kept a second copy of the
 * same list to build the coordinator prompt. Two sources of truth for one rule meant a fourth
 * assistant could never take part in coordination without editing production code in two places.
 *
 * Now the rule is **data**: each profile declares `coordination`, and this module only projects
 * it. There is no list of assistants here to add a key to.
 *
 * The exported record is kept for compatibility (it is public since Etapa 3B and callers read
 * `DELEGATION_TARGETS.yui`), but it is computed from the registry rather than written by hand.
 * It is intentionally **sealed**: `Object.freeze` on a record produced at module load means a
 * later catalog cannot mutate it, and tests that need another composition call
 * `delegationTargetsFor(key, registry)` explicitly.
 */
function snapshotDelegationTargets(
  registry: AssistantProfileRegistry,
): Readonly<Record<string, readonly string[]>> {
  const entries = registry
    .list()
    .map((profile) => [profile.key, Object.freeze([...effectiveDelegationTargets(profile, registry)])] as const);
  return Object.freeze(Object.fromEntries(entries));
}

/**
 * Policy snapshot of the production catalog.
 *
 * Keys are assistant keys, not `InitialAssistantKey`: a fourth assistant appears here as soon as
 * it declares coordination, without widening a closed enum in a contract.
 */
export const DELEGATION_TARGETS: Readonly<Record<string, readonly AssistantKey[]>> =
  snapshotDelegationTargets(CANONICAL_PROFILE_REGISTRY);

/**
 * Kept for compatibility. No longer the *authority*: it is derived from the profile that declares
 * coordination, and is `null` if the catalog ever has no coordinator. Callers that branch on a
 * coordinator existing must handle that case instead of assuming YUI.
 */
export const COORDINATOR_ASSISTANT_KEY: AssistantKey | undefined =
  (Object.entries(DELEGATION_TARGETS).find(([, targets]) => targets.length > 0)?.[0] as
    | AssistantKey
    | undefined) ?? undefined;

/**
 * Effective delegation targets for an assistant.
 *
 * Fase 1 generalized the *type* so an assistant outside the initial catalog could ask the
 * question and get a truthful "no targets". Fase 3 generalizes the *source*: the answer comes
 * from the profile, through the registry, so a profile declared only in a test is answered just
 * as truthfully as YUI.
 *
 * @param registry Omitted -> the sealed production registry.
 */
export function delegationTargetsFor(
  key: AssistantKey,
  registry: AssistantProfileRegistry = CANONICAL_PROFILE_REGISTRY,
): readonly AssistantKey[] {
  const profile = registry.getByKey(key);
  if (!profile) return [];
  return effectiveDelegationTargets(profile, registry) as readonly AssistantKey[];
}

export function canDelegate(
  key: AssistantKey,
  registry: AssistantProfileRegistry = CANONICAL_PROFILE_REGISTRY,
): boolean {
  return delegationTargetsFor(key, registry).length > 0;
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
  readonly chainKeys: readonly AssistantKey[];
  /** Delegation depth of the run that owns this plan. */
  readonly baseDepth: number;
  readonly limits: DelegationLimits;
  /**
   * Registro de perfis usado para autorizar os alvos.
   *
   * Omitido -> o registro de produção selado. Existe para que um teste componha um catálogo
   * isolado (uma quarta assistente, por exemplo) e prove que a política é dado, sem que a
   * produção precise conhecer essa chave.
   */
  readonly registry?: AssistantProfileRegistry;
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
  const registry = input.registry ?? CANONICAL_PROFILE_REGISTRY;
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
    // O alvo pode ser qualquer identificador válido (Fase 1); quem decide se ele é autorizado
    // é o **perfil do coordenador** (Fase 3), projetado pelo registro — não uma lista aqui.
    const allowedTargets = delegationTargetsFor(owner, registry);
    if (!allowedTargets.some((allowed) => allowed === target)) {
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
