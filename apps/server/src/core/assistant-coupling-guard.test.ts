import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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
 * código que não é catálogo.
 *
 * Por que análise estrutural e não "duas chaves na mesma linha": a detecção anterior deixava
 * passar o caso mais comum de formatação, que é a lista multilinha:
 *
 *     const targets = [
 *       "yui",
 *       "alice",
 *     ];
 *
 * O analisador abaixo remove comentários, isola literais de string, e então procura **grupos**
 * de chaves separadas apenas por pontuação de lista (vírgula, barra vertical, conteúdo de
 * array/enum) em qualquer quantidade de linhas. Chave isolada não é acoplamento; dado pontual
 * (`assistantKey: "yui"`) continua permitido.
 */

const REPO_ROOT = ((): string => {
  let current = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      if (
        readFileSync(join(current, "package.json"), "utf8").includes('"name"') &&
        statSync(join(current, "packages", "assistant-profiles", "src", "catalog.ts")).isFile()
      ) {
        return current;
      }
    } catch {
      // diretório sem package.json: segue subindo
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`repository root not found from ${process.cwd()}`);
})();

const INITIAL_KEYS = ["yui", "alice", "schwi"] as const;
const SCANNED_DIRECTORIES = ["apps/server/src", "apps/mobile/src", "packages"] as const;

/**
 * Remove comentários de bloco e de linha, preservando o número de linhas para que o relatório
 * aponte a posição correta. Strings ficam intactas aqui — são tratadas na fase de análise.
 */
