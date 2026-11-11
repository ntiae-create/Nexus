import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { listAssistantProfiles } from "@nexus/assistant-profiles";
import ts from "typescript";

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

const INITIAL_KEYS = ["yui", "alice", "schwi", "vivy"] as const;
const SCANNED_DIRECTORIES = ["apps/server/src", "apps/mobile/src", "packages"] as const;

const KEY_SET: ReadonlySet<string> = new Set(INITIAL_KEYS);

/**
 * Cria a AST. `setParentNodes = true` — a âncora sobe pela cadeia de pais.
 *
 * `ScriptKind` é derivado do nome do arquivo: `.tsx` precisa de `TSX`, senão o parser trata
 * `<div>` como operador de comparação, falha, e devolve uma AST parcial em que o catálogo pode
 * desaparecer. O guard varre `apps/mobile/src`, que tem `.tsx` — sem isso o falso negativo é
 * silencioso justamente nos arquivos de UI.
 */
function parseSource(text: string, fileName = "analisado.ts"): ts.SourceFile {
  const kind = /\.tsx$/i.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, kind);
}

function assistantKeyOfLiteral(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) && KEY_SET.has(node.text)) return node.text;
  // Em posição de tipo, `"yui"` não é StringLiteral: é LiteralTypeNode envolvendo um.
  if (ts.isLiteralTypeNode(node)) return assistantKeyOfLiteral(node.literal);
  // `"yui" as const` / `"yui" as InitialAssistantKey` / `"yui" satisfies X`
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return assistantKeyOfLiteral(node.expression);
  }
  return null;
}

function keyOfProperty(node: ts.Node): string | null {
  if (!ts.isPropertyAssignment(node)) return null;
  const name = node.name;
  const isKeyProperty =
    (ts.isIdentifier(name) && (name.text === "key" || name.text === "assistantKey")) ||
    (ts.isStringLiteral(name) && (name.text === "key" || name.text === "assistantKey"));
  if (!isKeyProperty) return null;
  return assistantKeyOfLiteral(node.initializer);
}

export interface CouplingGroup {
  readonly keys: readonly string[];
  readonly line: number;
}

export interface CatalogOccurrence {
  readonly keys: readonly string[];
  readonly line: number;
  readonly offset: number;
  /** Identidade estrutural do container. Ver `anchorOf`. */
  readonly anchor: string;
}

/**
 * Analisador do guard — Fase 0.
 *
 * Histórico relevante: as duas versões anteriores eram heurísticas de texto. A primeira errava
 * em listas multilinha; a segunda (delimitadores contados manualmente) tinha dois defeitos
 * demonstrados por sonda antes desta reescrita:
 *
 * - um `"]"` dentro de uma **string** anterior à chave fechava o array antes da hora e a
 *   ocorrência inteira desaparecia do inventário — falso negativo silencioso, o pior tipo de
 *   falha para um guard;
 * - `anchorBefore` atribuía a ocorrência à última `const/let/var` do arquivo, então
 *   `const X = { assistentes: [...] }` virava âncora `X` em vez de `assistentes`.
 *
 * Em vez de remendar a tokenização, a análise passa a usar o parser do TypeScript — já
 * devDependency de `apps/server` (`typescript@5.9.3`), nenhuma dependência nova. O parser
 * resolve de graça strings, template literals, escapes, comentários, aninhamento e
 * correspondência de delimitadores, e dá a estrutura necessária para a âncora.
 *
 * Limite conhecido e deliberado: o texto analisado é o do arquivo real; um arquivo com erro de
 * sintaxe produz uma AST parcial. Nesse caso o scanner é conservador — ele não inventa
 * ocorrências — e o `tsc --noEmit` da validação cobre o resto.
 */

/**
 * Encontra **grupos** de chaves de assistente que formam uma coleção literal.
 *
 * Cobre array literal (`["yui", "alice"]`), união de tipos (`"yui" | "alice"`), enum
 * (`enum E { A = "yui" }`), e a forma `as const`. Um grupo exige **2+ chaves distintas** —
 * chave isolada é dado pontual, não acoplamento.
 */
