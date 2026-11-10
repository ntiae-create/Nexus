import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { listAssistantProfiles, getAssistantProfileByKey } from "@nexus/assistant-profiles";
import type { AssistantProfile } from "@nexus/assistant-profiles";
import { buildApp } from "../app.js";
import type { SessionConfig } from "../auth/session.js";
import type { AuthStore } from "../auth/store.js";

/**
 * Fase 2 — `GET /v1/assistants` servido do registro canônico (G4).
 *
 * Escrito ANTES da correção, por TDD. Antes dela, a rota respondia de um array literal próprio
 * (`apps/server/src/routes/assistants.ts`) e **não estava registrada** em `buildApp`, então tudo
 * aqui falhava com 404 — o defeito L9 registrado na Fase 0.
 *
 * O que este arquivo prova, e por que cada asserção existe:
 *
 * - A/B — paridade **campo a campo** com `packages/assistant-profiles`. Comparar o payload com o
 *   perfil, e não com valores escritos à mão, é o que impede o teste de virar uma terceira cópia
 *   do catálogo. Se o perfil mudar, o teste acompanha; se a rota divergir, o teste falha.
 * - B — uma quarta entrada no registro aparece na API **sem tocar a rota**. Esse é o critério de
 *   conclusão da fase. O perfil extra vive só no mock deste arquivo.
 * - C — a rota individual resolve a mesma fonte e preserva o comportamento de não encontrado.
 */

const TEST_OWNER_PASSWORD = "test-owner-password-only-not-secret";
const TEST_SESSION_CONFIG: SessionConfig = {
  secret: "0123456789abcdef0123456789abcdef0123456789abcdef",
  ownerPassword: TEST_OWNER_PASSWORD,
  ttlSeconds: 3600,
};

function createMockAuthStore(): AuthStore {
  const revoked = new Set<string>();
  return {
    isRevoked: async (jti) => revoked.has(jti),
    revoke: async (jti) => {
      revoked.add(jti);
    },
    recordFailure: async () => true,
    clearFailures: async () => undefined,
  };
}

async function createApp(): Promise<{ app: FastifyInstance; token: () => Promise<string> }> {
  const app = buildApp({
    logger: false,
    auth: { config: TEST_SESSION_CONFIG, store: createMockAuthStore() },
  });
  return {
    app,
    token: async () => {
      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { password: TEST_OWNER_PASSWORD },
      });
      expect(login.statusCode).toBe(200);
      return (login.json() as { token: string }).token;
    },
  };
}

interface AssistantPayload {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly primaryRole: string;
  readonly capabilities: readonly string[];
  readonly status: string;
}

describe("Fase 2 — GET /v1/assistants reflete o registro de perfis", () => {
  it("a rota está registrada na aplicação (regressão do defeito L9)", async () => {
    const { app, token } = await createApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/assistants",
        headers: { authorization: `Bearer ${await token()}` },
      });
      // Antes da Fase 2 esta requisição respondia 404: `registerAssistantRoutes` era exportada
      // mas nunca chamada por `buildApp`.
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("exige autenticação", async () => {
    const { app } = await createApp();
    try {
      const anonymous = await app.inject({ method: "GET", url: "/v1/assistants" });
      expect(anonymous.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("cada campo do payload é idêntico ao perfil, na ordem do registro", async () => {
    const { app, token } = await createApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/assistants",
        headers: { authorization: `Bearer ${await token()}` },
      });
      const body = response.json() as { assistants: AssistantPayload[] };
      const profiles = listAssistantProfiles();

      expect(body.assistants).toHaveLength(profiles.length);
      expect(body.assistants.map((assistant) => assistant.key)).toEqual(
        profiles.map((profile) => profile.key),
      );

      for (const [index, profile] of profiles.entries()) {
        const payload = body.assistants[index]!;
        // Comparação direta com o perfil — nunca com literais. Um valor "inventado, resumido ou
        // divergente" falha aqui, que é exatamente o defeito L9 da Fase 0.
        expect(payload).toEqual({
          id: profile.id,
          key: profile.key,
          name: profile.name,
          description: profile.description,
          primaryRole: profile.primaryRole,
          capabilities: profile.capabilities,
          status: profile.status,
        });
      }
    } finally {
      await app.close();
    }
  });

  it("não expõe campos internos do perfil além do contrato declarado", async () => {
    const { app, token } = await createApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/assistants",
        headers: { authorization: `Bearer ${await token()}` },
      });
      const body = response.json() as { assistants: Record<string, unknown>[] };
      // O perfil contém instruções operacionais; elas não podem vazar para o cliente.
      for (const assistant of body.assistants) {
        expect(assistant).not.toHaveProperty("behaviorInstructions");
        expect(assistant).not.toHaveProperty("configuration");
        expect(assistant).not.toHaveProperty("usageRestrictions");
        expect(assistant).not.toHaveProperty("memoryPolicy");
        expect(assistant).not.toHaveProperty("tools");
      }
    } finally {
      await app.close();
    }
  });
});

