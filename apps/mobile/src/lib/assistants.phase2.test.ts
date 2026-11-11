import { describe, expect, it } from "vitest";
import { getAssistantProfileByKey, listAssistantProfiles } from "@nexus/assistant-profiles";
import {
  ASSISTANT_CATALOG,
  FALLBACK_CATALOG,
  applyCatalogFromApi,
  getAssistantByKey,
  getAssistantById,
  getConversationAssistants,
  resetAssistantCatalog,
  resolveAssistantLabel,
  type AssistantApiRecord,
} from "./assistants.js";

/**
 * Fase 2 — catálogo mobile alimentado pela API, com fallback de build (G6).
 *
 * Escrito ANTES da correção, por TDD. Antes dela, o app tinha **duas** listas literais
 * independentes (`lib/assistants.ts` e `lib/config.ts`) e nenhuma forma de receber o catálogo do
 * servidor: adicionar um assistente exigia editar o mobile.
 *
 * O desenho testado aqui:
 *
 * - **fallback** — derivado dos perfis congelados (fonte compartilhada), nunca de uma lista
 *   manual nova. Garante que o app abre offline com YUI/ALICE/SCHWI disponíveis.
 * - **API** — quando a resposta chega, ela substitui o fallback. O servidor é a fonte de verdade
 *   em execução; o fallback é só o ponto de partida.
 * - **seleção por conversa** — o app nunca oferece um assistente fora de `assistantIds` da
 *   conversa atual, mesmo que a API traga mais assistentes que o servidor aceitaria.
 */

const API_RECORD: AssistantApiRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  key: "yui",
  name: "YUI",
  description: "Assistente pessoal para conversação cotidiana, organização e planejamento pessoal.",
  primaryRole: "Assistente pessoal",
  capabilities: ["conversation", "planning"],
  status: "active",
};

describe("Fase 2 — fallback de build derivado dos perfis", () => {
  it("o fallback cobre exatamente os três assistentes congelados, na ordem do registro", () => {
    // Derivado, não copiado: se o catálogo canônico mudar, o fallback acompanha no próximo build.
    expect(FALLBACK_CATALOG.map((assistant) => assistant.key)).toEqual(
      listAssistantProfiles().map((profile) => profile.key),
    );
  });

  it("o fallback preserva id, chave e nome de cada perfil", () => {
    for (const profile of listAssistantProfiles()) {
      const fallback = FALLBACK_CATALOG.find((assistant) => assistant.key === profile.key);
      expect(fallback, `fallback de '${profile.key}'`).toBeDefined();
      expect(fallback!.id).toBe(profile.id);
      expect(fallback!.name).toBe(profile.name);
    }
  });

  it("o app inicia com o fallback disponível, sem depender de rede", () => {
    // Estado inicial do módulo: nenhuma chamada de API aconteceu.
    // Fase 4: o fallback acompanha o catálogo, que passou a ter quatro perfis. Continua sem
    // qualquer chamada de rede — só o build.
    expect(ASSISTANT_CATALOG.map((assistant) => assistant.key)).toEqual([
      "yui",
      "alice",
      "schwi",
      "vivy",
    ]);
    expect(getAssistantByKey("yui")?.name).toBe("YUI");
  });

  it("o fallback é congelado: nenhuma tela pode mutar o catálogo em runtime", () => {
    expect(Object.isFrozen(FALLBACK_CATALOG)).toBe(true);
    expect(Object.isFrozen(FALLBACK_CATALOG[0])).toBe(true);
  });
});

