import { describe, expect, it } from "vitest";
import { assistantSchema, initialAssistantProfileSchema } from "@nexus/shared";
import {
  assistantProfileCatalogSchema,
  assistantProfileSchema,
  getAssistantProfileById,
  getAssistantProfileByKey,
  listAssistantProfiles,
  type AssistantProfile,
} from "./index.js";

const profiles = listAssistantProfiles();

describe("assistant profile catalog", () => {
  it("contains the initial profiles with stable, unique IDs", () => {
    // Fase 4: a ordem passa a incluir VIVY ao fim. A lista continua sendo explícita — o ponto do
    // teste é que o catálogo não ganha membros sem que alguém os declare aqui.
    expect(profiles.map((profile) => profile.key)).toEqual(["yui", "alice", "schwi", "vivy"]);
    // Unicidade e formato continuam derivados do tamanho real do catálogo: acrescentar um perfil
    // duplicado quebra a igualdade, não o `toBe(3)`.
    expect(new Set(profiles.map((profile) => profile.id)).size).toBe(profiles.length);
    expect(new Set(profiles.map((profile) => profile.key)).size).toBe(profiles.length);
    expect(profiles.every((profile) => /^[0-9a-f-]{36}$/i.test(profile.id))).toBe(true);
  });

  it("validates every profile, version, and compatible shared assistant fields", () => {
    for (const profile of profiles) {
      expect(assistantProfileSchema.safeParse(profile).success).toBe(true);
      expect(assistantSchema.safeParse({
        id: profile.id,
        key: profile.key,
        name: profile.name,
        description: profile.description,
        configVersion: profile.configVersion,
        configuration: profile.configuration,
        status: profile.status,
        createdAt: "2026-11-03T00:00:00Z",
        updatedAt: "2026-11-03T00:00:00Z",
      }).success).toBe(true);
      expect(initialAssistantProfileSchema.safeParse({
        id: profile.id,
        key: profile.key,
        name: profile.name,
        description: profile.description,
        configVersion: profile.configVersion,
        configuration: profile.configuration,
        status: profile.status,
        createdAt: "2026-11-03T00:00:00Z",
        updatedAt: "2026-11-03T00:00:00Z",
      }).success).toBe(true);
      expect(profile.profileVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(profile.configVersion).toBe(profile.profileVersion);
    }
    expect(assistantProfileCatalogSchema.safeParse(profiles).success).toBe(true);
    expect(assistantProfileSchema.safeParse({ ...profiles[0], profileVersion: "v1" }).success).toBe(false);
  });

  it("retrieves profiles by stable ID or key and lists the catalog", () => {
    const yui = profiles.find((profile) => profile.key === "yui");
    expect(yui).toBeDefined();
    expect(getAssistantProfileById(yui!.id)).toEqual(yui);
    expect(getAssistantProfileByKey("alice")?.name).toBe("ALICE");
    expect(getAssistantProfileById("missing")).toBeUndefined();
    expect(listAssistantProfiles()).toHaveLength(4);
    expect(Object.isFrozen(profiles)).toBe(true);
    expect(Object.isFrozen(profiles[0]?.tools)).toBe(true);
  });

  it("declares permissions, memory boundaries and restrictions for each assistant", () => {
    for (const profile of profiles) {
      expect(profile.memoryPolicy).toEqual({
        individual: "own_assistant_only",
        shared: "explicit_item_grant_required",
        permissionAuthority: "backend",
      });
      expect(profile.usageRestrictions.join(" ")).toMatch(/permissões/i);
      expect(profile.usageRestrictions.join(" ")).toMatch(/pagas/i);
      expect(profile.usageRestrictions.join(" ")).toMatch(/configurações globais/i);
      for (const tool of profile.tools) {
        expect(tool.requiresUserAuthorization).toBe(true);
        expect(tool.enabledByDefault).toBe(false);
        expect(tool.paidUseRequiresExplicitAuthorization).toBe(true);
      }
    }
    expect(profiles.find((profile) => profile.key === "alice")?.tools.map((tool) => tool.toolId)).toContain("research.search");
    expect(profiles.find((profile) => profile.key === "schwi")?.tools.every((tool) => tool.requiresUserAuthorization)).toBe(true);
  });

  it("keeps profile definitions independent of providers and credentials", () => {
    const serialized = JSON.stringify(profiles).toLowerCase();
    expect(serialized).not.toMatch(/api[_-]?key|credential|password|secret/);
    expect(serialized).not.toMatch(/openai|anthropic|gemini|gpt-[0-9]/);
  });

  it("accepts an additional profile using the same extensible structure", () => {
    const template = profiles[0];
    const additional: AssistantProfile = {
      ...template,
      id: "00000000-0000-4000-8000-000000000099",
      key: "future-assistant",
      name: "Future assistant",
    };
    expect(assistantProfileSchema.safeParse(additional).success).toBe(true);
    expect(assistantProfileCatalogSchema.safeParse([...profiles, additional]).success).toBe(true);
  });
});