export function findCouplingGroups(rawSource: string, fileName?: string): CouplingGroup[] {
  const sourceFile = parseSource(rawSource, fileName);
  const groups: CouplingGroup[] = [];

  const push = (keys: readonly string[], node: ts.Node): void => {
    const distinct = [...new Set(keys)];
    if (distinct.length < 2) return;
    groups.push({
      keys: distinct,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) {
      const keys = node.elements
        .map((element) => assistantKeyOfLiteral(element))
        .filter((key): key is string => key !== null);
      push(keys, node);
    } else if (ts.isUnionTypeNode(node)) {
      const keys = node.types
        .map((member) => assistantKeyOfLiteral(member))
        .filter((key): key is string => key !== null);
      push(keys, node);
    } else if (ts.isEnumDeclaration(node)) {
      const keys = node.members
        .map((member) =>
          member.initializer === undefined ? null : assistantKeyOfLiteral(member.initializer),
        )
        .filter((key): key is string => key !== null);
      push(keys, node);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return groups.sort((a, b) => a.line - b.line);
}

/** Elemento de array que é entrada de catálogo: `{ key: "yui", … }` (ou literal direto de chave). */
function keyOfCatalogEntry(element: ts.Node): string | null {
  // Só objeto com propriedade de chave é entrada de catálogo. Uma lista de strings literais é o
  // padrão `list` — classificá-la também como catálogo duplicaria a mesma ocorrência sob duas
  // identidades e faria o guard exigir duas entradas de allowlist para um único ponto.
  if (!ts.isObjectLiteralExpression(element)) return null;
  for (const property of element.properties) {
    const key = keyOfProperty(property);
    if (key !== null) return key;
  }
  return null;
}

/**
 * Identidade estrutural do container que **possui** o delimitador da ocorrência.
 *
 * A cadeia sobe pela AST e para no primeiro nó que de fato delimita a coleção. Isso corrige a
 * heurística anterior, que só olhava para trás no texto:
 *
 * | situação                                   | âncora resultante        |
 * | ---                                        | ---                      |
 * | `const CATALOGO = [...]`                   | `CATALOGO`               |
 * | `const X = { assistentes: [...] }`         | `X.assistentes`          |
 * | `function listar() { return [...] }`        | `listar()`               |
 * | `const N = [[...], [...]]`                 | `N[0]`, `N[1]`           |
 * | `const A = {…}; const B = [...]`           | `B` — `A` nunca é usada  |
 * | escopos diferentes, mesmo nome             | `<bloco>@` + nome        |
 *
 * **Regra de segurança:** a cadeia só para em um container quando existe um nó estrutural que o
 * comprove (`VariableDeclaration`, `PropertyAssignment`, `ReturnStatement`, índice de array). Se
 * a coleção está solta — argumento de chamada, expressão de nível superior, `export default` sem
 * nome — a âncora é explícita e conservadora (`<argumento>`, `<expressão>`, `<bloco>`), nunca
 * uma declaração qualquer que por acaso venha antes no arquivo.
 */
function joinParts(parts: readonly string[]): string {
  return parts.reduce((acc, part) => {
    if (part.startsWith("[")) return `${acc}${part}`;
    return acc === "" ? part : `${acc}.${part}`;
  }, "");
}

function anchorOf(collection: ts.Node, sourceFile: ts.SourceFile): string {
  const parts: string[] = [];
  let current: ts.Node | undefined = collection;

  while (current !== undefined) {
    const parent: ts.Node | undefined = current.parent;
    if (parent === undefined) break;

    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      parts.unshift(parent.name.text);
      return qualifyByScope(joinParts(parts), parent, sourceFile);
    }
    if (ts.isPropertyAssignment(parent)) {
      parts.unshift(propertyName(parent.name, sourceFile));
      current = parent;
      continue;
    }
    if (ts.isReturnStatement(parent)) {
      const label = functionLabel(parent, sourceFile);
      parts.unshift(label);
      const anchor = joinParts(parts);
      // `listar()` já identifica a função: prefixar o escopo daria `listar@listar()`.
      return anchor.startsWith("<") ? qualifyByScope(anchor, parent, sourceFile) : anchor;
    }
    if (ts.isArrayLiteralExpression(parent)) {
      const index = parent.elements.findIndex((element) => element === current);
      parts.unshift(`[${index}]`);
      current = parent;
      continue;
    }
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      // `z.array(...).parse([...])` / `Object.freeze([...])`: a coleção é argumento de uma
      // chamada. Se a chamada **é o valor** de uma declaração ou propriedade, ela ainda é o
      // caminho até o dono real; só paramos com `<argumento>` quando não há dono estrutural.
      current = parent;
      continue;
    }
    if (ts.isExportAssignment(parent)) {
      parts.unshift("<export default>");
      return qualifyByScope(joinParts(parts), parent, sourceFile);
    }
    if (ts.isSourceFile(parent)) {
      parts.unshift(parts.length === 0 ? "<argumento>" : "<expr>");
      return joinParts(parts);
    }
    current = parent;
  }
  return "<expr>";
}

function propertyName(name: ts.PropertyName, sourceFile: ts.SourceFile): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return ts.isStringLiteral(name) ? name.text : name.getText(sourceFile);
  }
  return `<${ts.SyntaxKind[name.kind]}>`;
}

