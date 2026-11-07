/**
 * @vitest-environment happy-dom
 *
 * The repository-wide config runs in `node`; this file exercises the browser
 * backend, so it needs `window`/`Storage`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The native plugin is stubbed at the module boundary. These tests assert the
 * app's *policy* — what it does when the keystore works, fails or is missing —
 * not Capacitor's own behaviour.
 */
const pluginState = {
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
};

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: vi.fn(() => true) },
  registerPlugin: vi.fn(() => pluginState),
}));

const preferencesState = {
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
};

vi.mock("@capacitor/preferences", () => ({
  Preferences: preferencesState,
}));

const { createNativeSecureStorage, createWebSecureStorage, SecureStorageError } = await import(
  "./secure-storage.js"
);

describe("secure storage", () => {
  beforeEach(() => {
    pluginState.get.mockReset();
    pluginState.set.mockReset();
    pluginState.remove.mockReset();
    preferencesState.get.mockReset();
    preferencesState.set.mockReset();
    preferencesState.remove.mockReset();
  });

  describe("native backend", () => {
    it("stores and reads the token through the native secure plugin", async () => {
      const storage = createNativeSecureStorage();
      pluginState.set.mockResolvedValue(undefined);
      pluginState.get.mockResolvedValue({ value: "token-1" });

      await storage.save("token-1");
      const read = await storage.get();

      expect(pluginState.set).toHaveBeenCalledWith({ key: "nexus.session.token", value: "token-1" });
      expect(read).toBe("token-1");
      expect(storage.backend).toBe("native");
    });

    it("never falls back to plain storage when the keystore fails", async () => {
      const storage = createNativeSecureStorage();
      pluginState.set.mockRejectedValue(new Error("keystore unavailable"));

      await expect(storage.save("token-1")).rejects.toBeInstanceOf(SecureStorageError);
      // The failure must not be masked by writing the token anywhere else.
      expect(preferencesState.set).not.toHaveBeenCalled();
    });

    it("reports a read failure instead of returning a bogus token", async () => {
      const storage = createNativeSecureStorage();
      pluginState.get.mockRejectedValue(new Error("corrupted"));

      await expect(storage.get()).rejects.toBeInstanceOf(SecureStorageError);
    });

    it("treats an empty stored value as no session", async () => {
      const storage = createNativeSecureStorage();
      pluginState.get.mockResolvedValue({ value: "" });

      await expect(storage.get()).resolves.toBeNull();
    });

    it("propagates a clear failure so the caller knows removal was not confirmed", async () => {
      const storage = createNativeSecureStorage();
      pluginState.remove.mockRejectedValue(new Error("unavailable"));

      await expect(storage.clear()).rejects.toBeInstanceOf(SecureStorageError);
    });
  });

  describe("web backend", () => {
    it("keeps the token in memory for the lifetime of the page", async () => {
      const storage = createWebSecureStorage();

      await storage.save("token-web");

      await expect(storage.get()).resolves.toBe("token-web");
      expect(storage.backend).toBe("web");
    });

    it("never writes the token to localStorage or to Capacitor Preferences", async () => {
      const storage = createWebSecureStorage();
      const localSet = vi.spyOn(Storage.prototype, "setItem");

      await storage.save("token-web");

      // Capacitor's Preferences web implementation is window.localStorage, so any
      // call to it would show up here. It must not be used for credentials at all.
      expect(localSet).not.toHaveBeenCalled();
      expect(preferencesState.set).not.toHaveBeenCalled();
      const persisted = Object.keys(window.localStorage).map(
        (key) => window.localStorage.getItem(key) ?? "",
      );
      expect(persisted.join(" ")).not.toContain("token-web");
    });

    it("starts empty after a reload instead of restoring an unvalidated token", async () => {
      preferencesState.get.mockResolvedValue({ value: "leftover" });
      const storage = createWebSecureStorage();

      await expect(storage.get()).resolves.toBeNull();
    });

    it("clears the in-memory token", async () => {
      const storage = createWebSecureStorage();

      await storage.save("token-web");
      await storage.clear();

      await expect(storage.get()).resolves.toBeNull();
    });
  });
});
