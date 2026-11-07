/**
 * @vitest-environment happy-dom
 *
 * The bootstrap reads the legacy `localStorage` address and the native
 * `Preferences` store, so it needs a DOM and a stubbed platform.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  native: false,
  preferences: new Map<string, string>(),
  writes: [] as Array<{ key: string; value: string }>,
  failWrite: false,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => state.native },
  registerPlugin: () => ({
    get: async () => ({ value: null }),
    set: async () => undefined,
    remove: async () => undefined,
  }),
}));

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: state.preferences.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => {
      if (state.failWrite) throw new Error("preferences unavailable");
      state.writes.push({ key, value });
      state.preferences.set(key, value);
    },
    remove: async ({ key }: { key: string }) => {
      state.preferences.delete(key);
    },
  },
}));

const { bootstrapApp } = await import("./bootstrap.js");
const {
  API_BASE_URL_PREFERENCE_KEY,
  API_BASE_URL_STORAGE_KEY,
  DEVELOPMENT_API_BASE_URL,
  resetApiBaseUrl,
} = await import("../config.js");

const setLegacy = (value: string): void => {
  window.localStorage.setItem(API_BASE_URL_STORAGE_KEY, value);
};

beforeEach(() => {
  state.native = false;
  state.preferences.clear();
  state.writes.length = 0;
  state.failWrite = false;
  window.localStorage.clear();
  resetApiBaseUrl();
});

describe("bootstrapApiBaseUrl — browser", () => {
  it("recovers the legacy localStorage address before the development default", async () => {
    setLegacy("https://legacy.example.test/");

    const container = await bootstrapApp();

    // Regression: bootstrap used to ignore `nexus.apiBaseUrl` on the web and fall
    // straight through to `http://localhost:3000`.
    expect(container.apiBaseUrl).toBe("https://legacy.example.test");
  });

  it("uses the development default when nothing is configured", async () => {
    const container = await bootstrapApp();

    expect(container.apiBaseUrl).toBe(DEVELOPMENT_API_BASE_URL);
  });

  it("ignores an unusable legacy value and keeps the default", async () => {
    setLegacy("not-a-url");

    const container = await bootstrapApp();

    expect(container.apiBaseUrl).toBe(DEVELOPMENT_API_BASE_URL);
  });

  it("reads nothing from the native preferences store on the web", async () => {
    state.preferences.set(API_BASE_URL_PREFERENCE_KEY, "https://native-only.example.test");

    const container = await bootstrapApp();

    expect(container.apiBaseUrl).toBe(DEVELOPMENT_API_BASE_URL);
  });
});

describe("bootstrapApiBaseUrl — Android", () => {
  it("migrates the legacy address into Preferences", async () => {
    state.native = true;
    setLegacy("https://legacy.example.test/");

    const container = await bootstrapApp();

    expect(container.apiBaseUrl).toBe("https://legacy.example.test");
    expect(state.writes).toEqual([
      { key: API_BASE_URL_PREFERENCE_KEY, value: "https://legacy.example.test" },
    ]);
    expect(state.preferences.get(API_BASE_URL_PREFERENCE_KEY)).toBe("https://legacy.example.test");
  });

  it("never overwrites a newer preference with the legacy address", async () => {
    state.native = true;
    state.preferences.set(API_BASE_URL_PREFERENCE_KEY, "https://current.example.test");
    setLegacy("https://legacy.example.test");

    const container = await bootstrapApp();

    expect(container.apiBaseUrl).toBe("https://current.example.test");
    expect(state.writes).toHaveLength(0);
    expect(state.preferences.get(API_BASE_URL_PREFERENCE_KEY)).toBe("https://current.example.test");
  });

  it("reports no address when neither source is configured", async () => {
    state.native = true;

    const container = await bootstrapApp();

    // Never `localhost`: on a handset that addresses the phone itself.
    expect(container.apiBaseUrl).toBeNull();
    expect(state.writes).toHaveLength(0);
  });

  it("does not migrate an unusable legacy value", async () => {
    state.native = true;
    setLegacy("not-a-url");

    const container = await bootstrapApp();

    expect(container.apiBaseUrl).toBeNull();
    expect(state.writes).toHaveLength(0);
  });

  it("keeps working for the session when the migration write fails", async () => {
    state.native = true;
    state.failWrite = true;
    setLegacy("https://legacy.example.test");

    const container = await bootstrapApp();

    expect(container.apiBaseUrl).toBe("https://legacy.example.test");
  });

  it("uses a preference set by this build without touching the legacy key", async () => {
    state.native = true;
    state.preferences.set(API_BASE_URL_PREFERENCE_KEY, "https://current.example.test");

    const container = await bootstrapApp();

    expect(container.apiBaseUrl).toBe("https://current.example.test");
    expect(state.writes).toHaveLength(0);
  });
});
