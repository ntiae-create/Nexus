import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { join } from "node:path";

/**
 * Locks the decision logic of `android/scripts/apk-network-policy.sh`, the script the
 * CI runs against the APKs it builds.
 *
 * The dumps below are `aapt2 dump xmltree` output, not our source XMLs: the point is
 * that the verdict is reached by inspecting what the build produced. Keeping the
 * script honest here means a CI failure later reflects a real policy regression
 * rather than a broken checker.
 */
const script = resolve(import.meta.dirname, "../../android/scripts/apk-network-policy.sh");

const MANIFEST_OK = `E: manifest (line=2)
  A: android:networkSecurityConfig(0x01010527)=@0x7f0e0000
`;

const MANIFEST_WITHOUT_CONFIG = `E: manifest (line=2)
  A: android:allowBackup(0x01010280)=(type 0x12)0xffffffff
`;

const MANIFEST_WITH_GLOBAL_CLEARTEXT = `E: manifest (line=2)
  A: android:networkSecurityConfig(0x01010527)=@0x7f0e0000
  A: android:usesCleartextTraffic(0x010104ec)=(type 0x12)0xffffffff
`;

const CONFIG_RELEASE = `E: network-security-config (line=9)
  E: base-config (line=10)
    A: cleartextTrafficPermitted=false
    E: trust-anchors (line=11)
      E: certificates (line=12)
        A: src="system"
`;

const CONFIG_DEBUG = `E: network-security-config (line=9)
  E: base-config (line=10)
    A: cleartextTrafficPermitted=false
  E: domain-config (line=11)
    A: cleartextTrafficPermitted=true
    E: domain (line=12)
      A: includeSubdomains=false
      T: 'localhost'
    E: domain (line=13)
      A: includeSubdomains=false
      T: '10.0.2.2'
`;

const CONFIG_OPEN_BASE = CONFIG_RELEASE.replace(
  "A: cleartextTrafficPermitted=false",
  "A: cleartextTrafficPermitted=true",
);

const withDomain = (address: string): string =>
  CONFIG_DEBUG.replace("T: '10.0.2.2'", `T: '${address}'`);

interface RunResult {
  readonly status: number;
  readonly output: string;
}

