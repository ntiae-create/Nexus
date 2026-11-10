import { describe, expect, it, vi } from "vitest";
import type { AssistantProfile } from "@nexus/assistant-profiles";
import { CoreExecutionError } from "./errors.js";

/**
 * Fase 1 — prova de que `assistantKeyOf` decide pelo **registro**, não pelo enum.
 *
 * Por que este arquivo existe separado: os testes de `assistant-identity.phase1.test.ts` usam o
 * catálogo real, onde as três chaves pertencem tanto ao enum quanto ao registro. Nesse cenário,
 * "valida contra o registro" e "valida contra o enum" produzem o mesmo resultado — os testes
 * passariam com a implementação antiga, e portanto não provariam nada sobre G3.
 *
 * Aqui o registro é **substituído por um que contém um quarto assistente**, em memória. Nenhum
 * arquivo de produção é alterado, nenhum perfil real é criado e nada é persistido: o que se
 * prova é a única propriedade que importa nesta fase — se a decisão consulta o registro, o
 * quarto assistente passa a ser aceito **sem alterar código**.
 *
 * Limite declarado: isto verifica a resolução de identidade isoladamente. A criação real de uma
 * quarta assistente depende de perfil, seed e rotas — Fases 2 a 4, fora do escopo aqui.
 */

// `vi.mock` é içado para o topo do arquivo; só `vi.hoisted` compartilha estado com a fábrica.
const { SYNTHETIC_FOURTH } = vi.hoisted(() => {
  const base: AssistantProfile = {
    id: "00000000-0000-4000-8000-000000000002",
    key: "alice",
    name: "ALICE",
  } as AssistantProfile;
  return {
    SYNTHETIC_FOURTH: {
      ...base,
      id: "11111111-1111-4111-8111-111111111111",
      key: "delta",
      name: "DELTA",
    } as AssistantProfile,
  };
});

vi.mock("@nexus/assistant-profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@nexus/assistant-profiles")>();
  const extended = [...actual.listAssistantProfiles(), SYNTHETIC_FOURTH];
  return {
    ...actual,
    listAssistantProfiles: () => extended,
    getAssistantProfileByKey: (key: string) => extended.find((profile) => profile.key === key),
    getAssistantProfileById: (id: string) => extended.find((profile) => profile.id === id),
  };
});

const { listAssistantProfiles, getAssistantProfileByKey } = await import(
  "@nexus/assistant-profiles"
);
const { assistantKeyOf, resolveCanonicalAssistantProfile } = await import("./instructions.js");

describe("Fase 1 — a decisão vem do registro (G3), provado com registro estendido", () => {
  it("o registro em teste realmente contém a quarta assistente", () => {
    // Guarda contra teste vazio: se o mock não pegasse, os testes abaixo passariam por engano.
    expect(listAssistantProfiles().map((profile) => profile.key)).toContain("delta");
    expect(getAssistantProfileByKey("delta")?.name).toBe("DELTA");
  });

  it("assistantKeyOf aceita um perfil registrado fora do catálogo inicial", () => {
    // Com a implementação anterior (enumeração de três literais) isto lançava
    // ASSISTANT_NOT_FOUND: era o bloqueio mais direto para uma quarta assistente.
    expect(assistantKeyOf(SYNTHETIC_FOURTH)).toBe("delta");
  });

  it("resolveCanonicalAssistantProfile resolve a quarta assistente por chave e por id", () => {
    expect(resolveCanonicalAssistantProfile({ assistantKey: "delta" }).id).toBe(
      SYNTHETIC_FOURTH.id,
    );
    expect(resolveCanonicalAssistantProfile({ assistantId: SYNTHETIC_FOURTH.id }).key).toBe("delta");
    // Coerência id↔key continua exigida também para o perfil novo.
    expect(() =>
      resolveCanonicalAssistantProfile({
        assistantId: SYNTHETIC_FOURTH.id,
        assistantKey: "alice",
      }),
    ).toThrow(CoreExecutionError);
  });

  it("uma chave registrada continua recusada se não corresponder ao próprio perfil", () => {
    // A validação não virou "aceite qualquer coisa que esteja no registro": o perfil precisa ser
    // o dono da chave que reivindica.
    const impostor: AssistantProfile = {
      ...SYNTHETIC_FOURTH,
      id: SYNTHETIC_FOURTH.id.replace("1111", "2222"),
    };
    expect(() => assistantKeyOf(impostor)).toThrow(CoreExecutionError);
  });

  it("chave bem formada e NÃO registrada continua sendo ASSISTANT_NOT_FOUND", () => {
    const error = (() => {
      try {
        resolveCanonicalAssistantProfile({ assistantKey: "omega" });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(CoreExecutionError);
    expect((error as CoreExecutionError).code).toBe("ASSISTANT_NOT_FOUND");
  });
});