describe("Fase 2 — GET /v1/assistants/:key resolve a mesma fonte", () => {
  it("resolve por chave e devolve o mesmo payload da listagem", async () => {
    const { app, token } = await createApp();
    try {
      const bearer = { authorization: `Bearer ${await token()}` };
      const list = await app.inject({ method: "GET", url: "/v1/assistants", headers: bearer });
      const listed = (list.json() as { assistants: AssistantPayload[] }).assistants;

      for (const expected of listed) {
        const response = await app.inject({
          method: "GET",
          url: `/v1/assistants/${expected.key}`,
          headers: bearer,
        });
        expect(response.statusCode, `GET /v1/assistants/${expected.key}`).toBe(200);
        expect((response.json() as { assistant: AssistantPayload }).assistant).toEqual(expected);
      }
    } finally {
      await app.close();
    }
  });

  it("aceita o identificador canônico (UUID) além da chave", async () => {
    const { app, token } = await createApp();
    try {
      const alice = getAssistantProfileByKey("alice")!;
      for (const identifier of [alice.key, alice.id, alice.key.toUpperCase()]) {
        const response = await app.inject({
          method: "GET",
          url: `/v1/assistants/${identifier}`,
          headers: { authorization: `Bearer ${await token()}` },
        });
        expect(response.statusCode, `identificador '${identifier}'`).toBe(200);
        expect((response.json() as { assistant: AssistantPayload }).assistant.id).toBe(alice.id);
      }
    } finally {
      await app.close();
    }
  });

  it("preserva 404 e o código de erro existentes para chave inexistente", async () => {
    const { app, token } = await createApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/assistants/assistente-que-nao-existe",
        headers: { authorization: `Bearer ${await token()}` },
      });
      expect(response.statusCode).toBe(404);
      // Compatibilidade: a rota já respondia `NOT_FOUND` antes da fase. Não é o momento de
      // trocar o código por `ASSISTANT_NOT_FOUND` — mudaria o contrato do cliente à toa.
      expect((response.json() as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    } finally {
      await app.close();
    }
  });

  it("exige autenticação", async () => {
    const { app } = await createApp();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/assistants/yui" });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("Fase 2 — uma entrada nova no registro aparece na API sem tocar a rota", () => {
  // Chave e id sintéticos. NÃO existem no catálogo de produção e nunca são persistidos: o
  // registro estendido vive apenas neste arquivo de teste.
  //
  // Este é o critério de conclusão da fase. Provar que o perfil real aparece na API só mostraria
  // que a rota copiou os três certos — que é exatamente o que o array literal fazia. O que se
  // prova aqui é que a rota lê o registro: estender o registro basta, sem editar a rota.
  const SYNTHETIC: AssistantProfile = {
    ...listAssistantProfiles()[1]!,
    id: "11111111-1111-4111-8111-111111111111",
    key: "delta",
    name: "DELTA",
    description: "Perfil sintético de teste da Fase 2.",
    primaryRole: "Teste de registro",
    capabilities: ["phase2_synthetic"],
    status: "active",
  };

  async function createExtendedApp(): Promise<{
    app: FastifyInstance;
    token: () => Promise<string>;
  }> {
    const app = buildApp({
      logger: false,
      auth: { config: TEST_SESSION_CONFIG, store: createMockAuthStore() },
      assistants: {
        registry: {
          list: () => [...listAssistantProfiles(), SYNTHETIC],
          getByKey: (key: string) =>
            [...listAssistantProfiles(), SYNTHETIC].find((profile) => profile.key === key),
          getById: (id: string) =>
            [...listAssistantProfiles(), SYNTHETIC].find((profile) => profile.id === id),
        },
      },
    });
    return {
      app,
      token: async () => {
        const login = await app.inject({
          method: "POST",
          url: "/v1/auth/login",
          payload: { password: TEST_OWNER_PASSWORD },
        });
        expect(login.statusCode).toBe(200);
        return (login.json() as { token: string }).token;
      },
    };
  }

  it("o perfil sintético tem a forma completa de um perfil", () => {
    // Guarda contra teste vazio: se o objeto fosse incompleto, o teste abaixo passaria por
    // coincidência em vez de provar a leitura do registro.
    expect(SYNTHETIC.behaviorInstructions.length).toBeGreaterThan(0);
    expect(SYNTHETIC.key).toBe("delta");
  });

  it("a quarta entrada aparece na listagem sem qualquer alteração na rota", async () => {
    const { app, token } = await createExtendedApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/assistants",
        headers: { authorization: `Bearer ${await token()}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { assistants: AssistantPayload[] };
      expect(body.assistants).toHaveLength(4);
      expect(body.assistants.map((assistant) => assistant.key)).toEqual([
        "yui",
        "alice",
        "schwi",
        "delta",
      ]);
      expect(body.assistants.at(-1)).toEqual({
        id: SYNTHETIC.id,
        key: SYNTHETIC.key,
        name: SYNTHETIC.name,
        description: SYNTHETIC.description,
        primaryRole: SYNTHETIC.primaryRole,
        capabilities: SYNTHETIC.capabilities,
        status: SYNTHETIC.status,
      });
    } finally {
      await app.close();
    }
  });

  it("a rota individual resolve a quarta entrada pela chave e pelo id", async () => {
    const { app, token } = await createExtendedApp();
    try {
      const bearer = { authorization: `Bearer ${await token()}` };
      for (const identifier of [SYNTHETIC.key, SYNTHETIC.id]) {
        const response = await app.inject({
          method: "GET",
          url: `/v1/assistants/${identifier}`,
          headers: bearer,
        });
        expect(response.statusCode, `identificador '${identifier}'`).toBe(200);
        expect((response.json() as { assistant: AssistantPayload }).assistant.key).toBe("delta");
      }
    } finally {
      await app.close();
    }
  });

  it("o catálogo de produção continua com exatamente três perfis", () => {
    // Contrapeso explícito: nada do teste acima vaza para produção.
    expect(listAssistantProfiles().map((profile) => profile.key)).toEqual([
      "yui",
      "alice",
      "schwi",
    ]);
  });
});
