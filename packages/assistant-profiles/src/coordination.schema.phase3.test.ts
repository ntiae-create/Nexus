import { describe, expect, it } from "vitest";
import type { AssistantProfile } from "./profile.schema.js";

/**
 * Fase 3 (G2) — coordenação declarativa no schema de perfil.
 *
 * Escrito ANTES da implementação, por TDD. Antes desta fase o schema não tinha `coordination`:
 * a política de quem pode coordenar quem vivia em duas listas literais no servidor
 * (`DELEGATION_TARGETS` em `delegation.ts` e `canDelegateTo` em `engine.ts`), e uma quarta
 * assistente era estruturalmente incapaz de participar de coordenação.
 *
 * Regras de schema decididas para esta fase (validação **estrita**):
 *
 * - `canCoordinate: true` **exige** `delegateTo` com pelo menos um alvo — coordenar sem alvo
 *   seria uma declaração sem efeito, e é exatamente o tipo de ambiguidade que produz as duas
 *   fontes de verdade que esta fase elimina.
 * - `canCoordinate: false` **proíbe** `delegateTo` — declarar alvos sem poder coordenar é uma
 *   contradição silenciosa.
 * - Alvo precisa ser uma chave de formato válido (a existência é verificada no catálogo).
 * - Um perfil nunca pode declarar a si mesmo como alvo: ciclo de tamanho 1 é impossível por
 *   construção, e o validador não precisa gastar tempo descobrindo isso depois.
 */

const template: AssistantProfile = {
  id: "00000000-0000-4000-8000-0000000000aa",
  key: "coordinator",
  name: "COORDINATOR",
  description: "Perfil sintético usado apenas nos testes de schema.",
  configVersion: "1.0.0",
  profileVersion: "1.0.0",
  status: "active",
  primaryRole: "Assistente de teste",
  personality: ["objetiva"],
  behaviorInstructions: ["Cumpra a tarefa solicitada."],
  communicationPreferences: {
    tone: "neutro",
    style: "direto",
    verbosity: "concise",
    structure: ["frases curtas"],
  },
  capabilities: ["testing"],
  tools: [],
  usageRestrictions: ["Nunca invente resultados."],
  memoryPolicy: {
    individual: "own_assistant_only",
    shared: "explicit_item_grant_required",
    permissionAuthority: "backend",
  },
  metadata: { lifecycle: "initial", tags: ["test"], extensible: true },
  configuration: { instructions: ["Responda de forma objetiva."], profileSchemaVersion: 1 },
} as AssistantProfile;

async function schema() {
  return import("./profile.schema.js");
}

function withCoordination(coordination: unknown): unknown {
  return { ...template, coordination };
}