function runCheck(variant: "debug" | "release", manifest: string, config: string): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "apk-policy-"));
  try {
    const manifestPath = join(dir, "manifest.txt");
    const configPath = join(dir, "config.txt");
    writeFileSync(manifestPath, manifest);
    writeFileSync(configPath, config);

    try {
      const output = execFileSync("bash", [script, "check", variant, manifestPath, configPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, output };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return {
        status: failure.status ?? 1,
        output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("APK network policy verifier — accepted artifacts", () => {
  it("accepts a release APK that denies cleartext everywhere", () => {
    const result = runCheck("release", MANIFEST_OK, CONFIG_RELEASE);
    expect(result.output).toContain("PASS: release APK network policy is correct");
    expect(result.status).toBe(0);
  });

  it("accepts a debug APK limited to loopback and the emulator alias", () => {
    const result = runCheck("debug", MANIFEST_OK, CONFIG_DEBUG);
    expect(result.output).toContain("PASS: debug APK network policy is correct");
    expect(result.status).toBe(0);
  });

  it("requires the compiled manifest to reference the config resource", () => {
    expect(runCheck("release", MANIFEST_OK, CONFIG_RELEASE).output).toContain(
      "manifest references a network security config resource",
    );
  });
});

describe("APK network policy verifier — compiled boolean encodings", () => {
  // aapt2 may render a boolean as its compiled binary form. Both encodings mean
  // the same thing, and treating one as invalid would reject a correct APK (or,
  // worse, accept a permissive one).
  // Matches what a real debug APK contains: base-config denied (compiled as 0x0)
  // and the domain exception allowed (compiled as 0xffffffff).
  const BINARY_OPEN = CONFIG_DEBUG
    .replace("A: cleartextTrafficPermitted=false", "A: cleartextTrafficPermitted=(type 0x12)0x0")
    .replace(
      "A: cleartextTrafficPermitted=true",
      "A: cleartextTrafficPermitted=(type 0x12)0xffffffff",
    );

  const BINARY_CLOSED_RELEASE = CONFIG_RELEASE.replace(
    "A: cleartextTrafficPermitted=false",
    "A: cleartextTrafficPermitted=(type 0x12)0x0",
  );

  it("reads a binary-encoded false as a denial", () => {
    const result = runCheck("release", MANIFEST_OK, BINARY_CLOSED_RELEASE);
    expect(result.status).toBe(0);
    expect(result.output).toContain("PASS: release APK network policy is correct");
  });

  it("reads a binary-encoded true as permission and rejects it for release", () => {
    const binaryOpenRelease = CONFIG_RELEASE.replace(
      "A: cleartextTrafficPermitted=false",
      "A: cleartextTrafficPermitted=(type 0x12)0xffffffff",
    );
    const result = runCheck("release", MANIFEST_OK, binaryOpenRelease);
    expect(result.status).toBe(1);
    expect(result.output).toContain("expected 'false'");
  });

  it("accepts a debug APK whose booleans are binary-encoded", () => {
    const result = runCheck("debug", MANIFEST_OK, BINARY_OPEN);
    expect(result.status).toBe(0);
  });

  it("prints the compiled dumps when a check fails", () => {
    // A CI failure must be diagnosable without re-running the job.
    const result = runCheck("release", MANIFEST_OK, CONFIG_DEBUG);
    expect(result.output).toContain("compiled network security config");
    expect(result.output).toContain("E: domain-config");
  });
});

describe("APK network policy verifier — rejected artifacts", () => {
  it("rejects a release APK carrying the debug cleartext exception", () => {
    const result = runCheck("release", MANIFEST_OK, CONFIG_DEBUG);
    expect(result.status).toBe(1);
    expect(result.output).toContain("debug policy leaked into release");
  });

  it("rejects a global cleartext base configuration", () => {
    const result = runCheck("release", MANIFEST_OK, CONFIG_OPEN_BASE);
    expect(result.status).toBe(1);
    expect(result.output).toContain("expected 'false'");
  });

  it("rejects a manifest without a network security config", () => {
    const result = runCheck("release", MANIFEST_WITHOUT_CONFIG, CONFIG_RELEASE);
    expect(result.status).toBe(1);
    expect(result.output).toContain("does not reference @xml/network_security_config");
  });

  it("rejects a manifest declaring usesCleartextTraffic", () => {
    const result = runCheck("release", MANIFEST_WITH_GLOBAL_CLEARTEXT, CONFIG_RELEASE);
    expect(result.status).toBe(1);
    expect(result.output).toContain("opens cleartext globally");
  });

  it("rejects CIDR notation in the debug allow-list", () => {
    const result = runCheck("debug", MANIFEST_OK, withDomain("192.168.0.0/16"));
    expect(result.status).toBe(1);
    expect(result.output).toContain("CIDR notation");
  });

  it("rejects a public address in the debug allow-list", () => {
    const result = runCheck("debug", MANIFEST_OK, withDomain("8.8.8.8"));
    expect(result.status).toBe(1);
    expect(result.output).toContain("not an approved local address");
  });

  it("rejects a debug APK that grants no local exception at all", () => {
    const result = runCheck("debug", MANIFEST_OK, CONFIG_RELEASE);
    expect(result.status).toBe(1);
    expect(result.output).toContain("does not grant cleartext");
  });

  it("rejects an unknown variant name", () => {
    // Guards against a typo in the CI invocation silently skipping the checks.
    const result = runCheck("staging" as "debug", MANIFEST_OK, CONFIG_RELEASE);
    expect(result.status).toBe(1);
    expect(result.output).toContain("unknown variant");
  });
});
