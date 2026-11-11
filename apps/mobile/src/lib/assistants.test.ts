import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { initialAssistantKeySchema } from "@nexus/shared";
import {
  ASSISTANT_CATALOG,
  FALLBACK_CATALOG,
  getAssistantById,
  getAssistantByKey,
  getConversationAssistants,
  resolveAssistantLabel,
} from "./assistants.js";

/**
 * The mobile catalog is a read-only mirror of the frozen profile catalog and of the rows
 * seeded by migration `00001`. These tests read those real files and fail if the mirror ever
 * diverges, so a renamed assistant or a changed UUID breaks the build instead of shipping a
 * mislabelled message. No package dependency is added: the sources are read as text.
 */
/**
 * Locates the repository root independently of the working directory.
 *
 * The monorepo suite runs from the repository root while the mobile suite runs from
 * `apps/mobile`; walking up until `package-lock.json` and `packages/` both exist makes the
 * mirror check work in either case (and from any future workspace runner).
 */
function findRepoRoot(): string {
  let current = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (
      existsSync(resolve(current, "package-lock.json")) &&
      existsSync(resolve(current, "packages/assistant-profiles/src/catalog.ts"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`repository root not found from ${process.cwd()}`);
}

const repoRoot = findRepoRoot();
const catalogSource = readFileSync(
  resolve(repoRoot, "packages/assistant-profiles/src/catalog.ts"),
  "utf8",
);
// O seed é lido das duas migrations que o compõem: a 00001 (as três iniciais) e a 00006 (a VIVY
// da Fase 4). A 00001 é imutável — migrations aplicadas não são reescritas —, então o estado final
// do seed é a união das duas, e é isso que o espelho do app precisa refletir.
const migrationSources = [
  "packages/database/migrations/00001_initial_schema.sql",
  "packages/database/migrations/00006_assistant_seed_vivy.sql",
].map((file) => readFileSync(resolve(repoRoot, file), "utf8"));

/** `{ id, key, name }` triples extracted from the frozen catalog source. */
function frozenProfiles(): { id: string; key: string; name: string }[] {
  const pattern = /id:\s*"([^"]+)",\s*\n\s*key:\s*"([^"]+)",\s*\n\s*name:\s*"([^"]+)"/g;
  return [...catalogSource.matchAll(pattern)].map((match) => ({
    id: match[1]!,
    key: match[2]!,
    name: match[3]!,
  }));
}