export function stripComments(source: string): string {
  let result = "";
  let index = 0;
  let inBlockComment = false;
  let inLineComment = false;
  let stringQuote: string | null = null;

  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        result += char;
      } else {
        result += " ";
      }
      index += 1;
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        result += "  ";
        index += 2;
        continue;
      }
      result += char === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }

    if (stringQuote) {
      result += char;
      if (char === "\\") {
        result += next ?? "";
        index += 2;
        continue;
      }
      if (char === stringQuote) stringQuote = null;
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      result += "  ";
      index += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      result += "  ";
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      stringQuote = char;
      result += char;
      index += 1;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

const KEY_TOKEN = new RegExp(`^["'\`](${INITIAL_KEYS.join("|")})["'\`]$`);

/**
 * Encontra **grupos** de chaves de assistente que formam uma lista literal.
 *
 * A varredura percorre os tokens relevantes (chaves em string e separadores de lista) na ordem
 * em que aparecem no arquivo, **atravessando linhas**. Um grupo é acumulado enquanto o que
 * separa duas chaves é apenas pontuação de lista: `,`, `|`, `[`, `]`, `(`, `)`, espaço, seta de
 * tipo (`as const`), ou conteúdo de array. Qualquer outro token (por exemplo `:` seguido de
 * valor, ou uma propriedade de objeto entre as chaves) encerra o grupo.
 */
/**
 * Linha (1-based) de um offset. Calculada sob demanda — o tokenizador de listas antes fazia isso
 * de forma incremental, mas separar em uma função única evita duas noções divergentes de linha.
 */
function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

export interface CouplingGroup {
  readonly keys: readonly string[];
  readonly line: number;
}

export function findCouplingGroups(rawSource: string): CouplingGroup[] {
  const source = stripComments(rawSource);

  // Tokeniza tudo o que pode ocorrer entre duas chaves: chaves em string, "pontes" de lista
  // (vírgula, colchete, parêntese, barra de união, `as const`) e **qualquer outro token**, que
  // funciona como quebra de contexto. Sem o terceiro grupo, `;` e identificadores seriam
  // ignorados e duas listas distintas no mesmo arquivo seriam fundidas em uma só — um falso
  // negativo grave. O processamento é em streaming (sem array intermediário) e a linha é
  // contada de forma incremental: com um token por caractere, `slice(0, index).split()` por
  // token seria quadrático e o guard estouraria o tempo de teste.
  const tokenRegex =
    /(["'`])((?:[^"'`\\]|\\.)*)\1|([,[\]()|]|\bas\s+const\b)|([^\s])/g;

  const groups: CouplingGroup[] = [];
  let current: string[] = [];
  let startLine = 0;
  let line = 1;
  let cursor = 0;

  const advanceTo = (index: number): void => {
    for (; cursor < index; cursor += 1) {
      if (source[cursor] === "\n") line += 1;
    }
  };

  const flush = (): void => {
    // Só forma acoplamento com 2+ chaves DISTINTAS. Chave repetida (ex.: `"yui"` duas vezes
    // em contextos distintos) não caracteriza lista de alvos.
    if (new Set(current).size >= 2) {
      groups.push({ keys: [...new Set(current)], line: startLine });
    }
    current = [];
  };

  for (const match of source.matchAll(tokenRegex)) {
    advanceTo(match.index ?? 0);

    if (match[1]) {
      const literal = `${match[1]}${match[2]}${match[1]}`;
      if (KEY_TOKEN.test(literal)) {
        if (current.length === 0) startLine = line;
        current.push(match[2] ?? "");
      } else {
        flush();
      }
      continue;
    }
    if (match[3]) continue; // ponte: mantém o grupo aberto
    flush(); // qualquer outro token encerra o grupo
  }
  flush();

  return groups;
}

/**
 * Segundo padrão de acoplamento: **catálogo de objetos**.
 *
 * `apps/mobile/src/lib/config.ts`, `apps/mobile/src/lib/assistants.ts`, `routes/assistants.ts` e
 * `packages/assistant-profiles/src/catalog.ts` não têm lista literal de chaves — têm uma
 * sequência de objetos `{ key: "yui", … }, { key: "alice", … }`. Um detector de lista de strings
 * não os vê, e é justamente isso que os torna cópias silenciosas da fonte de verdade.
 *
 * **Cada declaração é uma ocorrência independente.** A implementação anterior juntava todas as
 * propriedades `key:` do arquivo num único grupo, e a assinatura `catalog:arquivo::chaves` ficava
 * idêntica para duas listas distintas com o mesmo conjunto de chaves — ou seja, declarar uma
 * liberava a outra. Aqui cada objeto/array é delimitado estruturalmente e recebe **âncora de
 * contexto**: o encadeamento de identificadores que o contém (`ASSISTANTS`, `profiles`, …).
 *
 * A âncora é estável por construção: não usa número de linha, então reformatar o arquivo não
 * muda a identidade — renomear o container, sim, e nesse caso a revisão da allowlist é
 * desejável.
 */
export interface CatalogOccurrence {
  readonly keys: readonly string[];
  readonly line: number;
  readonly offset: number;
  /** Encadeamento de containers que delimita a ocorrência: `PROFILES`, `a.b`, `<expr>`. */
  readonly anchor: string;
}

const CATALOG_KEY_PROPERTY = /\b(?:key|assistantKey)\s*:\s*(["'`])(yui|alice|schwi)\1/g;

/** Índices dos delimitadores de abertura/fechamento, respeitando strings e template literals. */
function matchingDelimiter(source: string, openIndex: number): number {
  const open = source[openIndex]!;
  const close = open === "[" ? "]" : open === "{" ? "}" : null;
  if (close === null) return -1;

  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === '"' || char === "'" || char === "`") {
      index += 1;
      while (index < source.length && source[index] !== char) {
        if (source[index] === "\\") index += 1;
        index += 1;
      }
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Delimitador que contém `index`, do mais interno para o mais externo. */
function enclosingDelimiter(source: string, index: number): { open: number; close: number } | null {
  let depth = 0;
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const char = source[cursor]!;
    if (char === "]") depth += 1;
    else if (char === "[") {
      if (depth === 0) {
        const close = matchingDelimiter(source, cursor);
        if (close > index) return { open: cursor, close };
      } else depth -= 1;
    }
  }
  return null;
}

/**
 * Nome do container que abre `source` antes de `openIndex`.
 *
 * Usa a última declaração (`const|let|var`) anterior ao delimitador, e não o texto imediatamente
 * à esquerda: `const RAW_CATALOG: readonly {…}[] = [` tem uma anotação de tipo entre o nome e o
 * `[`, e uma leitura do vizinho imediato devolveria `<expr>`. É esse nome que distingue
 * `ASSISTANTS` de `ASSISTANTS_MIRROR` — e o que faz a identidade sobreviver a reformatação,
 * porque não depende de linha nem de offset.
 */
function anchorBefore(source: string, openIndex: number): string {
  const prefix = source.slice(0, openIndex);
  if (/\bexport\s+default\s*$/.test(prefix)) return "export default";

  let name: string | null = null;
  for (const match of prefix.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    name = match[1]!;
  }
  if (name !== null) return name;

  // Sem declaração: ainda pode ser uma propriedade (`assistants: [`, `return [`).
  const chain = /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*:\s*$/.exec(prefix);
  return chain ? chain[1]!.replace(/\s+/g, "") : "<expr>";
}

/**
 * Extrai as ocorrências de catálogo de um arquivo.
 *
 * Uma ocorrência é o **menor delimitador** (array ou objeto) que contém uma propriedade de chave
 * — exceto uma chave solta dentro de um objeto que não é entrada de catálogo, como
 * `{ assistantKey: "yui" }` numa chamada: um único objeto sem irmãos não é catálogo. Agrupar por
 * delimitador é o que separa duas listas no mesmo arquivo mesmo quando uma é filha da outra.
 */
export function findCatalogDeclarations(rawSource: string): CatalogOccurrence[] {
  const source = stripComments(rawSource);

  const occurrences = new Map<number, { offset: number; keys: string[] }>();
  for (const match of source.matchAll(CATALOG_KEY_PROPERTY)) {
    const offset = match.index ?? 0;
    const delimiter = enclosingDelimiter(source, offset);
    if (delimiter === null) continue;
    const existing = occurrences.get(delimiter.open);
    if (existing) {
      existing.keys.push(match[2]!);
    } else {
      occurrences.set(delimiter.open, { offset, keys: [match[2]!] });
    }
  }

  const result: CatalogOccurrence[] = [];
  for (const [openIndex, occurrence] of occurrences) {
    const distinct = [...new Set(occurrence.keys)];
    // Um único objeto `{ key: "yui" }` é dado pontual, não catálogo: exige 2+ chaves distintas.
    if (distinct.length < 2) continue;
    result.push({
      keys: distinct,
      line: lineOf(source, occurrence.offset),
      offset: occurrence.offset,
      anchor: anchorBefore(source, openIndex),
    });
  }
  result.sort((a, b) => a.offset - b.offset);

  // Dois catálogos com o MESMO nome no mesmo arquivo (`const CATALOG` duplicado) ainda precisam
  // ser distinguíveis. O ordinal dentro do arquivo resolve isso e continua estável sob
  // reformatação; só é aplicado quando há colisão, então o caso normal fica com o nome puro.
  const total = new Map<string, number>();
  for (const occurrence of result) {
    total.set(occurrence.anchor, (total.get(occurrence.anchor) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return result.map((occurrence) => {
    if ((total.get(occurrence.anchor) ?? 0) < 2) return occurrence;
    const ordinal = (seen.get(occurrence.anchor) ?? 0) + 1;
    seen.set(occurrence.anchor, ordinal);
    return { ...occurrence, anchor: `${occurrence.anchor}#${ordinal}` };
  });
}

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
      if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
      found.push(full);
    }
  };
  walk(absolute);
  return found;
}

/**
 * Allowlist por **ocorrência**, nunca por arquivo.
 *
 * Cada entrada identifica um grupo específico: arquivo + chaves do grupo + motivo + fase que a
 * remove. Uma lista nova no mesmo arquivo não é coberta — ela aparece como não declarada,
 * porque a comparação é feita por assinatura (arquivo + conjunto de chaves), não por prefixo.
 */
export type CouplingPattern = "list" | "catalog";

export interface AllowedOccurrence {
  readonly file: string;
  readonly keys: readonly string[];
  readonly pattern: CouplingPattern;
  /**
   * Onde a ocorrência vive dentro do arquivo, para o padrão `catalog`: o container que a delimita
   * (`ASSISTANTS`, `profiles`, …). Sem isso, duas listas de objetos com as mesmas chaves no mesmo
   * arquivo teriam a mesma assinatura. Ignorado no padrão `list`, onde o conjunto de chaves já
   * distingue as ocorrências.
   */
  readonly anchor?: string;
  readonly reason: string;
  /**
   * Fase responsável por eliminar esta ocorrência — ou `"permanente"` quando a ocorrência **não
   * deve** ser removida por ser ela própria a fonte de verdade (o catálogo canônico de perfis).
   * Um valor de fase aqui é uma promessa: a fase que remover o ponto também remove a entrada
   * (verificado pelo teste "toda ocorrência declarada ainda existe").
   */
  readonly removedIn: string;
}

/**
 * Identidade de uma ocorrência: padrão + arquivo + **container** + conjunto de chaves.
 *
 * O container entra apenas em `catalog`, onde duas listas de objetos podem ter exatamente as
 * mesmas chaves. Não entra número de linha: reformatar o arquivo não pode invalidar a allowlist,
 * mas renomear o container deve — é uma mudança estrutural e merece revisão.
 */
export function signatureOf(
  file: string,
  keys: readonly string[],
  pattern: CouplingPattern,
  anchor?: string,
): string {
  const base = `${pattern}:${file}::${[...keys].sort().join(",")}`;
  return pattern === "catalog" ? `${base}@${anchor ?? "<expr>"}` : base;
}

export const ALLOWED_OCCURRENCES: readonly AllowedOccurrence[] = [
  {
    file: "packages/shared/src/schemas/assistants.ts",
    keys: ["yui", "alice", "schwi"],
    pattern: "list",
    reason: "raiz do enum InitialAssistantKey — o acoplamento que a Fase 1 vai desmontar (G1)",
    removedIn: "Fase 1",
  },
  {
    file: "apps/server/src/core/delegation.ts",
    // O analisador encontra a lista de ALVOS (`yui: ["alice","schwi"]`), não as chaves do mapa:
    // é essa lista que precisa deixar de existir para a quarta assistente entrar em coordenação.
    keys: ["alice", "schwi"],
    pattern: "list",
    reason: "mapa estático de alvos de delegação — resolvido por dados (G2)",
    removedIn: "Fase 3",
  },
  {
    file: "apps/server/src/core/engine.ts",
    keys: ["alice", "schwi"],
    pattern: "list",
    reason: "duplica a lista de alvos ao montar o prompt do coordenador (G2)",
    removedIn: "Fase 3",
  },
  {
    file: "apps/server/src/routes/core.ts",
    keys: ["yui", "alice", "schwi"],
    pattern: "list",
    reason: "redefine o domínio de chaves na rota em vez de reutilizar o schema (G1)",
    removedIn: "Fase 1",
  },
  {
    file: "apps/mobile/src/services/core-service.ts",
    keys: ["yui", "alice", "schwi"],
    pattern: "list",
    reason: "união literal duplicando InitialAssistantKey — substituída pelo tipo canônico (G1)",
    removedIn: "Fase 1",
  },
  {
    file: "apps/mobile/src/lib/assistants.ts",
    keys: ["yui", "alice", "schwi"],
    pattern: "catalog",
    anchor: "RAW_CATALOG",
    reason: "espelho do catálogo congelado — proteção válida, não cópia de lógica",
    removedIn: "Fase 1",
  },
  {
    file: "apps/mobile/src/lib/config.ts",
    keys: ["yui", "alice", "schwi"],
    pattern: "catalog",
    anchor: "ASSISTANTS",
    reason: "catálogo de apresentação do mobile (rótulos/cores) — Fase 1 unifica (G4)",
    removedIn: "Fase 1",
  },
  {
    file: "apps/server/src/routes/assistants.ts",
    keys: ["yui", "alice", "schwi"],
    pattern: "catalog",
    anchor: "ASSISTANTS",
    reason: "array literal da rota L9 — corrigido por derivação do registro na Fase 2",
    removedIn: "Fase 2",
  },
  {
    file: "packages/assistant-profiles/src/catalog.ts",
    keys: ["yui", "alice", "schwi"],
    pattern: "catalog",
    anchor: "profiles",
    reason: "catálogo canônico dos perfis — é a fonte de verdade, não uma cópia",
    // Não é remoção: quando `InitialAssistantKey` for generalizado (Fase 1), o catálogo
    // continua sendo o catálogo. Marcar uma fase aqui prometeria uma remoção que não acontece.
    removedIn: "permanente",
  },
];

/** Todas as ocorrências (lista e catálogo) com a assinatura que as identifica. */
function allSignatures(): Set<string> {
  return new Set(
    ALLOWED_OCCURRENCES.map((entry) =>
      signatureOf(entry.file, entry.keys, entry.pattern, entry.anchor),
    ),
  );
}

describe("Fase 0 — analisador de listas de assistentes", () => {
  it("detecta lista de duas chaves na mesma linha", () => {
    const groups = findCouplingGroups('const targets = ["yui", "alice"] as const;');
    expect(groups.map((group) => group.keys)).toEqual([["yui", "alice"]]);
  });

  it("detecta lista de duas chaves em linhas diferentes", () => {
    const groups = findCouplingGroups(
      ['const targets = [', '  "yui",', '  "alice",', '];'].join("\n"),
    );
    expect(groups).toHaveLength(1);
    expect(new Set(groups[0]!.keys)).toEqual(new Set(["yui", "alice"]));
    // `line` aponta a primeira chave encontrada (linha 2), não o colchete.
    expect(groups[0]!.line).toBe(2);
  });

  it("detecta união de tipos multilinha e enum", () => {
    const union = findCouplingGroups(
      ['type Key =', '  | "yui"', '  | "alice";'].join("\n"),
    );
    expect(union).toHaveLength(1);
    expect(new Set(union[0]!.keys)).toEqual(new Set(["yui", "alice"]));

    const enums = findCouplingGroups(
      ['z.enum([', '  "yui",', '  "alice",', '  "schwi",', '])'].join("\n"),
    );
    expect(enums).toHaveLength(1);
    expect(new Set(enums[0]!.keys)).toEqual(new Set(["yui", "alice", "schwi"]));
  });

  it("não acusa comentários nem documentação", () => {
    const commented = [
      "// alvos: [\"yui\", \"alice\"]",
      "/*",
      '  const x = ["yui", "alice"];',
      "*/",
      '/** Delega para "yui" ou "alice". */',
    ].join("\n");
    expect(findCouplingGroups(commented)).toEqual([]);
  });

  it("não acusa chave isolada", () => {
    expect(findCouplingGroups('send({ assistantKey: "yui" });')).toEqual([]);
    expect(findCouplingGroups('const only = "alice";')).toEqual([]);
    // Duas ocorrências da MESMA chave também não formam lista de alvos.
    expect(findCouplingGroups('const a = "yui"; const b = "yui";')).toEqual([]);
  });

  it("não atravessa contexto que não é lista", () => {
    // Chaves em objetos distintos, separadas por propriedades, não são uma lista.
    const objectEntries = [
      '{ key: "yui", name: "YUI" },',
      '{ key: "alice", name: "ALICE" },',
    ].join("\n");
    const groups = findCouplingGroups(objectEntries);
    // Cada entrada tem só uma chave de assistente; o resto são propriedades.
    expect(groups).toEqual([]);
  });
});

describe("Fase 0 — testes negativos obrigatórios (entradas sintéticas)", () => {
  // Nenhum fixture temporário em disco: todas as entradas são strings em memória, então estes
  // testes não tocam arquivos de produção e não dependem de limpeza posterior.

  it("1. detecta lista literal de duas chaves na mesma linha", () => {
    expect(findCouplingGroups('const t = ["yui", "alice"] as const;')).toHaveLength(1);
  });

  it("2. detecta lista literal de duas chaves em linhas diferentes", () => {
    const groups = findCouplingGroups(['const t = [', '  "yui",', '  "schwi",', '];'].join("\n"));
    expect(groups).toHaveLength(1);
    expect(new Set(groups[0]!.keys)).toEqual(new Set(["yui", "schwi"]));
  });

  it("3. detecta segunda lista indevida em arquivo que já tem ocorrência legítima", () => {
    // O parâmetro `file` da assinatura é o que impede a liberação por arquivo: a mesma origem
    // com outro conjunto de chaves não casa com a ocorrência declarada.
    const allowed = allSignatures();
    const secondList = signatureOf(
      "packages/shared/src/schemas/assistants.ts",
      ["alice", "schwi"],
      "list",
    );
    expect(allowed.has(secondList)).toBe(false);

    // E o analisador realmente encontra as duas listas no mesmo texto:
    const source = [
      'export const a = z.enum(["yui", "alice", "schwi"]);',
      'const extra = [',
      '  "alice",',
      '  "schwi",',
      '];',
    ].join("\n");
    expect(findCouplingGroups(source)).toHaveLength(2);
  });

  it("4. não acusa comentários nem strings documentais", () => {
    const source = [
      "// delegue para [\"yui\", \"alice\"]",
      "/** Suporta os pares (\"alice\", \"schwi\") e outros. */",
      "/*",
      '  const exemplo = ["yui", "schwi"];',
      "*/",
    ].join("\n");
    expect(findCouplingGroups(source)).toEqual([]);
    expect(findCatalogDeclarations(source)).toEqual([]);
  });

  it("5. não acusa uma chave isolada como acoplamento", () => {
    expect(findCouplingGroups('run({ assistantKey: "alice" });')).toEqual([]);
    expect(findCatalogDeclarations('run({ assistantKey: "alice" });')).toEqual([]);
    // Uma chave de propriedade isolada também não forma catálogo.
    expect(findCatalogDeclarations('const p = { key: "yui" };')).toEqual([]);
  });

  it("6. continua aceitando as ocorrências legítimas inventariadas", () => {
    for (const entry of ALLOWED_OCCURRENCES) {
      const source = readFileSync(resolve(REPO_ROOT, entry.file), "utf8");
      const expected = signatureOf(entry.file, entry.keys, entry.pattern, entry.anchor);
      const found =
        entry.pattern === "list"
          ? findCouplingGroups(source).some(
              (group) => signatureOf(entry.file, group.keys, "list") === expected,
            )
          : findCatalogDeclarations(source).some(
              (occurrence) =>
                signatureOf(entry.file, occurrence.keys, "catalog", occurrence.anchor) === expected,
            );
      expect(
        found,
        `ocorrência legítima deixou de ser reconhecida: ${entry.file}`,
      ).toBe(true);
    }
  });

  it("detecta catálogo novo de objetos mesmo quando formatado em várias linhas", () => {
    const source = [
      "const CATALOG = [",
      "  {",
      '    key: "yui",',
      "  },",
      "  {",
      '    key: "schwi",',
      "  },",
      "];",
    ].join("\n");
    const groups = findCatalogDeclarations(source);
    expect(groups).toHaveLength(1);
    expect(new Set(groups[0]!.keys)).toEqual(new Set(["yui", "schwi"]));
  });
});

describe("Fase 0 — o guard FALHA quando aparece acoplamento novo (ponta a ponta)", () => {
  // Arquivos sintéticos em `os.tmpdir()`, nunca no repositório: o negativo prova o caminho de
  // detecção real sem editar nenhum arquivo de produção.
  const sandboxRoot = mkdtempSync(join(tmpdir(), "nexus-coupling-"));
  const write = (name: string, contents: string): string => {
    const path = join(sandboxRoot, name);
    writeFileSync(path, contents, "utf8");
    return path;
  };

  afterAll(() => {
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("acusa uma lista multilinha nova em um arquivo sem ocorrência declarada", () => {
    const path = write(
      "novo-modulo.ts",
      ['export const ALVOS = [', '  "yui",', '  "alice",', '] as const;'].join("\n"),
    );
    const found = findUndeclaredCoupling([path], sandboxRoot, allSignatures());
    expect(found).toHaveLength(1);
    expect(found[0]!.keys).toEqual(["yui", "alice"]);
    expect(found[0]!.pattern).toBe("list");
  });

  it("acusa a SEGUNDA lista num arquivo que já tem ocorrência legítima", () => {
    const path = write(
      "assistants.ts",
      [
        'export const initialAssistantKeySchema = z.enum(["yui", "alice", "schwi"]);',
        "",
        "export const ATALHOS = [",
        '  "yui",',
        '  "schwi",',
        "];",
      ].join("\n"),
    );
    // Cenário exato do requisito: o arquivo JÁ tem uma ocorrência legítima declarada. Uma
    // allowlist por arquivo liberaria as duas listas; por ocorrência, só a primeira.
    const allowed = new Set([
      signatureOf("assistants.ts", ["yui", "alice", "schwi"], "list"),
      // Repete todas as demais ocorrências do repositório para isolar o efeito deste arquivo.
      ...allSignatures(),
    ]);
    const found = findUndeclaredCoupling([path], sandboxRoot, allowed);
    expect(found).toHaveLength(1);
    expect(found[0]!.keys).toEqual(["yui", "schwi"]);
    expect(found[0]!.file).toBe("assistants.ts");
  });

  it("acusa um catálogo de objetos novo (não apenas listas)", () => {
    const path = write(
      "catalogo.ts",
      ['export const PROFILES = [', '  { key: "yui" },', '  { key: "alice" },', "];"].join("\n"),
    );
    const found = findUndeclaredCoupling([path], sandboxRoot, allSignatures());
    expect(found).toHaveLength(1);
    expect(found[0]!.pattern).toBe("catalog");
  });

  it("NÃO acusa comentário, string documental nem chave isolada (sem falso positivo)", () => {
    const path = write(
      "documentacao.ts",
      [
        '// antes era ["yui", "alice"] — mantido apenas como histórico',
        "export const DESCRICAO =",
        '  "aceita [\"alice\", \"schwi\"] e delega";',
        "export function run(assistantKey: InitialAssistantKey) {",
        "  return assistantKey;",
        "}",
      ].join("\n"),
    );
    expect(findUndeclaredCoupling([path], sandboxRoot, allSignatures())).toEqual([]);
  });

  it("aceita a ocorrência legítima quando o caminho relativo casa com a allowlist", () => {
    const path = write(
      "schemas-assistants.ts",
      'export const initialAssistantKeySchema = z.enum(["yui", "alice", "schwi"]);',
    );
    const allowed = new Set([
      signatureOf("schemas-assistants.ts", ["yui", "alice", "schwi"], "list"),
    ]);
    expect(findUndeclaredCoupling([path], sandboxRoot, allowed)).toEqual([]);
  });
});

describe("Fase 0 — catálogos de objetos: uma ocorrência, uma identidade", () => {
  // Todos os casos abaixo passam por `findUndeclaredCoupling`, que é exatamente a validação que a
  // varredura do repositório usa. Comparar assinaturas não provaria nada sobre o guard real.
  const validate = (
    source: string,
    file: string,
    allowed: ReadonlySet<string>,
  ): UndeclaredCoupling[] => {
    const root = mkdtempSync(join(tmpdir(), "nexus-catalog-"));
    const path = join(root, file);
    writeFileSync(path, source, "utf8");
    try {
      return findUndeclaredCoupling([path], root, allowed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  const catalog = (name: string, keys: readonly string[]): string =>
    [
      `export const ${name} = [`,
      ...keys.map((key) => `  { key: "${key}", name: "${key.toUpperCase()}" },`),
      "] as const;",
    ].join("\n");

  const THREE = ["yui", "alice", "schwi"] as const;
  const LEGIT = signatureOf("catalogo.ts", THREE, "catalog", "LEGIT");

  it("1. catálogo legítimo declarado uma vez é aceito", () => {
    expect(validate(catalog("LEGIT", THREE), "catalogo.ts", new Set([LEGIT]))).toEqual([]);
  });

  it("2. segunda declaração independente com as MESMAS três chaves é bloqueada", () => {
    // Núcleo do requisito: a ocorrência nova é idêntica em arquivo, padrão e chaves. Só o
    // container a distingue — que é o que a identidade anterior não capturava.
    const source = [catalog("LEGIT", THREE), "", catalog("COPIA", THREE)].join("\n");
    const found = validate(source, "catalogo.ts", new Set([LEGIT]));
    expect(found).toHaveLength(1);
    expect(found[0]!.anchor).toBe("COPIA");
    expect(found[0]!.keys).toEqual([...THREE]);
  });

  it("3. segunda declaração independente com duas chaves é bloqueada", () => {
    const source = [catalog("LEGIT", THREE), "", catalog("ALVOS", ["yui", "alice"])].join("\n");
    const found = validate(source, "catalogo.ts", new Set([LEGIT]));
    expect(found).toHaveLength(1);
    expect(found[0]!.anchor).toBe("ALVOS");
  });

  it("4. ocorrência nova no mesmo arquivo não é liberada pela legítima", () => {
    // Mesmo arquivo, mesmas chaves, nomes de container diferentes: só a assinatura exata passa.
    const allowed = new Set([LEGIT]);
    expect(validate(catalog("LEGIT", THREE), "catalogo.ts", allowed)).toEqual([]);
    const comExtra = [catalog("LEGIT", THREE), catalog("ESPELHO", THREE)].join("\n");
    expect(validate(comExtra, "catalogo.ts", allowed)).toHaveLength(1);
  });

  it("5. catálogos distintos no mesmo arquivo são reconhecidos separadamente", () => {
    const source = [catalog("PRIMEIRO", THREE), "", catalog("SEGUNDO", ["yui", "alice"])].join(
      "\n",
    );
    const root = mkdtempSync(join(tmpdir(), "nexus-catalog-"));
    const path = join(root, "catalogo.ts");
    writeFileSync(path, source, "utf8");
    try {
      const occurrences = findCatalogDeclarations(readFileSync(path, "utf8"));
      expect(occurrences.map((occurrence) => occurrence.anchor)).toEqual(["PRIMEIRO", "SEGUNDO"]);
      expect(occurrences.map((occurrence) => occurrence.keys)).toEqual([
        [...THREE],
        ["yui", "alice"],
      ]);
      // Cada um tem assinatura própria: liberar um não libera o outro.
      expect(
        findUndeclaredCoupling(
          [path],
          root,
          new Set([signatureOf("catalogo.ts", THREE, "catalog", "PRIMEIRO")]),
        ).map((entry) => entry.anchor),
      ).toEqual(["SEGUNDO"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("6. comentários, documentação e exemplos textuais não criam ocorrências", () => {
    const source = [
      "// catálogo antigo: [{ key: \"yui\" }, { key: \"alice\" }]",
      "/**",
      " * Exemplo: `[{ key: \"yui\" }, { key: \"alice\" }, { key: \"schwi\" }]`",
      " */",
      "export const DOC =",
      '  "use [{ key: \\"yui\\" }, { key: \\"schwi\\" }] para ilustrar";',
      catalog("LEGIT", THREE),
    ].join("\n");
    expect(validate(source, "catalogo.ts", new Set([LEGIT]))).toEqual([]);

    // E o analisador cru também não vê nada além da ocorrência real.
    const path = join(tmpdir(), "nexus-catalog-doc.ts");
    writeFileSync(path, source, "utf8");
    try {
      expect(findCatalogDeclarations(readFileSync(path, "utf8")).map((o) => o.anchor)).toEqual([
        "LEGIT",
      ]);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("7. uma propriedade isolada key: \"yui\" não constitui catálogo", () => {
    expect(validate('run({ assistantKey: "yui" });', "uso.ts", new Set())).toEqual([]);
    expect(validate('const p = { key: "yui" };', "uso.ts", new Set())).toEqual([]);
    // Duas chaves no MESMO objeto também não são catálogo: é um objeto com duas propriedades.
    expect(validate('const p = { key: "yui", fallbackKey: "alice" };', "uso.ts", new Set())).toEqual(
      [],
    );
  });

  it("a identidade não depende do número de linha", () => {
    // Reformatar (linhas em branco, uma propriedade por linha) desloca a ocorrência, mas não
    // muda a assinatura: a âncora é o nome do container, não a posição.
    const compact = catalog("LEGIT", THREE);
    const spread = [
      "",
      "",
      "export const LEGIT = [",
      ...THREE.map(
        (key) => `\n  {\n    key: "${key}",\n    name: "${key.toUpperCase()}",\n  },`,
      ),
      "\n] as const;",
      "",
    ].join("\n");

    const compactLine = findCatalogDeclarations(compact)[0]!.line;
    const spreadLine = findCatalogDeclarations(spread)[0]!.line;
    expect(spreadLine).not.toBe(compactLine);

    const allowed = new Set([LEGIT]);
    expect(validate(compact, "catalogo.ts", allowed)).toEqual([]);
    expect(validate(spread, "catalogo.ts", allowed)).toEqual([]);
  });
});

describe("Fase 0 — duplicata dentro de um arquivo real do inventário", () => {
  // Usa o conteúdo real de um arquivo inventariado e acrescenta, em memória, um segundo catálogo
  // idêntico. Nenhum arquivo em disco é alterado: a validação lê o texto injetado.
  it("bloqueia um segundo catálogo com as mesmas chaves em routes/assistants.ts", () => {
    const real = readFileSync(resolve(REPO_ROOT, "apps/server/src/routes/assistants.ts"), "utf8");
    const duplicated = `${real}\nconst ASSISTANTS_MIRROR = [\n  { id: "1", key: "yui" },\n  { id: "2", key: "alice" },\n  { id: "3", key: "schwi" },\n] as const;\n`;
    const occurrences = findCatalogDeclarations(duplicated);
    expect(occurrences.map((occurrence) => occurrence.anchor)).toEqual([
      "ASSISTANTS",
      "ASSISTANTS_MIRROR",
    ]);

    const root = mkdtempSync(join(tmpdir(), "nexus-real-"));
    const path = join(root, "assistants.ts");
    try {
      writeFileSync(path, real, "utf8");
      const allowed = new Set(
        ALLOWED_OCCURRENCES.map((entry) =>
          signatureOf("assistants.ts", entry.keys, entry.pattern, entry.anchor),
        ),
      );
      expect(findUndeclaredCoupling([path], root, allowed), "arquivo real").toEqual([]);

      writeFileSync(path, duplicated, "utf8");
      const blocked = findUndeclaredCoupling([path], root, allowed);
      expect(blocked.map((entry) => entry.anchor)).toEqual(["ASSISTANTS_MIRROR"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Fase 0 — prova de regressão: legítima, duplicata, remoção", () => {
  // Sequência completa no mesmo arquivo, pelo caminho de validação real. É o cenário que a
  // identidade antiga (`catalog:arquivo::chaves`) deixava passar: as duas listas tinham chaves
  // idênticas, então declarar uma liberava a outra.
  it("aceita a legítima, bloqueia a duplicata idêntica e volta a aceitar ao removê-la", () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-regressao-"));
    const path = join(root, "catalog.ts");
    const legit = [
      'export const LEGIT = [',
      '  { key: "yui" },',
      '  { key: "alice" },',
      '  { key: "schwi" },',
      "] as const;",
    ].join("\n");
    const duplicate = [
      "",
      "export const COPIA = [",
      '  { key: "yui" },',
      '  { key: "alice" },',
      '  { key: "schwi" },',
      "] as const;",
    ].join("\n");
    const allowed = new Set([
      signatureOf("catalog.ts", ["yui", "alice", "schwi"], "catalog", "LEGIT"),
    ]);

    try {
      writeFileSync(path, legit, "utf8");
      expect(findUndeclaredCoupling([path], root, allowed), "1. legítima isolada").toEqual([]);

      writeFileSync(path, legit + duplicate, "utf8");
      const blocked = findUndeclaredCoupling([path], root, allowed);
      expect(blocked, "2. duplicata idêntica precisa falhar").toHaveLength(1);
      expect(blocked[0]!.anchor).toBe("COPIA");

      writeFileSync(path, legit, "utf8");
      expect(findUndeclaredCoupling([path], root, allowed), "3. após remover a duplicata").toEqual(
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Fase 0 — allowlist é por ocorrência, não por arquivo", () => {
  it("cada ocorrência declara motivo e fase responsável pela remoção", () => {
    for (const entry of ALLOWED_OCCURRENCES) {
      expect(entry.reason.length).toBeGreaterThan(10);
      expect(entry.removedIn).toMatch(/^(Fase \d+|permanente)$/);
    }
  });

  it("só a fonte de verdade pode ser marcada como permanente", () => {
    const permanent = ALLOWED_OCCURRENCES.filter((entry) => entry.removedIn === "permanente");
    expect(permanent.map((entry) => entry.file)).toEqual([
      "packages/assistant-profiles/src/catalog.ts",
    ]);
  });

  it("o inventário não cresce silenciosamente: tamanho é explícito", () => {
    expect(ALLOWED_OCCURRENCES).toHaveLength(9);
  });

  it("toda ocorrência de catálogo declara o container que a identifica", () => {
    // Sem âncora, duas listas de objetos com as mesmas chaves no mesmo arquivo voltariam a ter a
    // mesma identidade — exatamente a brecha corrigida nesta rodada.
    for (const entry of ALLOWED_OCCURRENCES.filter((item) => item.pattern === "catalog")) {
      expect(entry.anchor, `ocorrência de catálogo sem âncora: ${entry.file}`).toBeDefined();
      expect(entry.anchor).not.toBe("<expr>");
    }
  });

  it("duas ocorrências não compartilham a mesma assinatura", () => {
    const signatures = ALLOWED_OCCURRENCES.map((entry) =>
      signatureOf(entry.file, entry.keys, entry.pattern, entry.anchor),
    );
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it("a allowlist não declara um arquivo inteiro: cada entrada tem padrão definido", () => {
    for (const entry of ALLOWED_OCCURRENCES) {
      expect(["list", "catalog"]).toContain(entry.pattern);
    }
  });
});

/**
 * Acoplamentos presentes em `files` que não estão declarados em `allowed`.
 *
 * Extraído do teste para que o negativo possa exercitar exatamente o mesmo caminho de código
 * com uma entrada sintética, sem escrever em disco nem tocar em arquivos de produção.
 */
export interface UndeclaredCoupling {
  readonly file: string;
  readonly line: number;
  readonly keys: readonly string[];
  readonly pattern: string;
  readonly anchor?: string;
}

export function findUndeclaredCoupling(
  files: readonly string[],
  repoRoot: string,
  allowed: ReadonlySet<string>,
): UndeclaredCoupling[] {
  return files.flatMap((file) => {
    const relativePath = relative(repoRoot, file);
    const source = readFileSync(file, "utf8");
    const found: UndeclaredCoupling[] = [];
    for (const group of findCouplingGroups(source)) {
      if (!allowed.has(signatureOf(relativePath, group.keys, "list"))) {
        found.push({ file: relativePath, line: group.line, keys: group.keys, pattern: "list" });
      }
    }
    for (const occurrence of findCatalogDeclarations(source)) {
      if (!allowed.has(signatureOf(relativePath, occurrence.keys, "catalog", occurrence.anchor))) {
        found.push({
          file: relativePath,
          line: occurrence.line,
          keys: occurrence.keys,
          pattern: "catalog",
          anchor: occurrence.anchor,
        });
      }
    }
    return found;
  });
}

describe("Fase 0 — varredura do repositório", () => {
  const files = SCANNED_DIRECTORIES.flatMap((directory) => collectSourceFiles(directory));

  it("encontra os arquivos-fonte esperados (guard contra varredura vazia)", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((file) => file.endsWith("apps/server/src/core/delegation.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("packages/shared/src/schemas/assistants.ts"))).toBe(
      true,
    );
  });

  it("não introduz acoplamento fora das ocorrências declaradas", () => {
    const unexpected = findUndeclaredCoupling(files, REPO_ROOT, allSignatures());

    expect(
      unexpected,
      [
        "Acoplamento aos três assistentes fora do inventário da Fase 0.",
        "Ocorre para listas literais (inclusive multilinha) e para catálogos de objetos",
        "({ key: \"yui\" }, { key: \"alice\" }, …). Isso recria a fonte de verdade e impede uma",
        "quarta assistente sem editar vários arquivos. Se o ponto for legítimo, declare a",
        "OCORRÊNCIA em ALLOWED_OCCURRENCES (arquivo + chaves + padrão + motivo + fase que a",
        "remove) — nunca libere o arquivo inteiro.",
      ].join(" "),
    ).toEqual([]);
  });

  it("toda ocorrência declarada ainda existe no código (inventário não fica obsoleto)", () => {
    // Se uma fase futura remover um ponto, esta verificação falha e pede a remoção da entrada:
    // a allowlist não pode acumular permissões mortas.
    for (const entry of ALLOWED_OCCURRENCES) {
      const source = readFileSync(resolve(REPO_ROOT, entry.file), "utf8");
      const signature = signatureOf(entry.file, entry.keys, entry.pattern, entry.anchor);
      const found =
        entry.pattern === "list"
          ? findCouplingGroups(source).some(
              (group) => signatureOf(entry.file, group.keys, "list") === signature,
            )
          : findCatalogDeclarations(source).some(
              (occurrence) =>
                signatureOf(entry.file, occurrence.keys, "catalog", occurrence.anchor) === signature,
            );
      expect(found, `ocorrência declarada não encontrada em ${entry.file}`).toBe(true);
    }
  });

  it("não confunde dados de exemplo nem fixtures com acoplamento", () => {
    const scanned = SCANNED_DIRECTORIES.flatMap((directory) => collectSourceFiles(directory));
    expect(scanned.some((file) => /\.(test|spec)\.tsx?$/.test(file))).toBe(false);

    // `authorizedAssistantKeys` declara autorização como lista de strings, não como enum do
    // catálogo inicial; uma chave por ferramenta não forma lista de alvos.
    const toolsSchema = readFileSync(resolve(REPO_ROOT, "packages/tools/src/schemas.ts"), "utf8");
    expect(toolsSchema).toContain("authorizedAssistantKeys: z.array(");
    expect(toolsSchema).not.toMatch(/authorizedAssistantKeys:\s*[^\n]*initialAssistantKeySchema/);

    // Fixtures citam uma chave por campo em objetos distintos: nenhum grupo é formado.
    const fixtures = readFileSync(
      resolve(REPO_ROOT, "apps/mobile/src/test-support/core-fixtures.ts"),
      "utf8",
    );
    expect(findCouplingGroups(fixtures)).toEqual([]);
  });
});

describe("Fase 0 — o catálogo legítimo continua sendo a fonte de verdade", () => {
  it("expõe exatamente os perfis congelados, na ordem do catálogo", () => {
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