describe("Fase 3 — o campo `coordination` existe e é validado", () => {
  it("aceita uma declaração completa de coordenação", async () => {
    const { assistantProfileSchema } = await schema();
    const parsed = assistantProfileSchema.safeParse(
      withCoordination({ canCoordinate: true, delegateTo: ["alice", "schwi"] }),
    );
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("aceita uma folha que não coordena", async () => {
    const { assistantProfileSchema } = await schema();
    const parsed = assistantProfileSchema.safeParse(withCoordination({ canCoordinate: false }));
    expect(parsed.success).toBe(true);
  });

  it("rejeita perfil sem `coordination` — a política é obrigatória, não opcional", async () => {
    // Obrigatória de propósito: um campo opcional deixaria perfis antigos sem política e
    // reintroduziria o "não declarado, logo padrão implícito" que a fase elimina.
    const { assistantProfileSchema } = await schema();
    expect(assistantProfileSchema.safeParse(template).success).toBe(false);
  });

  it("rejeita `canCoordinate: true` sem nenhum alvo", async () => {
    const { assistantProfileSchema } = await schema();
    expect(
      assistantProfileSchema.safeParse(withCoordination({ canCoordinate: true })).success,
    ).toBe(false);
    expect(
      assistantProfileSchema.safeParse(withCoordination({ canCoordinate: true, delegateTo: [] }))
        .success,
    ).toBe(false);
  });

  it("rejeita `canCoordinate: false` com alvos declarados", async () => {
    const { assistantProfileSchema } = await schema();
    expect(
      assistantProfileSchema.safeParse(
        withCoordination({ canCoordinate: false, delegateTo: ["alice"] }),
      ).success,
    ).toBe(false);
  });

  it("rejeita alvo com formato de chave inválido", async () => {
    const { assistantProfileSchema } = await schema();
    for (const badKey of ["", "YUI", "1abc", "a", "chave com espaço", "chave_com_underscore"]) {
      expect(
        assistantProfileSchema.safeParse(
          withCoordination({ canCoordinate: true, delegateTo: [badKey] }),
        ).success,
        `chave inválida aceita: ${JSON.stringify(badKey)}`,
      ).toBe(false);
    }
  });

  it("rejeita a própria chave como alvo (ciclo de tamanho 1)", async () => {
    const { assistantProfileSchema } = await schema();
    expect(
      assistantProfileSchema.safeParse(
        withCoordination({ canCoordinate: true, delegateTo: ["coordinator"] }),
      ).success,
    ).toBe(false);
  });

  it("rejeita alvos repetidos", async () => {
    const { assistantProfileSchema } = await schema();
    expect(
      assistantProfileSchema.safeParse(
        withCoordination({ canCoordinate: true, delegateTo: ["alice", "alice"] }),
      ).success,
    ).toBe(false);
  });

  it("rejeita campos desconhecidos em `coordination` (strict)", async () => {
    const { assistantProfileSchema } = await schema();
    expect(
      assistantProfileSchema.safeParse(
        withCoordination({ canCoordinate: true, delegateTo: ["alice"], canDelegateTo: ["alice"] }),
      ).success,
    ).toBe(false);
  });

  it("rejeita mais de 10 alvos — o máximo do plano (§7.2)", async () => {
    const { assistantProfileSchema } = await schema();
    const eleven = Array.from({ length: 11 }, (_, index) => `alvo-${index}`);
    expect(
      assistantProfileSchema.safeParse(
        withCoordination({ canCoordinate: true, delegateTo: eleven }),
      ).success,
    ).toBe(false);
  });
});

describe("Fase 3 — validação cruzada no catálogo", () => {
  it("rejeita alvo que não existe no catálogo", async () => {
    const { createAssistantProfileCatalogSchema } = await schema();
    const parsed = createAssistantProfileCatalogSchema().safeParse([
      { ...template, coordination: { canCoordinate: true, delegateTo: ["inexistente"] } },
    ]);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("inexistente");
  });

  it("aceita alvo que existe no catálogo", async () => {
    const { createAssistantProfileCatalogSchema } = await schema();
    const leaf = { ...template, id: "00000000-0000-4000-8000-0000000000bb", key: "leaf" };
    const parsed = createAssistantProfileCatalogSchema().safeParse([
      { ...template, coordination: { canCoordinate: true, delegateTo: ["leaf"] } },
      { ...leaf, coordination: { canCoordinate: false } },
    ]);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("rejeita ciclo direto entre dois perfis", async () => {
    // a → b e b → a. O validador de plano já rejeitaria em execução, mas um catálogo que se
    // contradiz nem deveria carregar: o erro fica no boot, não na conversa do usuário.
    const { createAssistantProfileCatalogSchema } = await schema();
    const a = { ...template, id: "00000000-0000-4000-8000-0000000000aa", key: "alpha" };
    const b = { ...template, id: "00000000-0000-4000-8000-0000000000bb", key: "beta" };
    const parsed = createAssistantProfileCatalogSchema().safeParse([
      { ...a, coordination: { canCoordinate: true, delegateTo: ["beta"] } },
      { ...b, coordination: { canCoordinate: true, delegateTo: ["alpha"] } },
    ]);
    expect(parsed.success).toBe(false);
  });

  it("rejeita ciclo indireto de três perfis", async () => {
    const { createAssistantProfileCatalogSchema } = await schema();
    const make = (key: string, suffix: string, to: string) => ({
      ...template,
      id: `00000000-0000-4000-8000-0000000000${suffix}`,
      key,
      coordination: { canCoordinate: true, delegateTo: [to] },
    });
    const parsed = createAssistantProfileCatalogSchema().safeParse([
      make("alpha", "aa", "beta"),
      make("beta", "bb", "gamma"),
      make("gamma", "cc", "alpha"),
    ]);
    expect(parsed.success).toBe(false);
  });

  it("aceita cadeia sem ciclo (a → b → c)", async () => {
    const { createAssistantProfileCatalogSchema } = await schema();
    const parsed = createAssistantProfileCatalogSchema().safeParse([
      {
        ...template,
        id: "00000000-0000-4000-8000-0000000000aa",
        key: "alpha",
        coordination: { canCoordinate: true, delegateTo: ["beta"] },
      },
      {
        ...template,
        id: "00000000-0000-4000-8000-0000000000bb",
        key: "beta",
        coordination: { canCoordinate: true, delegateTo: ["gamma"] },
      },
      {
        ...template,
        id: "00000000-0000-4000-8000-0000000000cc",
        key: "gamma",
        coordination: { canCoordinate: false },
      },
    ]);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});
