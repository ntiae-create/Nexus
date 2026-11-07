/**
 * @vitest-environment happy-dom
 *
 * The legacy override lives in `localStorage`, so these cases need a DOM.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  API_BASE_URL_STORAGE_KEY,
  DEVELOPMENT_API_BASE_URL,
  getApiBaseUrl,
  normalizeApiBaseUrl,
  readLegacyApiBaseUrl,
  resetApiBaseUrl,
  resolveApiBaseUrl,
  shouldMigrateLegacyApiBaseUrl,
} from "./config.js";

const setLegacy = (value: string): void => {
  window.localStorage.setItem(API_BASE_URL_STORAGE_KEY, value);
};

describe("api base url configuration", () => {
  describe("normalizeApiBaseUrl", () => {
    it("accepts absolute http and https URLs", () => {
      expect(normalizeApiBaseUrl("https://api.example.test")).toBe("https://api.example.test");
      expect(normalizeApiBaseUrl("http://192.168.0.10:3000")).toBe("http://192.168.0.10:3000");
    });

    it("trims whitespace and trailing slashes", () => {
      expect(normalizeApiBaseUrl("  https://api.example.test///  ")).toBe("https://api.example.test");
    });

    it("rejects relative, malformed and non-network values", () => {
      for (const value of ["", "   ", "/v1", "api.example.test", "ftp://api.example.test", "javascript:alert(1)"]) {
        expect(normalizeApiBaseUrl(value)).toBeNull();
      }
    });

    it("rejects URLs carrying credentials, query strings or fragments", () => {
      for (const value of [
        "https://user:pass@api.example.test",
        "https://api.example.test/?token=abc",
        "https://api.example.test/#frag",
      ]) {
        expect(normalizeApiBaseUrl(value)).toBeNull();
      }
    });

    it("rejects non-string input", () => {
      expect(normalizeApiBaseUrl(undefined)).toBeNull();
      expect(normalizeApiBaseUrl(null)).toBeNull();
      expect(normalizeApiBaseUrl(42)).toBeNull();
    });
  });

  describe("resolveApiBaseUrl", () => {
    it("prefers the value stored in the app configuration", () => {
      expect(
        resolveApiBaseUrl({
          stored: "https://stored.example.test",
          fromEnv: "https://env.example.test",
          native: true,
        }),
      ).toBe("https://stored.example.test");
    });

    it("falls back to VITE_NEXUS_API_URL", () => {
      expect(
        resolveApiBaseUrl({ stored: null, fromEnv: "https://env.example.test", native: true }),
      ).toBe("https://env.example.test");
    });

    it("ignores an invalid stored value and uses the build-time variable", () => {
      expect(
        resolveApiBaseUrl({ stored: "not-a-url", fromEnv: "https://env.example.test", native: true }),
      ).toBe("https://env.example.test");
    });

    it("uses the localhost default only in the browser", () => {
      expect(resolveApiBaseUrl({ stored: null, fromEnv: null, native: false })).toBe(
        DEVELOPMENT_API_BASE_URL,
      );
    });

    it("never assumes localhost on a physical Android device", () => {
      // The APK must fail explicitly as "not configured" instead of trying to reach
      // the phone itself, which would surface as an opaque network error.
      expect(resolveApiBaseUrl({ stored: null, fromEnv: null, native: true })).toBeNull();
    });
  });

  describe("legacy nexus.apiBaseUrl override", () => {
    beforeEach(() => {
      window.localStorage.clear();
      resetApiBaseUrl();
    });

    it("reads a valid legacy address from localStorage", () => {
      setLegacy("https://legacy.example.test/");
      expect(readLegacyApiBaseUrl()).toBe("https://legacy.example.test");
    });

    it("returns null when the legacy value is absent", () => {
      expect(readLegacyApiBaseUrl()).toBeNull();
    });

    it("ignores an unusable legacy value", () => {
      setLegacy("not-a-url");
      expect(readLegacyApiBaseUrl()).toBeNull();
    });

    it("is recovered by getApiBaseUrl before the development fallback", () => {
      // Regression: the browser used to skip the legacy key and go straight to
      // the localhost default, losing an address configured by an older build.
      setLegacy("https://legacy.example.test");
      expect(getApiBaseUrl()).toBe("https://legacy.example.test");
    });

    it("falls back to the development default when nothing is configured", () => {
      expect(getApiBaseUrl()).toBe(DEVELOPMENT_API_BASE_URL);
    });
  });

  describe("shouldMigrateLegacyApiBaseUrl", () => {
    it("migrates a legacy address when no preference exists", () => {
      expect(
        shouldMigrateLegacyApiBaseUrl({ stored: null, legacy: "https://legacy.example.test" }),
      ).toBe(true);
    });

    it("never overwrites a newer preference with the legacy value", () => {
      expect(
        shouldMigrateLegacyApiBaseUrl({
          stored: "https://current.example.test",
          legacy: "https://legacy.example.test",
        }),
      ).toBe(false);
    });

    it("does not migrate when the legacy value is unusable", () => {
      expect(shouldMigrateLegacyApiBaseUrl({ stored: null, legacy: "not-a-url" })).toBe(false);
    });

    it("does nothing when neither source is configured", () => {
      expect(shouldMigrateLegacyApiBaseUrl({ stored: null, legacy: null })).toBe(false);
    });
  });
});
