import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getAssistantProfileByKey } from "@nexus/assistant-profiles";

/**
 * Fase 0 — L9: inventário ESTRUTURAL, sem congelar defeito.
 *
 * Este arquivo substitui uma versão anterior que afirmava o 404 e o payload divergente como
 * comportamento observado — o que, na prática, os transformava em contrato. Não é isso que a
 * Fase 0 deve fazer. Aqui há apenas dois fatos, verificados por **estrutura de código**, e
 * nenhuma asserção sobre status HTTP ou valores de payload.
 *
 * Fato 1 (conectividade): `registerAssistantRoutes` está exportado em
 * `apps/server/src/routes/assistants.ts`, mas `buildApp` não o chama. Logo, a rota não participa
 * do aplicativo servido. Isto é registrado como **achado de inventário**, não como
 * comportamento esperado: nada aqui exige que continue assim.
 *
 * Fato 2 (conteúdo): a implementação não registrada mantém um array literal próprio, que
 * divergiria dos perfis canônicos se fosse servido. Isto também é achado, não contrato.
 *
 * Por que nenhuma asserção sobre 404/payload: um teste que exige 404 proíbe a correção da Fase 2;
 * um teste que exige o texto divergente proíbe corrigir o array. Ambos transformariam o defeito
 * em especificação. O que se pode afirmar com segurança é a **relação estrutural** entre os
 * arquivos — que é o que este arquivo faz.
 *
 * Critério de remoção: na Fase 2, quando a rota for registrada e derivar do registro, este
 * arquivo deve ser apagado em favor dos testes de paridade. Os testes abaixo falham nesse
 * momento de propósito, sinalizando que o inventário ficou obsoleto.
 */

const ROUTES_SOURCE = fileURLToPath(new URL("./assistants.ts", import.meta.url));
const APP_SOURCE = fileURLToPath(new URL("../app.ts", import.meta.url));

function readSource(path: string): string {
  return readFileSync(path, "utf8");
}

describe("Fase 0 — L9 fato 1: a rota não está conectada ao aplicativo", () => {
  it("registerAssistantRoutes existe e é exportado", () => {
    const source = readSource(ROUTES_SOURCE);
    expect(source).toMatch(/export function registerAssistantRoutes\s*\(/);
  });

  it("buildApp não chama registerAssistantRoutes (registro do achado, não do contrato)", () => {
    // Deliberadamente uma constatação do estado atual: quando a Fase 2 conectar a rota, este
    // teste falha e o arquivo é substituído pelos testes de paridade. Não há asserção de HTTP.
    const appSource = readSource(APP_SOURCE);
    expect(appSource).not.toContain("registerAssistantRoutes");
  });

  it("não importa a aplicação, então não pode observar nem exigir status HTTP", () => {
    // Guard anti-congelamento por RELAÇÃO: sem importar `buildApp`, este arquivo não tem como
    // fazer requisição alguma — logo não há como o 404 (ou qualquer status) virar asserção.
    // Verificamos os imports de fato, e não a presença de uma string de chamada.
    const ownSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const importSpecifiers = [...ownSource.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
    expect(importSpecifiers.some((specifier) => /app\.js$/.test(specifier))).toBe(false);
    expect(importSpecifiers.some((specifier) => /bootstrap\.js$/.test(specifier))).toBe(false);
  });
});

describe("Fase 0 — L9 fato 2: a implementação não registrada divergiria dos perfis", () => {
  it("documenta a divergência como achado, lida da fonte e não como payload aceito", () => {
    // Lê o array literal do arquivo da rota e compara com o perfil canônico. O resultado esperado
    // é a LISTA DE DIVERGÊNCIAS — isto é, o teste comprova que elas existem hoje. Não há
    // asserção de que os valores da rota estejam corretos, nem que devam permanecer.
    const entries = readRouteArray();
    expect(entries).toHaveLength(3);

    const divergences = entries.flatMap((entry) => {
      const profile = getAssistantProfileByKey(entry.key);
      expect(profile, `a chave '${entry.key}' consta na rota e deve existir no perfil`).toBeDefined();
      const fields: string[] = [];
      if (entry.description !== profile!.description) fields.push("description");
      if (entry.primaryRole !== profile!.primaryRole) fields.push("primaryRole");
      return fields.length > 0 ? [{ key: entry.key, fields }] : [];
    });

    // Duas camadas de leitura, ambas intencionais:
    // (a) a divergência existe;
    // (b) o PERFIL é a referência — nunca o array.
    expect(divergences.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const profile = getAssistantProfileByKey(entry.key)!;
      // O perfil é mais rico que o resumo da rota — sem comparar comprimentos por igualdade.
      expect(profile.description ?? "").not.toBe("");
      expect((profile.description ?? "").length).toBeGreaterThan(entry.description.length);
    }
  });

  it("delimita o defeito: o array só carrega campos de apresentação", () => {
    // Importa para dimensionar a Fase 2: não é vazamento de dados, é fonte de verdade duplicada.
    for (const entry of readRouteArray()) {
      expect(Object.keys(entry).sort()).toEqual(["description", "id", "key", "name", "primaryRole"]);
    }
  });

  it("não congela os valores divergentes (o teste é agnóstico ao texto do array)", () => {
    // Guard anti-congelamento construído por RELAÇÃO, não por literal: o conjunto de descrições
    // e papéis que este arquivo menciona não pode coincidir com os valores da rota. Se alguém
    // colar o payload divergente aqui como valor esperado, esta interseção deixa de ser vazia —
    // e o teste falha. Corrigir o array na Fase 2 não exige tocar neste arquivo.
    const ownSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const routeValues = readRouteArray().flatMap((entry) => [entry.description, entry.primaryRole]);
    const leaked = routeValues.filter((value) => ownSource.includes(value));
    expect(leaked).toEqual([]);
  });
});

interface RouteEntry {
  readonly key: string;
  readonly description: string;
  readonly primaryRole: string;
  readonly id: string;
  readonly name: string;
}

function readRouteArray(): readonly RouteEntry[] {
  const source = readSource(ROUTES_SOURCE);
  const pattern =
    /\{\s*id:\s*"([^"]+)",\s*key:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*description:\s*"([^"]*)",\s*primaryRole:\s*"([^"]*)"\s*\}/g;
  const entries: RouteEntry[] = [];
  for (const match of source.matchAll(pattern)) {
    entries.push({
      id: match[1]!,
      key: match[2]!,
      name: match[3]!,
      description: match[4]!,
      primaryRole: match[5]!,
    });
  }
  return entries;
}
