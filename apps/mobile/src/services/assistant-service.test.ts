import { describe, expect, it, vi } from "vitest";
import { listAssistantProfiles } from "@nexus/assistant-profiles";
import { ApiError } from "./api-client.js";
import { abandonAssistantCatalog, loadAssistantCatalog } from "./assistant-service.js";
import {
  ASSISTANT_CATALOG,
  FALLBACK_CATALOG,
  applyCatalogFromApi,
  getAssistantByKey,
  resetAssistantCatalog,
  type AssistantApiRecord,
} from "../lib/assistants.js";

/**
 * Fase 2 (G6) — resiliência do fallback e isolamento entre sessões.
 *
 * O catálogo de apresentação passou a vir de `GET /v1/assistants`. Isso cria riscos que a lista
 * literal não tinha, e que precisam ser provados aqui:
 *
 * 1. disponibilidade — rede fora do ar não pode deixar o app sem assistentes;
 * 2. higiene de dados — resposta vazia, parcial ou corrompida não pode apagar o fallback;
 * 3. isolamento de sessão — o catálogo vive no módulo, então ele sobrevive a logout e a troca de
 *    conta se nada o resetar; o catálogo de uma sessão não pode servir a outra;
 * 4. ordenação de respostas — uma resposta lenta de uma chamada antiga não pode sobrescrever o
 *    catálogo que chegou depois.
 *
 * Nenhum teste aqui usa rede: `CoreService` é um dublê. O que se prova é o comportamento do
 * carregador diante de cada falha, não o servidor — esse é coberto pelos testes de rota.
 */

/** Um quarto assistente sintético. Não existe em produção; serve para detectar vazamento. */
const SYNTHETIC: AssistantApiRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  key: "delta",
  name: "DELTA",
  description: "Assistente sintético de teste.",
  primaryRole: "assistant",
  capabilities: ["testing"],
  status: "active",
};

function profilesAsRecords(): AssistantApiRecord[] {
  return listAssistantProfiles().map((profile) => ({
    id: profile.id,
    key: profile.key,
    name: profile.name,
    description: profile.description ?? "",
    primaryRole: profile.primaryRole,
    capabilities: [...profile.capabilities],
    status: profile.status,
  }));
}

function serviceReturning(payload: unknown) {
  return { listAssistants: vi.fn(async () => payload) };
}

function serviceFailing(error: unknown) {
  return {
    listAssistants: vi.fn(async () => {
      throw error;
    }),
  };
}

function catalogKeys(): string[] {
  return ASSISTANT_CATALOG.map((assistant) => assistant.key);
}

function fallbackKeys(): string[] {
  return FALLBACK_CATALOG.map((assistant) => assistant.key);
}

describe("Fase 2 — fallback sobrevive a indisponibilidade da API", () => {
  it("erro de rede não apaga o fallback local", async () => {
    resetAssistantCatalog();
    const service = serviceFailing(new ApiError({ kind: "network", message: "sem conexão" }));

    const outcome = await loadAssistantCatalog({ service, token: "token-a" });

    expect(outcome.status).toBe("unavailable");
    expect(catalogKeys()).toEqual(fallbackKeys());
    expect(getAssistantByKey("yui")).toBeDefined();
  });

  it("timeout, resposta 500 e falha de DNS têm o mesmo efeito: fallback intacto", async () => {
    const failures = [
      new ApiError({ kind: "network", message: "tempo esgotado" }),
      new ApiError({ kind: "http", message: "falha interna", status: 500 }),
      new Error("getaddrinfo ENOTFOUND"),
    ];

    for (const failure of failures) {
      resetAssistantCatalog();
      const outcome = await loadAssistantCatalog({
        service: serviceFailing(failure),
        token: "token-a",
      });
      expect(outcome.status, `falha ${String(failure)}`).toBe("unavailable");
      expect(catalogKeys()).toEqual(fallbackKeys());
    }
  });

  it("resposta inválida não apaga o fallback", async () => {
    const malformedPayloads: unknown[] = [
      null,
      undefined,
      "texto",
      [],
      {},
      { assistants: "não é lista" },
      { assistants: [{ key: "yui" }] },
      { assistants: [{ ...SYNTHETIC, key: "chave-inválida" }] },
      { assistants: [{ ...SYNTHETIC, key: "" }] },
    ];

    for (const payload of malformedPayloads) {
      resetAssistantCatalog();
      const outcome = await loadAssistantCatalog({
        service: serviceReturning(payload),
        token: "token-a",
      });
      expect(outcome.status, `payload ${JSON.stringify(payload)}`).toBe("invalid");
      expect(catalogKeys()).toEqual(fallbackKeys());
    }
  });

  it("catálogo vazio não deixa o aplicativo sem assistentes", async () => {
    resetAssistantCatalog();
    const outcome = await loadAssistantCatalog({
      service: serviceReturning({ assistants: [] }),
      token: "token-a",
    });

    // Lista vazia é um "sucesso" sintaticamente válido e ainda assim inútil: sem assistente o
    // usuário não abre conversa. O fallback permanece e o app continua utilizável.
    expect(outcome.status).toBe("invalid");
    expect(catalogKeys().length).toBeGreaterThan(0);
    expect(catalogKeys()).toEqual(fallbackKeys());
  });

  it("catálogo parcial é aplicado sem perder os assistentes ausentes do fallback", async () => {
    resetAssistantCatalog();
    const onlyYui = profilesAsRecords().filter((record) => record.key === "yui");

    const outcome = await loadAssistantCatalog({
      service: serviceReturning({ assistants: onlyYui }),
      token: "token-a",
    });
    expect(outcome.status).toBe("loaded");

    // O servidor é a fonte de verdade: se ele declarou só YUI como disponível, é isso que vale.
    // O que não se admite é o resultado ser vazio (coberto acima) ou conter lixo (coberto a
    // seguir) — e o fallback volta no próximo `resetAssistantCatalog`, nunca é destruído.
    expect(catalogKeys()).toEqual(["yui"]);
    // Fase 4: o fallback agora tem quatro perfis. O ponto do teste — o fallback não é destruído
    // por uma resposta parcial — continua idêntico.
    expect(fallbackKeys()).toEqual(["yui", "alice", "schwi", "vivy"]);
  });
});