describe("Fase 2 — catálogo alimentado pela API", () => {
  it("a resposta da API substitui o fallback", () => {
    try {
      applyCatalogFromApi([API_RECORD]);
      expect(ASSISTANT_CATALOG).toHaveLength(1);
      // Campos vindos do servidor, não do fallback: prova de que a API é a fonte em execução.
      expect(getAssistantByKey("yui")!.description).toBe(API_RECORD.description);
      expect(getAssistantByKey("yui")!.primaryRole).toBe(API_RECORD.primaryRole);
    } finally {
      resetAssistantCatalog();
    }
  });

  it("uma entrada nova na API fica disponível sem alterar o app", () => {
    const fourth: AssistantApiRecord = {
      ...API_RECORD,
      id: "11111111-1111-4111-8111-111111111111",
      key: "delta",
      name: "DELTA",
    };
    try {
      applyCatalogFromApi([...listAssistantProfiles().map(toRecord), fourth]);
      expect(getAssistantByKey("delta")?.name).toBe("DELTA");
      expect(getAssistantById(fourth.id)?.key).toBe("delta");
    } finally {
      resetAssistantCatalog();
    }
  });

  it("resposta vazia ou inválida não substitui o fallback", () => {
    // Um servidor desatualizado não pode deixar o app sem catálogo.
    const fallbackSize = FALLBACK_CATALOG.length;
    expect(fallbackSize).toBe(4);

    applyCatalogFromApi([]);
    expect(ASSISTANT_CATALOG).toHaveLength(fallbackSize);

    applyCatalogFromApi([{ ...API_RECORD, key: "INVÁLIDA" }]);
    expect(ASSISTANT_CATALOG).toHaveLength(fallbackSize);

    applyCatalogFromApi([API_RECORD, { ...API_RECORD }]);
    expect(ASSISTANT_CATALOG).toHaveLength(fallbackSize);
  });

  it("reset volta ao fallback", () => {
    applyCatalogFromApi([API_RECORD]);
    resetAssistantCatalog();
    expect(ASSISTANT_CATALOG.map((assistant) => assistant.key)).toEqual([
      "yui",
      "alice",
      "schwi",
      "vivy",
    ]);
  });
});

describe("Fase 2 — seleção continua restrita à conversa", () => {
  it("oferece apenas assistentes presentes em assistantIds, na ordem do servidor", () => {
    const alice = getAssistantProfileByKey("alice")!;
    const schwi = getAssistantProfileByKey("schwi")!;
    const selected = getConversationAssistants([schwi.id, alice.id]);
    expect(selected.map((assistant) => assistant.key)).toEqual(["schwi", "alice"]);
  });

  it("um assistente do catálogo fora da conversa NÃO é oferecido", () => {
    // Mesmo conhecendo YUI pelo catálogo, se a conversa não a inclui, o app não pode oferecê-la:
    // o servidor responderia ASSISTANT_NOT_IN_CONVERSATION.
    const alice = getAssistantProfileByKey("alice")!;
    expect(getConversationAssistants([alice.id]).map((a) => a.key)).toEqual(["alice"]);
  });

  it("id desconhecido é ignorado, não inventado", () => {
    const alice = getAssistantProfileByKey("alice")!;
    const selected = getConversationAssistants(["00000000-0000-4000-8000-0000000000ff", alice.id]);
    expect(selected.map((assistant) => assistant.key)).toEqual(["alice"]);
  });
});

describe("Fase 2 — rótulos de mensagem preservados", () => {
  it("resolve o nome por metadata.assistantKey e por id", () => {
    expect(resolveAssistantLabel({ metadata: { assistantKey: "alice" } })).toBe("ALICE");
    const schwi = getAssistantProfileByKey("schwi")!;
    expect(resolveAssistantLabel({ assistantId: schwi.id })).toBe("SCHWI");
  });

  it("autor desconhecido devolve null em vez de adivinhar", () => {
    expect(resolveAssistantLabel({ assistantId: "00000000-0000-4000-8000-0000000000ff" })).toBeNull();
    expect(resolveAssistantLabel({})).toBeNull();
  });
});

function toRecord(profile: {
  id: string;
  key: string;
  name: string;
  description?: string | undefined;
  primaryRole: string;
  capabilities: readonly string[];
  status: string;
}): AssistantApiRecord {
  return {
    id: profile.id,
    key: profile.key,
    name: profile.name,
    description: profile.description ?? "",
    primaryRole: profile.primaryRole,
    capabilities: [...profile.capabilities],
    status: profile.status,
  };
}