/** `('uuid', 'key', 'NAME', ...)` rows of every seeded `nexus.assistants` insert, in file order. */
function seededAssistants(): { id: string; key: string; name: string }[] {
  // `\(\s*` porque a 00001 escreve as linhas na mesma linha do `VALUES (` e a 00006 abre o
  // parêntese numa linha e o uuid na seguinte. O que é extraído continua estrito: uuid, chave em
  // minúsculas e nome em maiúsculas, na ordem das colunas.
  const pattern = /\(\s*'([0-9a-f-]+)',\s*'([a-z]+)',\s*'([A-Z]+)'/g;
  const rows: { id: string; key: string; name: string }[] = [];
  for (const source of migrationSources) {
    const insertStart = source.indexOf("INSERT INTO nexus.assistants");
    // Cada migration que compõe o seed precisa ter o INSERT, senão o silêncio de uma delas faria
    // a comparação passar com menos linhas do que o banco realmente terá.
    expect(insertStart, "migration sem INSERT em nexus.assistants").toBeGreaterThan(-1);
    const insertEnd = source.indexOf(";", insertStart);
    const block = source.slice(insertStart, insertEnd);
    for (const match of block.matchAll(pattern)) {
      rows.push({ id: match[1]!, key: match[2]!, name: match[3]! });
    }
  }
  return rows;
}

describe("assistant catalog mirror", () => {
  it("found the frozen catalog and the seeded rows (guard against a silent empty match)", () => {
    // Fase 4: quatro perfis e quatro linhas de seed. A guarda contra casamento vazio continua
    // sendo o ponto — os números literais só acompanham o catálogo.
    expect(frozenProfiles()).toHaveLength(4);
    expect(seededAssistants()).toHaveLength(4);
  });

  it("matches the frozen profiles id/key/name exactly, in order", () => {
    expect(
      ASSISTANT_CATALOG.map(({ id, key, name }) => ({ id, key, name })),
    ).toEqual(frozenProfiles());
  });

  it("matches the assistant rows seeded by migration 00001", () => {
    expect(
      ASSISTANT_CATALOG.map(({ id, key, name }) => ({ id, key, name })),
    ).toEqual(seededAssistants());
  });

  it("uses only keys accepted by the shared contract schema", () => {
    for (const assistant of ASSISTANT_CATALOG) {
      expect(initialAssistantKeySchema.safeParse(assistant.key).success).toBe(true);
    }
  });

  it("is frozen so no screen can mutate the catalog at runtime", () => {
    // Fase 2 (G6): `ASSISTANT_CATALOG` passou a ser o catálogo **em uso**, substituído pela
    // resposta de `GET /v1/assistants` — ele é mutável por desenho, e só por `applyCatalogFromApi`
    // / `resetAssistantCatalog`. A garantia de imutabilidade migrou para o fallback de build, que
    // é o que um telas não pode alterar, e para cada entrada, que continua congelada.
    expect(Object.isFrozen(FALLBACK_CATALOG)).toBe(true);
    expect(Object.isFrozen(FALLBACK_CATALOG[0])).toBe(true);
    expect(Object.isFrozen(ASSISTANT_CATALOG[0])).toBe(true);
  });

  it("exposes exactly YUI, ALICE, SCHWI and VIVY for selection", () => {
    expect(ASSISTANT_CATALOG.map((assistant) => assistant.name)).toEqual([
      "YUI",
      "ALICE",
      "SCHWI",
      "VIVY",
    ]);
  });
});

describe("assistant lookup", () => {
  it("resolves by key, case-insensitively", () => {
    expect(getAssistantByKey("yui")?.name).toBe("YUI");
    expect(getAssistantByKey("ALICE")?.name).toBe("ALICE");
    expect(getAssistantByKey("Schwi")?.name).toBe("SCHWI");
  });

  it("resolves by canonical id", () => {
    expect(getAssistantById("00000000-0000-4000-8000-000000000002")?.key).toBe("alice");
  });

  it("returns undefined for unknown keys and ids instead of guessing", () => {
    expect(getAssistantByKey("unknown")).toBeUndefined();
    expect(getAssistantByKey(null)).toBeUndefined();
    expect(getAssistantById("00000000-0000-4000-8000-0000000000ff")).toBeUndefined();
  });

  it("keeps the server order when resolving conversation participants", () => {
    const resolved = getConversationAssistants([
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000001",
    ]);
    expect(resolved.map((assistant) => assistant.key)).toEqual(["schwi", "yui"]);
  });

  it("drops ids outside this build's catalog instead of rendering them", () => {
    const resolved = getConversationAssistants([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-0000000000aa",
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.key).toBe("yui");
  });
});

describe("assistant label for persisted messages", () => {
  it("prefers the persisted assistantKey", () => {
    expect(
      resolveAssistantLabel({
        assistantId: "00000000-0000-4000-8000-000000000001",
        metadata: { assistantKey: "alice" },
      }),
    ).toBe("ALICE");
  });

  it("falls back to the canonical assistantId", () => {
    expect(resolveAssistantLabel({ assistantId: "00000000-0000-4000-8000-000000000003" })).toBe(
      "SCHWI",
    );
  });

  it("returns null when the author is not in the catalog", () => {
    expect(
      resolveAssistantLabel({ assistantId: "00000000-0000-4000-8000-0000000000bb" }),
    ).toBeNull();
    expect(resolveAssistantLabel({})).toBeNull();
  });
});
