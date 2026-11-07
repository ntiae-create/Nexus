import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { initialAssistantKeySchema } from "@nexus/shared";
import {
  ASSISTANT_CATALOG,
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
const migrationSource = readFileSync(
  resolve(repoRoot, "packages/database/migrations/00001_initial_schema.sql"),
  "utf8",
);

/** `{ id, key, name }` triples extracted from the frozen catalog source. */
function frozenProfiles(): { id: string; key: string; name: string }[] {
  const pattern = /id:\s*"([^"]+)",\s*\n\s*key:\s*"([^"]+)",\s*\n\s*name:\s*"([^"]+)"/g;
  return [...catalogSource.matchAll(pattern)].map((match) => ({
    id: match[1]!,
    key: match[2]!,
    name: match[3]!,
  }));
}

/** `('uuid', 'key', 'NAME', ...)` rows of the seeded `nexus.assistants` insert. */
function seededAssistants(): { id: string; key: string; name: string }[] {
  const insertStart = migrationSource.indexOf("INSERT INTO nexus.assistants");
  expect(insertStart).toBeGreaterThan(-1);
  const insertEnd = migrationSource.indexOf(";", insertStart);
  const block = migrationSource.slice(insertStart, insertEnd);
  const pattern = /\('([0-9a-f-]+)',\s*'([a-z]+)',\s*'([A-Z]+)'/g;
  return [...block.matchAll(pattern)].map((match) => ({
    id: match[1]!,
    key: match[2]!,
    name: match[3]!,
  }));
}

describe("assistant catalog mirror", () => {
  it("found the frozen catalog and the seeded rows (guard against a silent empty match)", () => {
    expect(frozenProfiles()).toHaveLength(3);
    expect(seededAssistants()).toHaveLength(3);
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
    expect(Object.isFrozen(ASSISTANT_CATALOG)).toBe(true);
    expect(Object.isFrozen(ASSISTANT_CATALOG[0])).toBe(true);
  });

  it("exposes exactly YUI, ALICE and SCHWI for selection", () => {
    expect(ASSISTANT_CATALOG.map((assistant) => assistant.name)).toEqual([
      "YUI",
      "ALICE",
      "SCHWI",
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
