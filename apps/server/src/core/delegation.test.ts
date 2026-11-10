import { CANONICAL_PROFILE_REGISTRY } from "@nexus/assistant-profiles";
import { describe, expect, it } from "vitest";
import { COORDINATION_ENVELOPE_KIND } from "@nexus/shared";
import {
  buildDelegationUserPrompt,
  buildSynthesisUserPrompt,
  canDelegate,
  delegationTargetsFor,
  extractCoordinatorDecision,
  flattenDelegationPlan,
  validateDelegationPlan,
} from "./delegation.js";
import { SERVER_DELEGATION_POLICY } from "./delegation-policy.js";
import { CoreExecutionError } from "./errors.js";
import { buildAssistantSystemInstructions, resolveCanonicalAssistantProfile } from "./instructions.js";

const limits = {
  maxDelegationDepth: 2,
  maxDelegationsPerExecution: 3,
  maxTotalDelegations: 6,
};

function planError(fn: () => void): CoreExecutionError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CoreExecutionError);
    return error as CoreExecutionError;
  }
  throw new Error("Expected the delegation plan to be rejected");
}

describe("NEXUS CORE delegation policy", () => {
  it("only authorizes YUI as coordinator of ALICE and SCHWI", () => {
    expect(canDelegate("yui", CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY)).toBe(true);
    expect(canDelegate("alice", CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY)).toBe(false);
    expect(canDelegate("schwi", CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY)).toBe(false);
    expect(delegationTargetsFor("yui", CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY)).toEqual(["alice", "schwi"]);
    expect(delegationTargetsFor("alice", CANONICAL_PROFILE_REGISTRY, SERVER_DELEGATION_POLICY)).toEqual([]);
  });

  it("accepts a valid plan and flattens nested sub-delegations with depth", () => {
    validateDelegationPlan({
      specs: [{ targetAssistant: "alice", objective: "analisar" }],
      chainKeys: ["yui"],
      baseDepth: 0,
      limits,
    
        policy: SERVER_DELEGATION_POLICY,
      });

    const flattened = flattenDelegationPlan(
      [
        {
          targetAssistant: "alice",
          objective: "nível 1",
          subDelegations: [{ targetAssistant: "schwi", objective: "nível 2" }],
        },
      ],
      0,
    );
    expect(flattened.map((node) => ({ depth: node.depth, target: node.spec.targetAssistant }))).toEqual([
      { depth: 1, target: "alice" },
      { depth: 2, target: "schwi" },
    ]);
  });

  it("blocks cycles against the full ancestry chain", () => {
    const cycle = planError(() =>
      validateDelegationPlan({
        specs: [{ targetAssistant: "yui", objective: "auto" }],
        chainKeys: ["yui"],
        baseDepth: 0,
        limits,
      
        policy: SERVER_DELEGATION_POLICY,
      }),
    );
    expect(cycle.code).toBe("DELEGATION_CYCLE_DETECTED");
    expect(cycle.details?.chain).toEqual(["yui"]);

    const deepCycle = planError(() =>
      validateDelegationPlan({
        specs: [{ targetAssistant: "schwi", objective: "x" }],
        chainKeys: ["yui", "alice", "schwi"],
        baseDepth: 0,
        limits,
      
        policy: SERVER_DELEGATION_POLICY,
      }),
    );
    expect(deepCycle.code).toBe("DELEGATION_CYCLE_DETECTED");
  });

  it("enforces the depth limit for nested plans", () => {
    const error = planError(() =>
      validateDelegationPlan({
        specs: [
          {
            targetAssistant: "alice",
            objective: "1",
            subDelegations: [
              {
                targetAssistant: "schwi",
                objective: "2",
                subDelegations: [{ targetAssistant: "alice", objective: "3" }],
              },
            ],
          },
        ],
        chainKeys: ["yui"],
        baseDepth: 0,
        limits,
      
        policy: SERVER_DELEGATION_POLICY,
      }),
    );
    expect(error.code).toBe("DELEGATION_DEPTH_EXCEEDED");
    expect(error.details?.requestedDepth).toBe(3);
  });

  it("enforces per-execution and global delegation limits", () => {
    const perExecution = planError(() =>
      validateDelegationPlan({
        specs: [
          { targetAssistant: "alice", objective: "a" },
          { targetAssistant: "schwi", objective: "b" },
        ],
        chainKeys: ["yui"],
        baseDepth: 0,
        limits: { ...limits, maxDelegationsPerExecution: 1 },
      
        policy: SERVER_DELEGATION_POLICY,
      }),
    );
    expect(perExecution.code).toBe("DELEGATION_LIMIT_EXCEEDED");

    const global = planError(() =>
      validateDelegationPlan({
        specs: [
          { targetAssistant: "alice", objective: "a" },
          { targetAssistant: "schwi", objective: "b" },
        ],
        chainKeys: ["yui"],
        baseDepth: 0,
        limits: { ...limits, maxTotalDelegations: 1 },
      
        policy: SERVER_DELEGATION_POLICY,
      }),
    );
    expect(global.code).toBe("DELEGATION_LIMIT_EXCEEDED");
  });

  it("rejects delegation from assistants without coordinator authority", () => {
    const error = planError(() =>
      validateDelegationPlan({
        specs: [{ targetAssistant: "schwi", objective: "x" }],
        chainKeys: ["alice"],
        baseDepth: 0,
        limits,
      
        policy: SERVER_DELEGATION_POLICY,
      }),
    );
    expect(error.code).toBe("DELEGATION_NOT_ALLOWED");
  });

  it("recognizes delegation only through the explicit coordination envelope", () => {
    const direct = extractCoordinatorDecision("Uma resposta normal em texto livre");
    expect(direct).toEqual({ kind: "direct", text: "Uma resposta normal em texto livre" });

    // Free-text "commands" are never interpreted as delegation.
    const fakeCommand = extractCoordinatorDecision("DELEGATE alice: analisar as fontes");
    expect(fakeCommand.kind).toBe("direct");

    const enveloped = extractCoordinatorDecision(
      JSON.stringify({
        kind: COORDINATION_ENVELOPE_KIND,
        action: "delegate",
        delegations: [{ targetAssistant: "alice", objective: "analisar" }],
      }),
    );
    expect(enveloped.kind).toBe("delegate");
    if (enveloped.kind === "delegate") {
      expect(enveloped.delegations[0]!.targetAssistant).toBe("alice");
    }

    const fenced = extractCoordinatorDecision(
      "```json\n" +
        JSON.stringify({
          kind: COORDINATION_ENVELOPE_KIND,
          action: "respond",
          response: "resposta direta no envelope",
        }) +
        "\n```",
    );
    expect(fenced).toEqual({ kind: "direct", text: "resposta direta no envelope" });
  });

  it("rejects malformed coordination envelopes explicitly and empty responses", () => {
    const malformed = (() => {
      try {
        extractCoordinatorDecision(
          JSON.stringify({ kind: COORDINATION_ENVELOPE_KIND, action: "delegate", delegations: [] }),
        );
      } catch (error) {
        return error as CoreExecutionError;
      }
      return undefined;
    })();
    expect(malformed?.code).toBe("INVALID_DELEGATION_CONTRACT");

    const empty = (() => {
      try {
        extractCoordinatorDecision("   ");
      } catch (error) {
        return error as CoreExecutionError;
      }
      return undefined;
    })();
    expect(empty?.code).toBe("EMPTY_MODEL_RESPONSE");
  });

  it("builds delegation and synthesis prompts bounded by the configured limits", () => {
    const yui = resolveCanonicalAssistantProfile({ assistantKey: "yui" });
    const alice = resolveCanonicalAssistantProfile({ assistantKey: "alice" });

    const delegationPrompt = buildDelegationUserPrompt({
      sourceProfile: yui,
      targetProfile: alice,
      spec: {
        targetAssistant: "alice",
        objective: "comparar fontes",
        completionCriteria: "lista com evidências",
      },
      userRequest: "u".repeat(10_000),
      maxChars: 500,
    });
    expect(delegationPrompt).toContain("comparar fontes");
    expect(delegationPrompt).toContain("YUI");
    expect(delegationPrompt).toContain("ALICE");
    expect(delegationPrompt.length).toBeLessThan(1_500);

    const synthesisPrompt = buildSynthesisUserPrompt({
      coordinatorProfile: yui,
      userRequest: "pedido original",
      maxCharsPerOutcome: 100,
      outcomes: [
        {
          assistantName: "ALICE",
          assistantKey: "alice",
          objective: "analisar",
          status: "succeeded",
          outputText: "o".repeat(1_000),
        },
        {
          assistantName: "SCHWI",
          assistantKey: "schwi",
          objective: "planejar",
          status: "failed",
          failureMessage: "PROVIDER_TIMEOUT",
        },
      ],
    });
    expect(synthesisPrompt).toContain("PROVIDER_TIMEOUT");
    expect(synthesisPrompt).toContain("não invente");
    expect(synthesisPrompt.length).toBeLessThan(2_000);
  });
});

