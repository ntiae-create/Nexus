import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const packageNames = ["shared", "assistant-profiles", "database", "tools"];

describe("monorepo foundation", () => {
  it("declares Node 24 and npm 11 compatibility", () => {
    expect(manifest.engines).toEqual({ node: ">=24 <25", npm: ">=11" });
  });

  it("prepares all exported packages in dependency order before consumers", async () => {
    const expected = packageNames.map((name) => `npm run build --workspace @nexus/${name}`).join(" && ");
    expect(manifest.scripts["build:packages"]).toBe(expected);
    for (const hook of ["prepare", "predev", "predev:server", "predev:mobile"]) {
      expect(manifest.scripts[hook]).toBe("npm run build:packages");
    }
    expect(manifest.scripts.build).toBe("npm run build:packages && npm run build --workspace @nexus/server && npm run build --workspace @nexus/mobile");
    expect(manifest.scripts.test).toBe("npm run build:packages && vitest run");
    for (const name of packageNames) {
      const exported = await import(`@nexus/${name}`);
      expect(Object.keys(exported).length).toBeGreaterThan(0);
    }
  });

  it("resolves one compatible Vite 7 for tests and mobile plugins", () => {
    const rootRequire = createRequire(resolve(root, "package.json"));
    const mobileRequire = createRequire(resolve(root, "apps/mobile/package.json"));
    const pluginRequire = createRequire(mobileRequire.resolve("@vitejs/plugin-react"));
    const vitePath = rootRequire.resolve("vite/package.json");
    expect(mobileRequire.resolve("vite/package.json")).toBe(vitePath);
    expect(pluginRequire.resolve("vite/package.json")).toBe(vitePath);
    expect(JSON.parse(readFileSync(vitePath, "utf8")).version.split(".")[0]).toBe("7");
  });
});