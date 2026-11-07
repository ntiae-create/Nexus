import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Guards the Android cleartext-traffic policy.
 *
 * `targetSdkVersion` is 35, and since Android 9 (API 28) cleartext HTTP is denied
 * by default. Development against a LAN backend therefore needs an explicit
 * Network Security Configuration that must never leak into a release build. These
 * checks fail if someone re-enables cleartext globally or ships the debug policy.
 */
const androidDir = resolve(import.meta.dirname, "../../android/app/src");
const read = (relative: string): string => readFileSync(resolve(androidDir, relative), "utf8");

const manifestPath = "main/AndroidManifest.xml";
const mainConfigPath = "main/res/xml/network_security_config.xml";
const debugConfigPath = "debug/res/xml/network_security_config.xml";

/**
 * Minimal reader for the network security config.
 *
 * The file is small and machine-generated in shape, so targeted regexes keep this
 * dependency-free. Comments are stripped first so that prose mentioning an
 * attribute cannot be mistaken for the attribute itself.
 */
interface NscDocument {
  readonly baseCleartext: string | null;
  readonly domainCleartext: string | null;
  readonly domains: string[];
}

const withoutComments = (xml: string): string => xml.replace(/<!--[\s\S]*?-->/g, "");

function readNsc(relative: string): NscDocument {
  const xml = withoutComments(read(relative));

  const base = /<base-config\b[^>]*cleartextTrafficPermitted="([^"]*)"/.exec(xml);
  const domainConfig = /<domain-config\b[^>]*cleartextTrafficPermitted="([^"]*)"/.exec(xml);

  const domains = [...xml.matchAll(/<domain\b[^>]*>([^<]*)<\/domain>/g)].map((match) =>
    match[1]!.trim(),
  );

  return {
    baseCleartext: base?.[1] ?? null,
    domainCleartext: domainConfig?.[1] ?? null,
    domains,
  };
}

describe("Android manifest", () => {
  it("references a network security config", () => {
    expect(read(manifestPath)).toContain(
      'android:networkSecurityConfig="@xml/network_security_config"',
    );
  });

  it("does not rely on the deprecated global cleartext switch", () => {
    // `usesCleartextTraffic` would override the config file and open HTTP to every
    // destination, which is exactly what must not happen in a release APK.
    expect(read(manifestPath)).not.toContain("usesCleartextTraffic");
  });
});

describe("release network security config (main)", () => {
  it("exists", () => {
    expect(existsSync(resolve(androidDir, mainConfigPath))).toBe(true);
  });

  it("denies cleartext traffic globally", () => {
    const nsc = readNsc(mainConfigPath);
    expect(nsc.baseCleartext).toBe("false");
  });

  it("grants no cleartext exception to any destination", () => {
    const nsc = readNsc(mainConfigPath);
    // No domain-config at all is the strongest form: nothing can opt out of the
    // base rule.
    expect(nsc.domainCleartext).not.toBe("true");
    expect(nsc.domains).toHaveLength(0);
  });

  it("states the HTTPS requirement for production", () => {
    expect(read(mainConfigPath)).toContain("https://");
  });
});

describe("debug network security config", () => {
  it("stays under the debug source set only", () => {
    expect(existsSync(resolve(androidDir, debugConfigPath))).toBe(true);
    // The release source set must never contain a permissive variant.
    expect(existsSync(resolve(androidDir, "main/res/xml/network_security_config_debug.xml"))).toBe(
      false,
    );
  });

  it("keeps cleartext denied by default", () => {
    const nsc = readNsc(debugConfigPath);
    expect(nsc.baseCleartext).toBe("false");
  });

  it("opens cleartext only through an explicit domain list", () => {
    const nsc = readNsc(debugConfigPath);
    expect(nsc.domainCleartext).toBe("true");
    expect(nsc.domains.length).toBeGreaterThan(0);
  });

  it("allows the emulator host alias and loopback", () => {
    const { domains } = readNsc(debugConfigPath);
    expect(domains).toContain("10.0.2.2");
    expect(domains).toContain("localhost");
    expect(domains).toContain("127.0.0.1");
  });

  it("uses no CIDR notation, which the platform does not support", () => {
    // A rule like 192.168.0.0/16 silently matches nothing while appearing to
    // grant LAN access — the failure mode this whole file exists to prevent.
    for (const domain of readNsc(debugConfigPath).domains) {
      expect(domain).not.toContain("/");
    }
  });

  it("lists only literal private or loopback addresses", () => {
    const { domains } = readNsc(debugConfigPath);
    const isPrivate = (host: string): boolean =>
      host === "localhost" ||
      host === "10.0.2.2" ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host);

    for (const domain of domains) {
      expect(isPrivate(domain), `${domain} is not a private/loopback address`).toBe(true);
    }
  });

  it("documents the adb reverse alternative", () => {
    expect(read(debugConfigPath)).toContain("adb reverse");
  });
});
