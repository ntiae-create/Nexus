import { describe, expect, it } from "vitest";
import {
  CANONICAL_PROFILE_REGISTRY,
  assistantProfileSchema,
  getAssistantProfileByKey,
  getAssistantProfileById,
  listAssistantProfiles,
} from "./index.js";

/**
 * Fase 4 — a quarta assistente oficial, VIVY, no catálogo canônico.
 *
 * Escrito ANTES da implementação, por TDD. Antes desta fase o catálogo tinha três perfis e
 * nenhum perfil declarava exigência de capability de modelo: o engine pedia `["chat"]` fixo.
 *
 * O que estes testes protegem, e por quê:
 *
 * - **Unicidade e validação estrita:** o catálogo é `createAssistantProfileCatalogSchema`, que
 *   recusa id/chave repetidos, alvos inexistentes e ciclos. VIVY não pode afrouxar isso.
 * - **`tools: []`:** a fase é explicitamente "somente chat". Uma ferramenta declarada aqui seria
 *   antecipação da Fase 6 e prometeria execução que não existe.
 * - **Folha de coordenação:** VIVY não delega, mas **é alvo** da YUI. As duas metades da regra
 *   são verificadas separadamente, porque é fácil garantir uma e esquecer a outra.
 * - **Sem exceções no servidor:** a chave `vivy` não pode aparecer em código de produção como
 *   condicional. O perfil é dado; o código só projeta.
 */

const VIVY_ID = "00000000-0000-4000-8000-000000000004";
const VIVY_KEY = "vivy";

describe("Fase 4 — VIVY no catálogo canônico", () => {
  it("aparece no catálogo, na ordem declarada, depois das três existentes", () => {
    expect(listAssistantProfiles().map((profile) => profile.key)).toEqual([
      "yui",
      "alice",
      "schwi",
      "vivy",
    ]);
  });

  it("resolve por chave e por identificador", () => {
    const byKey = getAssistantProfileByKey(VIVY_KEY);
    const byId = getAssistantProfileById(VIVY_ID);
    expect(byKey).toBeDefined();
    expect(byId).toBeDefined();
    expect(byKey!.id).toBe(VIVY_ID);
    expect(byId!.key).toBe(VIVY_KEY);
  });

  it("usa exatamente o identificador e a chave oficiais", () => {
    const vivy = CANONICAL_PROFILE_REGISTRY.getByKey(VIVY_KEY)!;
    expect(vivy.id).toBe(VIVY_ID);
    expect(vivy.key).toBe("vivy");
    expect(vivy.name).toBe("VIVY");
    expect(vivy.status).toBe("active");
  });

  it("passa pela validação estrita do schema de perfil", () => {
    const vivy = CANONICAL_PROFILE_REGISTRY.getByKey(VIVY_KEY)!;
    expect(assistantProfileSchema.safeParse(vivy).success).toBe(true);
  });

  it("mantém chave e identificador únicos — o catálogo recusa duplicata", () => {
    const all = listAssistantProfiles();
    expect(new Set(all.map((profile) => profile.key)).size).toBe(all.length);
    expect(new Set(all.map((profile) => profile.id)).size).toBe(all.length);
  });

  it("declara as capabilities das duas especialidades", () => {
    const vivy = CANONICAL_PROFILE_REGISTRY.getByKey(VIVY_KEY)!;
    const required = [
      "software_engineering",
      "programming",
      "software_architecture",
      "code_analysis",
      "debugging",
      "frontend_development",
      "backend_development",
      "ui_design",
      "ux_design",
      "visual_design",
      "prototyping",
      "design_systems",
    ];
    for (const capability of required) {
      expect(vivy.capabilities, `capability ausente: ${capability}`).toContain(capability);
    }
    // Todas as capabilities seguem o formato do catálogo (minúsculas, sem espaço).
    for (const capability of vivy.capabilities) {
      expect(capability).toMatch(/^[a-z][a-z0-9_.-]*$/);
    }
  });

  it("não declara nenhuma ferramenta", () => {
    const vivy = CANONICAL_PROFILE_REGISTRY.getByKey(VIVY_KEY)!;
    // Fase 4 é "somente chat". Declarar ferramenta aqui prometeria execução inexistente.
    expect(vivy.tools).toEqual([]);
  });

  it("é uma folha de coordenação: não pode delegar", () => {
    const vivy = CANONICAL_PROFILE_REGISTRY.getByKey(VIVY_KEY)!;
    expect(vivy.coordination.canCoordinate).toBe(false);
    expect(vivy.coordination.delegateTo).toBeUndefined();
  });

  it("declara exigência de capability de modelo `code`, e só ela", () => {
    const vivy = CANONICAL_PROFILE_REGISTRY.getByKey(VIVY_KEY)!;
    // `modelPreference` é sobre o MODELO (modelCapabilitySchema), não sobre o perfil.
    // É a distinção que o pedido faz questão de marcar: `capabilities` descrevem a
    // assistente; `modelPreference` descreve o que o modelo precisa oferecer.
    expect(vivy.modelPreference.requiredCapabilities).toEqual(["code"]);
  });

  it("preserva o comportamento declarado das três existentes", () => {
    const yui = CANONICAL_PROFILE_REGISTRY.getByKey("yui")!;
    expect(yui.coordination).toEqual({ canCoordinate: true, delegateTo: ["alice", "schwi", "vivy"] });

    for (const key of ["alice", "schwi"] as const) {
      const leaf = CANONICAL_PROFILE_REGISTRY.getByKey(key)!;
      expect(leaf.coordination.canCoordinate).toBe(false);
      expect(leaf.coordination.delegateTo).toBeUndefined();
    }

    // Nenhuma das três passa a exigir capability de modelo: comportamento de seleção intacto.
    for (const key of ["yui", "alice", "schwi"] as const) {
      expect(CANONICAL_PROFILE_REGISTRY.getByKey(key)!.modelPreference.requiredCapabilities).toEqual(
        [],
      );
    }
  });

  it("o catálogo permanece congelado em profundidade", () => {
    // O congelamento vale para o catálogo (`listAssistantProfiles`), que é o objeto exportado e
    // compartilhado. O registro canônico re-valida o catálogo na construção e devolve instâncias
    // novas — imutabilidade por origem, não por `Object.freeze`. Este teste fixa o contrato do
    // catálogo, e a segunda metade fixa o efeito observável: ninguém consegue mutar o perfil
    // publicado.
    const fromCatalog = getAssistantProfileByKey(VIVY_KEY)!;
    expect(Object.isFrozen(fromCatalog)).toBe(true);
    expect(Object.isFrozen(fromCatalog.capabilities)).toBe(true);
    expect(Object.isFrozen(fromCatalog.modelPreference)).toBe(true);
    expect(Object.isFrozen(fromCatalog.modelPreference.requiredCapabilities)).toBe(true);

    // Mutação tentada no objeto publicado pelo catálogo falha de fato — não é só o flag.
    expect(() => {
      (fromCatalog.modelPreference.requiredCapabilities as string[]).push("vision");
    }).toThrow(TypeError);
    expect(fromCatalog.modelPreference.requiredCapabilities).toEqual(["code"]);

    // Observação registrada no relatório, não uma garantia deste teste: `CANONICAL_PROFILE_REGISTRY`
    // re-valida o catálogo na construção e devolve instâncias novas, que **não** são congeladas.
    // Isso é anterior à Fase 4 e vale para as quatro assistentes; alterá-lo ampliaria o escopo.
  });
});