function functionLabel(statements: ts.Node, sourceFile: ts.SourceFile): string {
  let current: ts.Node | undefined = statements.parent;
  while (current !== undefined) {
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) {
      return current.name === undefined ? "<anônima>()" : `${current.name.text}()`;
    }
    if (ts.isMethodDeclaration(current)) {
      return `${propertyName(current.name, sourceFile)}()`;
    }
    if (ts.isArrowFunction(current)) {
      const parent: ts.Node = current.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        return `${parent.name.text}()`;
      }
      return "<arrow>()";
    }
    if (ts.isSourceFile(current)) break;
    current = current.parent;
  }
  return "<topo>()";
}

/**
 * Desambigua declarações homônimas em escopos diferentes.
 *
 * `const CATALOG` no nível do módulo e `const CATALOG` dentro de uma função têm o mesmo nome mas
 * não são a mesma ocorrência. Quando o container não está no escopo do módulo, o nome recebe o
 * escopo que o contém (`<bloco>@CATALOG`, `listar@CATALOG`).
 */
function qualifyByScope(anchor: string, node: ts.Node, _sourceFile: ts.SourceFile): string {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isSourceFile(current)) return anchor;
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) {
      const label = current.name === undefined ? "<anônima>" : current.name.text;
      return `${label}@${anchor}`;
    }
    if (ts.isArrowFunction(current)) {
      const parent: ts.Node = current.parent;
      const label =
        ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
          ? parent.name.text
          : "<arrow>";
      return `${label}@${anchor}`;
    }
    if (ts.isMethodDeclaration(current)) return `${propertyName(current.name, current.getSourceFile())}@${anchor}`;
    current = current.parent;
  }
  return anchor;
}

/**
 * Extrai as ocorrências de catálogo de um arquivo: coleções com 2+ chaves **distintas** em
 * propriedades `key:` / `assistantKey:` de objetos de entrada.
 *
 * Duas listas no mesmo arquivo são ocorrências separadas mesmo com as mesmas chaves — é o que
 * permite a identidade por ocorrência que a allowlist exige.
 */
