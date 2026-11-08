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
 * `apps/mobile/src/lib/config.ts` e `routes/assistants.ts` não têm lista literal — têm uma
 * sequência de objetos `{ key: "yui", … }, { key: "alice", … }`. Uma leitura por "lista de
 * strings" não os vê, e é justamente isso que os torna cópias silenciosas da fonte de verdade.
 *
 * Este detector conta chaves distintas declaradas como **propriedade** `key:` / `assistantKey:`
 * no mesmo arquivo. Duas ou mais distintas caracterizam catálogo recriado. Um arquivo que cita
 * uma única chave (fixture, permissão de ferramenta) não é acoplamento.
 */
export function findCatalogDeclarations(rawSource: string): CouplingGroup[] {
  const source = stripComments(rawSource);
  const property = /\b(?:key|assistantKey)\s*:\s*(["'`])(yui|alice|schwi)\1/g;
  const keys: string[] = [];
  let firstLine = 0;

  for (const match of source.matchAll(property)) {
    const line = source.slice(0, match.index ?? 0).split("\n").length;
    if (keys.length === 0) firstLine = line;
    keys.push(match[2]!);
  }

  const distinct = [...new Set(keys)];
  return distinct.length >= 2 ? [{ keys: distinct, line: firstLine }] : [];
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
  readonly reason: string;
  /**
   * Fase responsável por eliminar esta ocorrência — ou `"permanente"` quando a ocorrência **não
   * deve** ser removida por ser ela própria a fonte de verdade (o catálogo canônico de perfis).
   * Um valor de fase aqui é uma promessa: a fase que remover o ponto também remove a entrada
   * (verificado pelo teste "toda ocorrência declarada ainda existe").
   */
  readonly removedIn: string;
}

export function signatureOf(
  file: string,
  keys: readonly string[],
  pattern: CouplingPattern,
): string {
  return `${pattern}:${file}::${[...keys].sort().join(",")}`;
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
    reason: "espelho do catálogo congelado — proteção válida, não cópia de lógica",
    removedIn: "Fase 1",
  },
  {
    file: "apps/mobile/src/lib/config.ts",
    keys: ["yui", "alice", "schwi"],
    pattern: "catalog",
    reason: "catálogo de apresentação do mobile (rótulos/cores) — Fase 1 unifica (G4)",
    removedIn: "Fase 1",
  },
  {
    file: "apps/server/src/routes/assistants.ts",
    keys: ["yui", "alice", "schwi"],
    pattern: "catalog",
    reason: "array literal da rota L9 — corrigido por derivação do registro na Fase 2",
    removedIn: "Fase 2",
  },
  {
    file: "packages/assistant-profiles/src/catalog.ts",
    keys: ["yui", "alice", "schwi"],
    pattern: "catalog",
    reason: "catálogo canônico dos perfis — é a fonte de verdade, não uma cópia",
    // Não é remoção: quando `InitialAssistantKey` for generalizado (Fase 1), o catálogo
    // continua sendo o catálogo. Marcar uma fase aqui prometeria uma remoção que não acontece.
    removedIn: "permanente",
  },
];

/** Todas as ocorrências (lista e catálogo) com a assinatura que as identifica. */
function allSignatures(): Set<string> {
  return new Set(
    ALLOWED_OCCURRENCES.map((entry) => signatureOf(entry.file, entry.keys, entry.pattern)),
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
      const groups =
        entry.pattern === "list" ? findCouplingGroups(source) : findCatalogDeclarations(source);
      expect(
        groups.some(
          (group) =>
            signatureOf(entry.file, group.keys, entry.pattern) ===
            signatureOf(entry.file, entry.keys, entry.pattern),
        ),
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

describe("Fase 0 — allowlist é por ocorrência, não por arquivo", () => {
  it("a mesma assinatura de uma ocorrência legítima está liberada", () => {
    const allowed = allSignatures();
    expect(
      allowed.has(
        signatureOf("packages/shared/src/schemas/assistants.ts", ["yui", "alice", "schwi"], "list"),
      ),
    ).toBe(true);
  });

  it("uma lista nova no MESMO arquivo de uma ocorrência legítima não é liberada", () => {
    // Simula o relatório do scanner: o arquivo já permitido ganha um grupo adicional de duas
    // chaves que não corresponde à assinatura declarada.
    const allowed = allSignatures();
    // Mesmo arquivo, mesma ocorrência legítima já declarada…
    expect(
      allowed.has(
        signatureOf("packages/shared/src/schemas/assistants.ts", ["yui", "alice", "schwi"], "list"),
      ),
    ).toBe(true);
    // …mas uma lista adicional, com outro conjunto de chaves, não está coberta.
    expect(
      allowed.has(signatureOf("packages/shared/src/schemas/assistants.ts", ["yui", "alice"], "list")),
    ).toBe(false);
  });

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

  it("a allowlist não declara um arquivo inteiro: cada entrada tem padrão definido", () => {
    // Sem `pattern`, uma entrada liberaria qualquer formato naquele arquivo — exatamente a
    // exceção ampla que este guard evita.
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
export function findUndeclaredCoupling(
  files: readonly string[],
  repoRoot: string,
  allowed: ReadonlySet<string>,
): { file: string; line: number; keys: readonly string[]; pattern: string }[] {
  return files.flatMap((file) => {
    const relativePath = relative(repoRoot, file);
    const source = readFileSync(file, "utf8");
    const found: { file: string; line: number; keys: readonly string[]; pattern: string }[] = [];
    for (const group of findCouplingGroups(source)) {
      if (!allowed.has(signatureOf(relativePath, group.keys, "list"))) {
        found.push({ file: relativePath, line: group.line, keys: group.keys, pattern: "list" });
      }
    }
    for (const group of findCatalogDeclarations(source)) {
      if (!allowed.has(signatureOf(relativePath, group.keys, "catalog"))) {
        found.push({ file: relativePath, line: group.line, keys: group.keys, pattern: "catalog" });
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
      const groups =
        entry.pattern === "list" ? findCouplingGroups(source) : findCatalogDeclarations(source);
      const signature = signatureOf(entry.file, entry.keys, entry.pattern);
      const found = groups.some(
        (group) => signatureOf(entry.file, group.keys, entry.pattern) === signature,
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
