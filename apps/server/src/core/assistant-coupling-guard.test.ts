import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { listAssistantProfiles } from "@nexus/assistant-profiles";

/**
 * Fase 0 — guard estrutural de acoplamento (Etapa 3C.3).
 *
 * Este arquivo NÃO é um contrato dos três assistentes iniciais. Ele é um **inventário
 * executável** dos pontos em que o código pressupõe exatamente YUI/ALICE/SCHWI, e existe para
 * falhar quando um acoplamento *novo e indevido* aparecer.
 *
 * Regra de desenho: o catálogo legítimo (perfis, seed, rótulos de apresentação) é permitido.
 * O que o guard barra é a **duplicação da fonte de verdade** — listas de chaves recriadas em
 * código que não é catálogo, porque é essa duplicação que impede uma quarta assistente de
 * existir sem editar vários arquivos (ver §1.9 do plano e a Fase 1).
 *
 * Por que não basta "contar perfis": adicionar um quarto perfil ao catálogo quebra apenas os
 * testes do próprio catálogo e o espelho do mobile. Delegacia, engine, rotas e ferramentas
 * continuam verdes porque carregam listas próprias — foi exatamente isso que o experimento
 * controlado da Fase 0 mostrou. O guard cobre essa lacuna.
 */

const REPO_ROOT = ((): string => {
  let current = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (
      existsSync(join(current, "package-lock.json")) &&
      existsSync(join(current, "packages", "assistant-profiles", "src", "catalog.ts"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`repository root not found from ${process.cwd()}`);
})();

const INITIAL_KEYS = ["yui", "alice", "schwi"] as const;

/** Diretórios de código de produção varridos pelo guard (sem testes nem documentos). */
const SCANNED_DIRECTORIES = ["apps/server/src", "apps/mobile/src", "packages"] as const;

function collectSourceFiles(directory: string): string[] {
  const absolute = resolve(REPO_ROOT, directory);
  const found: string[] = [];

  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      if (entry === "node_modules" || entry === "dist" || entry === "build") continue;
      const full = join(path, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      // Testes têm legitimidade para citar chaves concretas ao montar fixtures.
      if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
      found.push(full);
    }
  };

  walk(absolute);
  return found;
}

interface CouplingSite {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Um "acoplamento indevido" é uma literal contendo **duas ou mais** chaves iniciais na mesma
 * linha. Uma chave isolada é dado (`assistantKey: "yui"` em fixture interna, `["alice"]` como
 * autorização de ferramenta); duas ou mais na mesma expressão é uma lista recriada, ou seja,
 * uma segunda fonte de verdade.
 */
function findHardcodedKeyLists(files: readonly string[]): CouplingSite[] {
  const sites: CouplingSite[] = [];
  const keyPattern = new RegExp(`["'](${INITIAL_KEYS.join("|")})["']`, "g");

  for (const file of files) {
    const contents = readFileSync(file, "utf8");
    contents.split("\n").forEach((line, index) => {
      const commentIndex = line.indexOf("//");
      const code = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
      const matches = [...code.matchAll(keyPattern)].map((match) => match[1]);
      const distinct = new Set(matches);
      if (distinct.size >= 2) {
        sites.push({
          file: relative(REPO_ROOT, file),
          line: index + 1,
          text: line.trim().slice(0, 120),
        });
      }
    });
  }

  return sites;
}

/**
 * Locais onde recriar a lista é **legítimo e esperado** nesta fase. A entrada é por arquivo e
 * por motivo declarado; qualquer outro arquivo com lista literal é acoplamento novo.
 *
 * Esta lista é um **inventário**, não um contrato permanente: a Fase 1 remove a maior parte
 * destes pontos ao separar identificador de catálogo, e cada remoção deve apagar a entrada
 * correspondente aqui.
 */
const ALLOWED_LITERAL_LISTS: readonly { readonly file: string; readonly reason: string }[] = [
  {
    file: "packages/shared/src/schemas/assistants.ts",
    reason: "raiz do enum InitialAssistantKey — o acoplamento que a Fase 1 vai desmontar (G1)",
  },
  {
    file: "apps/server/src/core/delegation.ts",
    reason: "mapa estático de alvos de delegação — resolvido por dados na Fase 3 (G2)",
  },
  {
    file: "apps/server/src/core/engine.ts",
    reason: "duplica a lista de alvos ao montar o prompt do coordenador — Fase 3 (G2)",
  },
  {
    file: "apps/server/src/routes/core.ts",
    reason: "redefine o domínio de chaves na rota em vez de reutilizar o schema — Fase 1 (G1)",
  },
  {
    file: "apps/mobile/src/lib/config.ts",
    reason: "catálogo de apresentação do mobile (rótulos/cores) — Fase 1 unifica (G4)",
  },
  {
    file: "apps/mobile/src/services/core-service.ts",
    reason: "união literal duplicando InitialAssistantKey — Fase 1 substitui pelo tipo canônico (G1)",
  },
  {
    file: "apps/mobile/src/lib/assistants.ts",
    reason: "espelho do catálogo congelado — BOM (bom o bastante), protege contra divergência",
  },
  {
    file: "packages/assistant-profiles/src/catalog.ts",
    reason: "catálogo canônico dos perfis — é a fonte de verdade, não uma cópia",
  },
];

describe("Fase 0 — inventário de acoplamento aos três assistentes iniciais", () => {
  const files = SCANNED_DIRECTORIES.flatMap((directory) => collectSourceFiles(directory));

  it("encontra os arquivos-fonte esperados (guard contra varredura vazia)", () => {
    expect(files.length).toBeGreaterThan(50);
    // Dois pontos-âncora que obrigatoriamente existem hoje.
    expect(files.some((file) => file.endsWith("apps/server/src/core/delegation.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("packages/shared/src/schemas/assistants.ts"))).toBe(
      true,
    );
  });

  it("não introduz lista literal de chaves fora do inventário conhecido", () => {
    const sites = findHardcodedKeyLists(files);
    const allowed = new Set(ALLOWED_LITERAL_LISTS.map((entry) => entry.file));
    const unexpected = sites.filter((site) => !allowed.has(site.file));

    expect(
      unexpected,
      [
        "Lista literal de chaves de assistente encontrada fora do inventário da Fase 0.",
        "Isso recria a fonte de verdade e impede uma quarta assistente sem editar vários arquivos.",
        "Se o novo ponto for legítimo, adicione-o a ALLOWED_LITERAL_LISTS com o motivo e a fase",
        "que vai resolvê-lo — e não transforme esta lista em contrato permanente.",
      ].join(" "),
    ).toEqual([]);
  });

  it("mantém cada ponto do inventário declarado com um motivo", () => {
    const filesWithLists = new Set(findHardcodedKeyLists(files).map((site) => site.file));
    const allowed = new Set(ALLOWED_LITERAL_LISTS.map((entry) => entry.file));

    // Todo arquivo com lista precisa estar declarado...
    expect([...filesWithLists].filter((file) => !allowed.has(file))).toEqual([]);
    // ...e toda declaração precisa ter motivo não vazio (evita entrada "esquecida").
    for (const entry of ALLOWED_LITERAL_LISTS) {
      expect(entry.reason.length).toBeGreaterThan(10);
    }
  });

  it("não confunde dados de exemplo, fixtures nem permissões genéricas com acoplamento", () => {
    // Estes arquivos citam chaves concretas legitimamente e NÃO devem aparecer no inventário:
    // - `packages/tools/src/examples.ts`: `authorizedAssistantKeys` é `z.array(z.string())`,
    //   não derivado do enum — é dado de catálogo de ferramenta, não segunda fonte de verdade;
    // - `apps/mobile/src/test-support/core-fixtures.ts`: fixtures de contrato, tipadas pelos
    //   schemas de `@nexus/shared`, consumidas por testes.
    // O guard só varre código de produção e ignora `*.test.ts`, então estes arquivos sequer
    // são candidatos; este teste documenta a razão para que ninguém os adicione "por simetria".
    const scanned = SCANNED_DIRECTORIES.flatMap((directory) => collectSourceFiles(directory));
    // Arquivos de teste são excluídos por padrão de nome...
    expect(scanned.some((file) => /\.(test|spec)\.tsx?$/.test(file))).toBe(false);
    // ...mas `test-support/core-fixtures.ts` não casa esse padrão e É varrido. Ele não entra no
    // inventário porque nunca forma lista com 2+ chaves na mesma linha (as fixtures citam uma
    // chave por campo). É o critério correto: dado pontual é permitido, lista recriada não.
    expect(scanned.some((file) => file.endsWith("test-support/core-fixtures.ts"))).toBe(true);
    const fixtureSites = findHardcodedKeyLists(
      scanned.filter((file) => file.endsWith("test-support/core-fixtures.ts")),
    );
    expect(fixtureSites).toEqual([]);

    // E o catálogo de ferramentas declara autorização como lista de strings, não como enum:
    // se algum dia passar a usar `initialAssistantKeySchema`, o acoplamento muda de natureza e
    // este teste precisa ser revisto junto com o inventário.
    const toolsSchema = readFileSync(
      resolve(REPO_ROOT, "packages/tools/src/schemas.ts"),
      "utf8",
    );
    expect(toolsSchema).toContain("authorizedAssistantKeys: z.array(");
    expect(toolsSchema).not.toMatch(/authorizedAssistantKeys:\s*[^\n]*initialAssistantKeySchema/);
  });

  it("não deixa o inventário crescer silenciosamente: tamanho é explícito", () => {
    // Deliberadamente numérico. Um acoplamento novo obriga a atualizar este número **e** o
    // motivo da entrada, o que força revisão consciente em vez de um `--update` cego.
    expect(ALLOWED_LITERAL_LISTS).toHaveLength(8);
  });

  it("não escreve chaves de assistente em código de produção do engine além do mapa de alvos", () => {
    // O engine hoje repete ["alice","schwi"]. Este teste documenta o ponto e trava o
    // surgimento de um segundo literal de chaves no mesmo arquivo.
    const enginePath = resolve(REPO_ROOT, "apps/server/src/core/engine.ts");
    const contents = readFileSync(enginePath, "utf8");
    const keyPattern = new RegExp(`["'](${INITIAL_KEYS.join("|")})["']`, "g");
    const linesWithKeys = contents
      .split("\n")
      .filter((line) => new Set([...line.matchAll(keyPattern)].map((match) => match[1])).size >= 2);

    expect(linesWithKeys.length).toBe(1);
  });
});

describe("Fase 0 — o catálogo legítimo continua sendo a fonte de verdade", () => {
  it("expõe exatamente os perfis congelados, na ordem do catálogo", () => {
    // Caracteriza o comportamento INTENCIONAL: o catálogo é a fonte; o guard acima é que
    // impede cópias. Este teste não impede a quarta assistente — ele apenas descreve o hoje.
    expect(listAssistantProfiles().map((profile) => profile.key)).toEqual([...INITIAL_KEYS]);
  });

  it("cada perfil tem identidade estável e única", () => {
    const profiles = listAssistantProfiles();
    const ids = new Set(profiles.map((profile) => profile.id));
    expect(ids.size).toBe(profiles.length);
    for (const profile of profiles) {
      expect(profile.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(profile.key).toBe(profile.key.toLowerCase());
    }
  });
});