export function findCatalogDeclarations(rawSource: string, fileName?: string): CatalogOccurrence[] {
  const sourceFile = parseSource(rawSource, fileName);
  const occurrences: CatalogOccurrence[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) {
      const keys: string[] = [];
      let firstEntry: ts.Node | null = null;
      for (const element of node.elements) {
        const key = keyOfCatalogEntry(element);
        if (key === null) continue;
        if (firstEntry === null) firstEntry = element;
        keys.push(key);
      }
      const distinct = [...new Set(keys)];
      if (distinct.length >= 2 && firstEntry !== null) {
        occurrences.push({
          keys: distinct,
          line: sourceFile.getLineAndCharacterOfPosition(firstEntry.getStart(sourceFile)).line + 1,
          offset: firstEntry.getStart(sourceFile),
          anchor: anchorOf(node, sourceFile),
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  // Ordinal apenas quando há colisão de âncora (dois `const CATALOG` irmãos, por exemplo).
  // Ordena antes por posição para que o ordinal seja estável.
  occurrences.sort((a, b) => a.offset - b.offset);
  const total = new Map<string, number>();
  for (const occurrence of occurrences) {
    total.set(occurrence.anchor, (total.get(occurrence.anchor) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return occurrences.map((occurrence) => {
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
    keys: ["yui", "alice", "schwi", "vivy"],
    pattern: "list",
    reason: "raiz do enum InitialAssistantKey — o acoplamento que a Fase 1 vai desmontar (G1)",
    removedIn: "Fase 1",
  },
  {
    file: "packages/assistant-profiles/src/catalog.ts",
    keys: ["yui", "alice", "schwi", "vivy"],
    pattern: "catalog",
    anchor: "profiles",
    reason: "catálogo canônico dos perfis — é a fonte de verdade, não uma cópia",
    // Não é remoção: quando `InitialAssistantKey` for generalizado (Fase 1), o catálogo
    // continua sendo o catálogo. Marcar uma fase aqui prometeria uma remoção que não acontece.
    removedIn: "permanente",
  },
  {
    file: "packages/assistant-profiles/src/catalog.ts",
    // O `delegateTo: ["alice", "schwi"]` do perfil da YUI. O guard o vê como lista literal, e
    // ele **é** uma lista literal — mas da política declarada na fonte de verdade, que é
    // exatamente onde a Fase 3 (G2) mandou que ela vivesse. Declarar aqui é o oposto de
    // duplicar: é o único lugar do repositório onde os alvos são nomeados.
    keys: ["alice", "schwi", "vivy"],
    pattern: "list",
    reason: "política de coordenação declarada no perfil canônico — a fonte de verdade (G2)",
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
    // Com o parser, a linha é a do início do nó — o `[` da linha 1, não a primeira chave.
    expect(groups[0]!.line).toBe(1);
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
          ? findCouplingGroups(source, entry.file).some(
              (group) => signatureOf(entry.file, group.keys, "list") === expected,
            )
          : findCatalogDeclarations(source, entry.file).some(
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

describe("Fase 2 — duplicata dentro de um arquivo real do inventário", () => {
  // Usa o conteúdo real de um arquivo inventariado e acrescenta, em memória, um segundo catálogo
  // idêntico. Nenhum arquivo em disco é alterado: a validação lê o texto injetado.
  //
  // Fase 2: o arquivo de referência passou a ser o catálogo canônico de perfis. A rota
  // `routes/assistants.ts` deixou de servir de um array literal (G4), então não é mais um
  // exemplo de ocorrência legítima — o catálogo de perfis é, e continuará sendo.
  it("bloqueia um segundo catálogo com as mesmas chaves ao lado do catálogo canônico", () => {
    const file = "packages/assistant-profiles/src/catalog.ts";
    const real = readFileSync(resolve(REPO_ROOT, file), "utf8");
    const duplicated =
      `${real}\nconst CATALOGO_MIRROR = [\n` +
      '  { id: "1", key: "yui" },\n' +
      '  { id: "2", key: "alice" },\n' +
      '  { id: "3", key: "schwi" },\n' +
      "] as const;\n";

    const root = mkdtempSync(join(tmpdir(), "nexus-real-"));
    // O caminho escrito é relativo à raiz varrida (`catalog.ts`), como faz a varredura real;
    // por isso a assinatura é montada com o nome relativo, e não com o caminho do repositório.
    const path = join(root, "catalog.ts");
    // O catálogo canônico tem DUAS ocorrências legítimas desde a Fase 3: a identidade dos perfis
    // (`catalog`) e a política de coordenação declarada (`list` em `delegateTo`). O teste precisa
    // liberar as duas — senão acusaria a própria fonte de verdade.
    const canonical = ALLOWED_OCCURRENCES.filter((entry) => entry.file === file);
    expect(canonical.length, `ocorrências canônicas de ${file}`).toBeGreaterThanOrEqual(2);
    const allowed = new Set(
      canonical.map((entry) =>
        signatureOf("catalog.ts", entry.keys, entry.pattern, entry.anchor),
      ),
    );
    try {
      writeFileSync(path, real, "utf8");
      expect(findUndeclaredCoupling([path], root, allowed), "arquivo real").toEqual([]);

      writeFileSync(path, duplicated, "utf8");
      const blocked = findUndeclaredCoupling([path], root, allowed);
      expect(blocked.map((entry) => entry.anchor)).toEqual(["CATALOGO_MIRROR"]);
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

describe("Fase 0 — reconhecimento estrutural (parser) e âncora de container", () => {
  // Todos os casos passam por `findUndeclaredCoupling`, o caminho de validação que a varredura
  // usa. Nenhum compara strings de assinatura nem inspeciona resultado intermediário.
  const validate = (source: string, file: string, allowed: ReadonlySet<string>) => {
    const root = mkdtempSync(join(tmpdir(), "nexus-estrutural-"));
    const path = join(root, file);
    writeFileSync(path, source, "utf8");
    try {
      return findUndeclaredCoupling([path], root, allowed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  const THREE = ["yui", "alice", "schwi"] as const;
  const LEGIT = signatureOf("catalogo.ts", THREE, "catalog", "CATALOGO");
  const legit = (): string =>
    [
      "export const CATALOGO = [",
      '  { key: "yui", name: "YUI" },',
      '  { key: "alice", name: "ALICE" },',
      '  { key: "schwi", name: "SCHWI" },',
      "] as const;",
    ].join("\n");

  it("1. string contendo \"]\" dentro de um catálogo válido não quebra o reconhecimento", () => {
    // Antes do parser, o `]` da string fechava o array antes da hora e a ocorrência inteira
    // desaparecia do inventário — um falso negativo silencioso.
    const source = [
      "export const CATALOGO = [",
      '  { key: "yui", note: "fecha ] aqui" },',
      '  { key: "alice", note: "] e ] e ]" },',
      '  { key: "schwi" },',
      "] as const;",
    ].join("\n");
    expect(validate(source, "catalogo.ts", new Set([LEGIT]))).toEqual([]);
    // E a ocorrência existe de fato: sem a entrada, o guard acusa.
    expect(validate(source, "catalogo.ts", new Set())).toHaveLength(1);
  });

  it("2. string contendo \"[\" dentro de um catálogo válido não cria ocorrência falsa", () => {
    const source = [
      "export const CATALOGO = [",
      '  { key: "yui", note: "abre [ aqui" },',
      '  { key: "alice", note: "[ [" },',
      '  { key: "schwi" },',
      "] as const;",
    ].join("\n");
    expect(validate(source, "catalogo.ts", new Set([LEGIT]))).toEqual([]);
    expect(validate(source, "catalogo.ts", new Set())).toHaveLength(1);
  });

  it("3. comentários com delimitadores não afetam o reconhecimento", () => {
    const source = [
      "/* [{ key: \"yui\" }, { key: \"alice\" }] */",
      "// ] [ } {",
      legit(),
      "/** depois: [ { key: \"schwi\" } ] */",
    ].join("\n");
    expect(validate(source, "catalogo.ts", new Set([LEGIT]))).toEqual([]);
    expect(validate(source, "catalogo.ts", new Set())).toHaveLength(1);
  });

  it("4. array aninhado dentro de um objeto de catálogo não vira ocorrência própria", () => {
    // `personality: ["a", "b"]` é array aninhado, não catálogo: não tem propriedade de chave.
    const source = [
      "export const CATALOGO = [",
      '  { key: "yui", personality: ["natural", "objetiva"] },',
      '  { key: "alice", personality: ["técnica", "direta"] },',
      '  { key: "schwi" },',
      "] as const;",
    ].join("\n");
    expect(validate(source, "catalogo.ts", new Set([LEGIT]))).toEqual([]);
    expect(validate(source, "catalogo.ts", new Set())).toHaveLength(1);

    // Arrays aninhados de OBJETOS com chaves são ocorrências separadas, com âncoras distintas.
    const nested = [
      "export const GRUPOS = [",
      '  [{ key: "yui" }, { key: "alice" }],',
      '  [{ key: "schwi" }, { key: "alice" }],',
      "];",
    ].join("\n");
    const found = validate(nested, "grupos.ts", new Set());
    expect(found.map((entry) => entry.anchor)).toEqual(["GRUPOS[0]", "GRUPOS[1]"]);
  });

  it("5. variável declarada antes do catálogo não é assumida como proprietária", () => {
    const source = [
      "const OUTRA_COISA = 1;",
      "const TAMBEM_ANTES = { qualquer: 2 };",
      legit(),
    ].join("\n");
    // A âncora é `CATALOGO`; declarar `OUTRA_COISA` não libera nada.
    expect(validate(source, "catalogo.ts", new Set([LEGIT]))).toEqual([]);
    expect(
      validate(
        source,
        "catalogo.ts",
        new Set([signatureOf("catalogo.ts", THREE, "catalog", "OUTRA_COISA")]),
      ),
    ).toHaveLength(1);
  });

  it("6. array retornado diretamente por função recebe a função como âncora", () => {
    const source = [
      "export function listarAssistentes() {",
      '  return [{ key: "yui" }, { key: "alice" }, { key: "schwi" }];',
      "}",
    ].join("\n");
    const anchor = signatureOf("catalogo.ts", THREE, "catalog", "listarAssistentes()");
    expect(validate(source, "catalogo.ts", new Set([anchor]))).toEqual([]);
    expect(validate(source, "catalogo.ts", new Set([LEGIT]))).toHaveLength(1);
  });

  it("7. array atribuído a propriedade de objeto é ancorado na propriedade, não no objeto", () => {
    const source = [
      "export const REGISTRO = {",
      '  assistentes: [{ key: "yui" }, { key: "alice" }, { key: "schwi" }],',
      "};",
    ].join("\n");
    const correct = signatureOf("catalogo.ts", THREE, "catalog", "REGISTRO.assistentes");
    expect(validate(source, "catalogo.ts", new Set([correct]))).toEqual([]);
    // A heurística antiga usaria `REGISTRO`; ela não pode liberar a ocorrência.
    expect(
      validate(source, "catalogo.ts", new Set([signatureOf("catalogo.ts", THREE, "catalog", "REGISTRO")])),
    ).toHaveLength(1);
  });

  it("8. duas ocorrências independentes com as mesmas três chaves continuam separadas", () => {
    const source = [legit(), "", "export const COPIA = [", '  { key: "yui" },', '  { key: "alice" },', '  { key: "schwi" },', "] as const;"].join("\n");
    const found = validate(source, "catalogo.ts", new Set([LEGIT]));
    expect(found).toHaveLength(1);
    expect(found[0]!.anchor).toBe("COPIA");
  });

  it("9. catálogo legítimo continua aceito após reformatação", () => {
    const reformatted = [
      "",
      "",
      "export   const   CATALOGO   =",
      "  [",
      "",
      "    {",
      '      name: "YUI",',
      '      key: "yui",',
      "    },",
      "",
      "    {",
      '      key: "alice",',
      "    },",
      "",
      "    {",
      '      key: "schwi",',
      "    },",
      "",
      "  ] as const;",
      "",
    ].join("\n");
    expect(validate(reformatted, "catalogo.ts", new Set([LEGIT]))).toEqual([]);
  });

  it("10. quando o container não pode ser determinado, a âncora é explícita e conservadora", () => {
    // Catálogo passado como argumento: não há container nomeado. A âncora é `<argumento>` —
    // explícita — e nunca uma declaração vizinha que não o possui.
    const source = [
      "const IRRELEVANTE = 1;",
      'registrar([{ key: "yui" }, { key: "alice" }]);',
    ].join("\n");
    const found = validate(source, "catalogo.ts", new Set());
    expect(found).toHaveLength(1);
    expect(found[0]!.anchor).toBe("<argumento>");
    expect(found[0]!.anchor).not.toBe("IRRELEVANTE");

    // E a âncora conservadora é utilizável: pode ser declarada se o ponto for legítimo.
    const allowed = new Set([
      signatureOf("catalogo.ts", ["yui", "alice"], "catalog", "<argumento>"),
    ]);
    expect(validate(source, "catalogo.ts", allowed)).toEqual([]);
  });

  it("catálogo em arquivo .tsx é reconhecido (JSX exige ScriptKind.TSX)", () => {
    // Regressão real desta rodada. Sem `ScriptKind.TSX`, o parser trata `<div>` como operador,
    // falha, e devolve AST parcial: um catálogo escrito DENTRO do JSX perde o container e a
    // âncora degrada para `<função>()` — o ponto continua visível, mas deixa de ser
    // identificável por ocorrência. Arquivos de UI de `apps/mobile/src` são `.tsx`.
    const source = [
      "export function Lista() {",
      "  return (",
      "    <div>",
      '      {[{ key: "yui" }, { key: "alice" }, { key: "schwi" }].map((item) => (',
      "        <span key={item.key}>{item.key}</span>",
      "      ))}",
      "    </div>",
      "  );",
      "}",
    ].join("\n");

    const found = validate(source, "componente.tsx", new Set());
    expect(found).toHaveLength(1);
    // O container estrutural é o `return` da função: a coleção é parte do JSX retornado.
    expect(found[0]!.anchor).toBe("Lista()");

    // E a ocorrência é endereçável: declarada a âncora real, ela é aceita.
    expect(
      validate(
        source,
        "componente.tsx",
        new Set([signatureOf("componente.tsx", THREE, "catalog", "Lista()")]),
      ),
    ).toEqual([]);
  });

  it("declarações homônimas em escopos diferentes são ocorrências distintas", () => {
    const source = [
      "export const CATALOGO = [{ key: \"yui\" }, { key: \"alice\" }];",
      "export function montar() {",
      "  const CATALOGO = [{ key: \"schwi\" }, { key: \"alice\" }];",
      "  return CATALOGO;",
      "}",
    ].join("\n");
    const found = validate(source, "catalogo.ts", new Set());
    expect(found.map((entry) => entry.anchor)).toEqual(["CATALOGO", "montar@CATALOGO"]);
  });

  it("template literal e escapes dentro de string não confundem o parser", () => {
    const source = [
      "export const CATALOGO = [",
      '  { key: "yui", note: `fecha ] e abre [ ${"x"}` },',
      '  { key: "alice", note: "aspas \\" com ] dentro" },',
      '  { key: "schwi" },',
      "] as const;",
    ].join("\n");
    expect(validate(source, "catalogo.ts", new Set([LEGIT]))).toEqual([]);
    expect(validate(source, "catalogo.ts", new Set())).toHaveLength(1);
  });
});

describe("Fase 2 — guard anti-duplicação: catálogo de identidade ≠ permissão", () => {
  // O guard não pode tratar toda lista de chaves como cópia de catálogo. Uma permissão de
  // ferramenta (`authorizedAssistantKeys: ["alice"]`) e uma lista de alvos de delegação são
  // políticas sobre assistentes que existem — não uma segunda fonte de identidade. Catálogo de
  // identidade é o que declara `id`+`key`+`name` de um assistente.
  const validate = (source: string, file: string, allowed: ReadonlySet<string>) => {
    const root = mkdtempSync(join(tmpdir(), "nexus-guard-p2-"));
    const path = join(root, file);
    writeFileSync(path, source, "utf8");
    try {
      return findUndeclaredCoupling([path], root, allowed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("lista de permissão de ferramenta com uma chave não é acusada", () => {
    expect(validate('authorizedAssistantKeys: ["alice"]', "tool.ts", new Set())).toEqual([]);
  });

  it("lista de permissão de ferramenta com duas chaves é acusada como lista, não como catálogo", () => {
    // É acusada — é uma lista literal de chaves — mas com o padrão `list`. Chamar isso de
    // `catalog` seria classificar errado o acoplamento e induzir a correção errada.
    const found = validate('authorizedAssistantKeys: ["alice", "schwi"]', "tool.ts", new Set());
    expect(found).toHaveLength(1);
    expect(found[0]!.pattern).toBe("list");
  });

  it("uma fixture de teste não é varrida pelo guard", () => {
    // Fixtures legítimas citam uma chave por campo e vivem em `*.test-support`/`*.test.ts`.
    // O guard exclui arquivos de teste da varredura.
    const files = SCANNED_DIRECTORIES.flatMap((directory) => collectSourceFiles(directory));
    expect(files.some((file) => /\.(test|spec)\.tsx?$/.test(file))).toBe(false);
  });

  it("catálogo de identidade é o padrão que declara id+key+name juntos", () => {
    const source = [
      "export const CATALOGO = [",
      '  { id: "00000000-0000-4000-8000-000000000001", key: "yui", name: "YUI" },',
      '  { id: "00000000-0000-4000-8000-000000000002", key: "alice", name: "ALICE" },',
      "];",
    ].join("\n");
    const found = validate(source, "catalogo.ts", new Set());
    expect(found).toHaveLength(1);
    expect(found[0]!.pattern).toBe("catalog");
    expect(found[0]!.anchor).toBe("CATALOGO");
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
    // Fase 3: a fonte de verdade declara duas coisas — a identidade dos perfis (`catalog`) e a
    // política de coordenação (`delegateTo`). Ambas são permanentes porque ambas **são** o dado;
    // nenhum outro arquivo pode reivindicar permanência para uma cópia.
    const permanent = ALLOWED_OCCURRENCES.filter((entry) => entry.removedIn === "permanente");
    expect(new Set(permanent.map((entry) => entry.file))).toEqual(
      new Set(["packages/assistant-profiles/src/catalog.ts"]),
    );
    expect(permanent).toHaveLength(2);
  });

  it("o inventário não cresce silenciosamente: tamanho é explícito", () => {
    // Histórico do inventário, fase a fase:
    //   Fase 0: 9 ocorrências
    //   Fase 1: 8 — G5 removeu o enum local de `routes/core.ts`
    //   Fase 2: 4 — G4 serviu `routes/assistants.ts` do registro; G6 unificou o mobile
    //               (`lib/assistants.ts` derivado dos perfis, `config.ts` e a união de
    //               `core-service.ts` eliminados)
    //   Fase 3: 3 — G2 removeu as DUAS cópias da política de delegação (`delegation.ts` e
    //               `engine.ts`) e acrescentou UMA ocorrência na fonte de verdade
    //               (`delegateTo` do perfil da YUI). Saldo -1: a política passou a existir
    //               em um lugar só.
    // O número é explícito para que toda saída e entrada exija revisão consciente.
    expect(ALLOWED_OCCURRENCES).toHaveLength(3);
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
    for (const group of findCouplingGroups(source, relativePath)) {
      if (!allowed.has(signatureOf(relativePath, group.keys, "list"))) {
        found.push({ file: relativePath, line: group.line, keys: group.keys, pattern: "list" });
      }
    }
    for (const occurrence of findCatalogDeclarations(source, relativePath)) {
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
          ? findCouplingGroups(source, entry.file).some(
              (group) => signatureOf(entry.file, group.keys, "list") === signature,
            )
          : findCatalogDeclarations(source, entry.file).some(
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