describe("NEXUS CORE assistant instructions", () => {
  it("projects each frozen profile without inventing identity or instructions", () => {
    for (const key of ["yui", "alice", "schwi"] as const) {
      const profile = resolveCanonicalAssistantProfile({ assistantKey: key });
      const instructions = buildAssistantSystemInstructions(profile, {
        mode: key === "yui" ? "coordinator_planning" : "direct",
        ...(key === "yui" ? { canDelegateTo: ["alice", "schwi"] as const } : {}),
      });

      expect(instructions).toContain(`Identidade ativa no NEXUS CORE: ${profile.name}`);
      for (const behavior of profile.behaviorInstructions) {
        expect(instructions).toContain(behavior);
      }
      for (const instruction of profile.configuration.instructions) {
        expect(instructions).toContain(instruction);
      }
      expect(instructions).toContain(profile.communicationPreferences.tone);
      expect(instructions).toContain("nunca altere sua identidade");
    }
  });

  it("adds the coordination protocol only for the YUI planning mode", () => {
    const yui = resolveCanonicalAssistantProfile({ assistantKey: "yui" });
    const planning = buildAssistantSystemInstructions(yui, {
      mode: "coordinator_planning",
      canDelegateTo: ["alice", "schwi"],
    });
    expect(planning).toContain(COORDINATION_ENVELOPE_KIND);
    expect(planning).toContain("Nunca simule delegação em texto livre");

    const synthesis = buildAssistantSystemInstructions(yui, { mode: "coordinator_synthesis" });
    expect(synthesis).toContain("Modo de síntese coordenadora");
    expect(synthesis).not.toContain(COORDINATION_ENVELOPE_KIND);

    const alice = resolveCanonicalAssistantProfile({ assistantKey: "alice" });
    const delegated = buildAssistantSystemInstructions(alice, { mode: "delegated_specialist" });
    expect(delegated).toContain("Modo de execução delegada");
    expect(delegated).toContain("Não inicie novas delegações");
  });

  it("rejects unknown or mismatched assistant identifiers", () => {
    expect(() => resolveCanonicalAssistantProfile({ assistantId: "not-a-uuid" })).toThrow(
      CoreExecutionError,
    );
    expect(() =>
      resolveCanonicalAssistantProfile({ assistantId: "00000000-0000-4000-8000-000000000002", assistantKey: "yui" }),
    ).toThrow(/do not match/);
    expect(() => resolveCanonicalAssistantProfile({})).toThrow(CoreExecutionError);
  });
});
