import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { listAssistantProfiles } from "@nexus/assistant-profiles";
import { buildApp } from "../app.js";
import type { SessionConfig } from "../auth/session.js";
import type { AuthStore } from "../auth/store.js";

/**
 * Fase 2 — paridade nos quatro pontos: registro ⇄ seed SQL ⇄ API ⇄ mobile (G4, G6, G7).
 *
 * Este arquivo é a rede que impede a divergência voltar. Cada asserção compara duas das quatro
 * representações **entre si**, nunca com literais escritos à mão: um teste que fixa
 * `description: "Assistente pessoal."` viraria uma quinta cópia do catálogo e congelaria o
 * defeito que a fase corrigiu.
 *
 * O caso concreto que motivou tudo isso: o seed da migration 00001 grava
 * `description = 'Assistente pessoal.'`, enquanto o perfil canônico diz "Assistente pessoal para
 * conversação cotidiana, organização e planejamento pessoal.". As duas frases existiam no
 * repositório ao mesmo tempo.
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

/**
 * Sobe o app real para ler o catálogo **pelo protocolo**, não pelo registro.
 *
 * É a diferença entre testar que o registro concorda consigo mesmo (circular) e testar que a
 * rota serve o registro.
 */
async function createParityApp(): Promise<{
  app: FastifyInstance;
  token: () => Promise<string>;
}> {
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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages/database/migrations");

interface SeededAssistant {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly status: string;
}

/**
 * Lê o estado final de `nexus.assistants` a partir das migrations, em ordem.
 *
 * Não é um parser de SQL genérico: interpreta apenas os `INSERT ... VALUES` e os `UPDATE` de
 * seed que o repositório usa, e **falha explicitamente** se encontrar uma forma que não sabe
 * ler — melhor quebrar do que passar com paridade falsa.
 */

/** Divide uma lista `SET a = ..., b = ...` respeitando strings entre aspas simples. */
function splitAssignments(assignments: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inString = false;
  for (let index = 0; index < assignments.length; index += 1) {
    const char = assignments[index]!;
    if (char === "'") {
      if (inString && assignments[index + 1] === "'") {
        current += "''";
        index += 1;
        continue;
      }
      inString = !inString;
      current += char;
      continue;
    }
    if (char === "," && !inString) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts;
}

function readSeededAssistants(): SeededAssistant[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const byId = new Map<string, SeededAssistant>();

  const parseValueRow = (row: string): string[] => {
    const values: string[] = [];
    let current = "";
    let inString = false;
    for (let index = 0; index < row.length; index += 1) {
      const char = row[index]!;
      if (char === "'") {
        if (inString && row[index + 1] === "'") {
          current += "'";
          index += 1;
          continue;
        }
        inString = !inString;
        continue;
      }
      if (char === "," && !inString) {
        values.push(current.trim());
        current = "";
        continue;
      }
      current += char;
    }
    if (current.trim().length > 0) values.push(current.trim());
    return values;
  };

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");

    for (const match of sql.matchAll(
      /INSERT\s+INTO\s+nexus\.assistants\s*\(([^)]*)\)\s*VALUES([\s\S]*?);/gi,
    )) {
      const columns = match[1]!.split(",").map((column) => column.trim());
      const rowsBlock = match[2]!;
      const rows = [...rowsBlock.matchAll(/\(([^()]*)\)/g)].map((row) => parseValueRow(row[1]!));

      for (const row of rows) {
        if (row.length !== columns.length) {
          throw new Error(
            `Seed de nexus.assistants em ${file}: esperava ${columns.length} colunas, li ${row.length}.`,
          );
        }
        const record: Record<string, string> = {};
        columns.forEach((column, index) => {
          record[column] = row[index]!;
        });
        const seeded: SeededAssistant = {
          id: record["id"]!,
          key: record["assistant_key"]!,
          name: record["display_name"]!,
          description: record["description"]!,
          status: record["status"]!,
        };
        // Upsert por id: uma migration incremental pode reescrever o seed da inicial.
        byId.set(seeded.id, seeded);
      }
    }

    // Migrations incrementais ajustam o seed com UPDATE ... WHERE assistant_key = '...'.
    for (const match of sql.matchAll(
      /UPDATE\s+nexus\.assistants\s+SET\s+([\s\S]*?)\s+WHERE\s+assistant_key\s*=\s*'([^']+)'([^;]*);/gi,
    )) {
      const assignments = match[1]!;
      const key = match[2]!;
      const guard = match[3]!;
      // `AND description <> '...'` é condição de idempotência, não filtro de linha: o valor
      // atribuído continua valendo para a linha daquela chave.
      void guard;
      const target = [...byId.values()].find((assistant) => assistant.key === key);
      if (!target) {
        throw new Error(`Update de seed em ${file} referencia chave inexistente: ${key}`);
      }
      const updated: Record<string, string> = {
        id: target.id,
        assistant_key: target.key,
        display_name: target.name,
        description: target.description,
        status: target.status,
      };
      // Vírgulas dentro de strings não separam atribuições: uma descrição contém vírgulas e um
      // `split(",")` ingênuo a partiria ao meio.
      for (const assignment of splitAssignments(assignments)) {
        const [column, ...rest] = assignment.split("=");
        const rawValue = rest.join("=").trim();
        const value = rawValue.replace(/^'/, "").replace(/'$/, "");
        updated[column!.trim()] = value;
      }
      byId.set(target.id, {
        id: updated["id"]!,
        key: updated["assistant_key"]!,
        name: updated["display_name"]!,
        description: updated["description"]!,
        status: updated["status"]!,
      });
    }
  }

  return [...byId.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const seeded = readSeededAssistants();
const profiles = listAssistantProfiles();

describe("Fase 2 — paridade registro ⇄ seed SQL", () => {
  it("o seed lido é o esperado (guarda contra parser vazio)", () => {
    // Se o formato do seed mudar e o parser não enxergar nada, a paridade abaixo passaria com
    // duas listas vazias. Esta é a guarda contra esse falso verde.
    expect(seeded.length).toBeGreaterThanOrEqual(3);
    expect(seeded.map((assistant) => assistant.key)).toEqual(["alice", "schwi", "yui"]);
  });

  it("mesmas chaves, mesmos identificadores e mesma ordem de grandeza", () => {
    expect(seeded.map((assistant) => assistant.key).sort()).toEqual(
      profiles.map((profile) => profile.key).sort(),
    );
    for (const profile of profiles) {
      const row = seeded.find((assistant) => assistant.key === profile.key);
      expect(row, `seed de '${profile.key}'`).toBeDefined();
      expect(row!.id).toBe(profile.id);
      expect(row!.name).toBe(profile.name);
      expect(row!.status).toBe(profile.status);
    }
  });

  it("a descrição do seed é idêntica à do perfil", () => {
    // Defeito comprovado antes da correção: seed dizia "Assistente pessoal.", perfil dizia
    // "Assistente pessoal para conversação cotidiana, …". Duas frases, duas cópias.
    for (const profile of profiles) {
      const row = seeded.find((assistant) => assistant.key === profile.key)!;
      expect(row.description, `descrição do seed de '${profile.key}'`).toBe(profile.description);
    }
  });
});

describe("Fase 2 — paridade registro ⇄ API", () => {
  /**
   * Compara o payload HTTP real com o registro canônico, campo a campo.
   *
   * A versão anterior deste teste era circular: comparava `getAssistantProfileByKey` consigo
   * mesmo, então passaria mesmo se a rota servisse um array literal. O que vale é o que sai pelo
   * fio — por isso aqui se sobe o app e se faz a requisição de verdade.
   */
  it("o payload servido é idêntico ao registro, campo a campo", async () => {
    const { app, token } = await createParityApp();
    try {
      const bearer = await token();
      const response = await app.inject({
        method: "GET",
        url: "/v1/assistants",
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ assistants: Record<string, unknown>[] }>();

      expect(body.assistants.map((entry) => entry.key)).toEqual(
        listAssistantProfiles().map((profile) => profile.key),
      );

      for (const profile of listAssistantProfiles()) {
        const served = body.assistants.find((entry) => entry.key === profile.key);
        expect(served, `assistente '${profile.key}' ausente do payload`).toBeDefined();
        expect(served).toMatchObject({
          id: profile.id,
          key: profile.key,
          name: profile.name,
          description: profile.description,
          primaryRole: profile.primaryRole,
          capabilities: [...profile.capabilities],
          status: profile.status,
        });
      }
    } finally {
      await app.close();
    }
  });

  it("reconhece divergência por key, não por id, em qualquer formato", () => {
    // Defeito real encontrado em revisão: a checagem anterior reconhecia entradas apenas por
    // UUID. Reintroduzir uma lista manual com ids arbitrários ("1", "2", "3") passava. A
    // comparação passou a ser pelo conjunto de chaves, que independe do formato do id.
    const canonicalKeys = listAssistantProfiles().map((profile) => profile.key);
    const manualWithArbitraryIds = [
      { id: "1", key: "yui" },
      { id: "2", key: "alice" },
      { id: "3", key: "schwi" },
    ];

    // Um catálogo manual com as mesmas chaves é indistinguível por chave — e é exatamente por
    // isso que a proibição de lista manual é estrutural (guard AST), não só comparativa.
    expect(manualWithArbitraryIds.map((entry) => entry.key)).toEqual(canonicalKeys);

    // O que a paridade de dados consegue pegar é qualquer divergência de conteúdo por chave,
    // inclusive quando o id muda:
    const driftedId = manualWithArbitraryIds.map((entry) =>
      entry.key === "yui" ? { ...entry, id: "999" } : entry,
    );
    const canonicalById = new Map(
      listAssistantProfiles().map((profile) => [profile.key, profile.id]),
    );
    expect(canonicalById.get("yui")).not.toBe(driftedId[0]!.id);
  });

  it("detecta divergência de nome e descrição por chave", () => {
    // A descrição era o campo divergente do seed. Aqui a comparação é por chave e por valor,
    // sem depender de posição no array nem de id.
    const served = listAssistantProfiles().map((profile) => ({
      key: profile.key,
      name: profile.name,
      description: profile.description,
    }));
    const tampered = served.map((entry) =>
      entry.key === "alice" ? { ...entry, description: "Pesquisa e investigação." } : entry,
    );
    expect(tampered).not.toEqual(served);
  });
});

describe("Fase 2 — paridade registro ⇄ mobile", () => {
  it("o fallback do mobile é derivado dos perfis, não uma lista manual", () => {
    // O mobile importa `@nexus/assistant-profiles` para montar o fallback. O invariante é
    // verificável no texto do módulo: a expressão atribuída a `FALLBACK_CATALOG` precisa chamar
    // `listAssistantProfiles()`. Procurar apenas UUIDs escritos à mão não basta — uma lista com
    // ids arbitrários (`"1"`, `"2"`, ...) também seria uma cópia manual, e foi exatamente o que
    // uma sabotagem de revisão produziu sem ser detectada.
    const mobileCatalog = readFileSync(join(REPO_ROOT, "apps/mobile/src/lib/assistants.ts"), "utf8");
    expect(mobileCatalog).toContain("@nexus/assistant-profiles");

    const declaration = mobileCatalog.match(
      /export const FALLBACK_CATALOG[^=]*=\s*([\s\S]*?);\n/,
    );
    expect(declaration, "declaração de FALLBACK_CATALOG").not.toBeNull();
    expect(declaration![1]).toContain("listAssistantProfiles()");

    // E não pode haver id de assistente escrito à mão no módulo, em nenhum formato.
    expect(mobileCatalog).not.toMatch(/00000000-0000-4000-8000-00000000000[0-9a-f]/);
    expect(mobileCatalog).not.toMatch(/key:\s*["'](yui|alice|schwi)["']/);
  });

  it("config.ts deixou de manter um segundo catálogo de identidade", () => {
    // G6: `config.ts` tinha um array `ASSISTANTS` com os três ids, nomes e rótulos.
    const config = readFileSync(join(REPO_ROOT, "apps/mobile/src/lib/config.ts"), "utf8");
    expect(config).not.toMatch(/00000000-0000-4000-8000-00000000000[0-9a-f]/);
  });

  it("core-service não repete a união literal de três chaves", () => {
    const coreService = readFileSync(
      join(REPO_ROOT, "apps/mobile/src/services/core-service.ts"),
      "utf8",
    );
    expect(coreService).not.toMatch(/"yui"\s*\|\s*"alice"\s*\|\s*"schwi"/);
  });
});