describe("Fase 2 — catálogo não vaza entre sessões", () => {
  it("logout zera o catálogo recebido e restaura o fallback", async () => {
    resetAssistantCatalog();
    const outcome = await loadAssistantCatalog({
      service: serviceReturning({ assistants: [...profilesAsRecords(), SYNTHETIC] }),
      token: "token-a",
    });
    expect(outcome.status).toBe("loaded");
    expect(getAssistantByKey("delta")).toBeDefined();

    // Ao sair, o catálogo de quem estava logado não pode continuar visível.
    resetAssistantCatalog();
    expect(getAssistantByKey("delta")).toBeUndefined();
    expect(catalogKeys()).toEqual(fallbackKeys());
  });

  it("nova sessão recomeça do fallback até a própria API responder", async () => {
    resetAssistantCatalog();
    await loadAssistantCatalog({
      service: serviceReturning({ assistants: [...profilesAsRecords(), SYNTHETIC] }),
      token: "token-a",
    });
    expect(getAssistantByKey("delta")).toBeDefined();

    // Troca de sessão: o app volta ao fallback antes de buscar de novo.
    resetAssistantCatalog();
    const secondSession = await loadAssistantCatalog({
      service: serviceFailing(new ApiError({ kind: "network", message: "offline" })),
      token: "token-b",
    });

    expect(secondSession.status).toBe("unavailable");
    // Nem o catálogo da sessão anterior, nem lista vazia: o fallback de build.
    expect(getAssistantByKey("delta")).toBeUndefined();
    expect(catalogKeys()).toEqual(fallbackKeys());
  });

  it("o catálogo carregado não é compartilhado por referência entre sessões", async () => {
    resetAssistantCatalog();
    await loadAssistantCatalog({
      service: serviceReturning({ assistants: [...profilesAsRecords(), SYNTHETIC] }),
      token: "token-a",
    });
    const afterFirst = [...ASSISTANT_CATALOG];

    resetAssistantCatalog();
    // `resetAssistantCatalog` troca o conteúdo in-place; um snapshot antigo não pode mudar junto.
    expect(afterFirst.map((entry) => entry.key)).toEqual(["yui", "alice", "schwi", "vivy", "delta"]);
    expect(catalogKeys()).toEqual(fallbackKeys());
  });
});

describe("Fase 2 — resposta antiga não sobrescreve catálogo mais recente", () => {
  it("descarta uma resposta que chegou fora de ordem", async () => {
    resetAssistantCatalog();

    // Duas chamadas: a primeira (antiga) é lenta e traz o catálogo sintético; a segunda
    // (recente) responde imediatamente com o catálogo real.
    let releaseOld: ((payload: unknown) => void) | null = null;
    const oldService = {
      listAssistants: vi.fn(
        () =>
          new Promise((resolve) => {
            releaseOld = resolve;
          }),
      ),
    };
    const newService = serviceReturning({ assistants: profilesAsRecords() });

    const oldCall = loadAssistantCatalog({ service: oldService, token: "token-a" });
    const newCall = await loadAssistantCatalog({ service: newService, token: "token-a" });
    expect(newCall.status).toBe("loaded");

    // Agora a antiga finalmente responde — e não pode reverter o catálogo.
    releaseOld!({ assistants: [...profilesAsRecords(), SYNTHETIC] });
    await oldCall;

    expect(getAssistantByKey("delta")).toBeUndefined();
    expect(catalogKeys()).toEqual(fallbackKeys());
  });

  it("um carregamento iniciado numa sessão não aplica resultado na sessão seguinte", async () => {
    resetAssistantCatalog();

    let releaseStale: ((payload: unknown) => void) | null = null;
    const staleService = {
      listAssistants: vi.fn(
        () =>
          new Promise((resolve) => {
            releaseStale = resolve;
          }),
      ),
    };

    const staleCall = loadAssistantCatalog({ service: staleService, token: "token-a" });
    // Enquanto a chamada está no ar, o usuário sai e entra com outra conta. Sair **invalida**
    // as chamadas em voo — não basta limpar o array, senão a resposta antiga reaplica tudo.
    abandonAssistantCatalog();

    releaseStale!({ assistants: [...profilesAsRecords(), SYNTHETIC] });
    await staleCall;

    // O resultado da sessão anterior não pode aparecer para o novo usuário.
    expect(getAssistantByKey("delta")).toBeUndefined();
    expect(catalogKeys()).toEqual(fallbackKeys());
  });
});

describe("Fase 2 — aplicar catálogo manualmente continua seguro", () => {
  it("recusa lista vazia e mantém o catálogo atual", () => {
    resetAssistantCatalog();
    expect(applyCatalogFromApi([])).toBe(false);
    expect(catalogKeys()).toEqual(fallbackKeys());
  });

  it("recusa chave repetida sem aplicar metade da lista", () => {
    resetAssistantCatalog();
    const duplicated = [...profilesAsRecords(), profilesAsRecords()[0]!];
    expect(applyCatalogFromApi(duplicated)).toBe(false);
    expect(catalogKeys()).toEqual(fallbackKeys());
  });
});
