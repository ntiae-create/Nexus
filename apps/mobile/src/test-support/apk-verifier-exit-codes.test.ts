import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Exit-code contract of `android/scripts/apk-network-policy.sh`.
 *
 * A PASS that still exits 1 is the worst failure mode here: the CI goes red on a
 * correct APK and the signal stops being trusted. These tests run the real script
 * end to end with a stubbed `aapt2` and fixture APKs, so the exit status is
 * observed directly instead of inferred.
 *
 * Regression pinned below: `trap ... EXIT` capturing a `local` variable. The trap
 * runs after the function scope is gone, and under `set -u` it aborted with
 * "workdir: unbound variable" *after* printing PASS, turning success into exit 1.
 */
const script = resolve(import.meta.dirname, "../../android/scripts/apk-network-policy.sh");

const DEBUG_CONFIG = `E: network-security-config (line=9)
  E: base-config (line=10)
    A: cleartextTrafficPermitted=(type 0x12)0x0
  E: domain-config (line=11)
    A: cleartextTrafficPermitted=(type 0x12)0xffffffff
    E: domain (line=12)
      A: includeSubdomains=(type 0x12)0x0
      T: 'localhost'
`;

const RELEASE_CONFIG = `E: network-security-config (line=9)
  E: base-config (line=10)
    A: cleartextTrafficPermitted=(type 0x12)0x0
`;

const MANIFEST = `E: manifest (line=2)
  A: android:networkSecurityConfig(0x01010527)=@0x7f0e0000
`;

/**
 * Fake APK: a zip whose entry list is what the script enumerates. Contents are
 * irrelevant because the stubbed aapt2 answers from the config file below.
 */
function makeApk(dir: string, name = "fixture.apk"): string {
  const path = join(dir, name);
  const zip = spawnSync(
    "python3",
    [
      "-c",
      [
        "import zipfile,sys",
        "z=zipfile.ZipFile(sys.argv[1],'w')",
        "z.writestr('AndroidManifest.xml','<manifest/>')",
        "z.writestr('res/abc.xml','<x/>')",
        "z.close()",
      ].join(";"),
      path,
    ],
    { encoding: "utf8" },
  );
  if (zip.status !== 0) throw new Error(`could not build fixture APK: ${zip.stderr}`);
  return path;
}

/**
 * Stubbed aapt2. `supportsVersion` controls whether the `version` subcommand
 * works, which is how the diagnostic probe's (ir)relevance to the exit code is
 * verified.
 */
function makeAapt2(dir: string, config: string, options: { supportsVersion?: boolean } = {}): string {
  const path = join(dir, "aapt2");
  const configPath = join(dir, "config-dump.txt");
  writeFileSync(configPath, config);

  const body = `#!/usr/bin/env bash
file=""
subcommand="\${1:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --file) file="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ "$subcommand" = "version" ]; then
  ${
    options.supportsVersion === false
      ? 'echo "stub: version not implemented" >&2; exit 1'
      : 'echo "Android Asset Packaging Tool (aapt) 2:35.0.0"; exit 0'
  }
fi
if [ "$subcommand" != "dump" ]; then
  echo "stub: unsupported subcommand" >&2; exit 1
fi
case "$file" in
  AndroidManifest.xml) printf '%s' ${JSON.stringify(MANIFEST)} ;;
  res/abc.xml) cat ${JSON.stringify(configPath)} ;;
  *) exit 1 ;;
esac
`;
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

interface Observation {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly report: string | null;
}

function runInspect(params: {
  variant: "debug" | "release";
  apk: string;
  aapt2?: string;
}): Observation {
  const dir = mkdtempSync(join(tmpdir(), "apk-exit-"));
  try {
    const reportPath = join(dir, "report.txt");
    const result = spawnSync(
      "bash",
      [script, "inspect", params.apk, params.variant],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...(params.aapt2 ? { AAPT2: params.aapt2 } : { AAPT2: join(dir, "missing-aapt2") }),
          DIAGNOSTIC_OUTPUT: reportPath,
        },
        cwd: dir,
      },
    );

    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      report: existsSync(reportPath) ? readFileSync(reportPath, "utf8") : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("APK verifier exit codes", () => {
  it("exits 0 for a valid debug APK", () => {
    const dir = mkdtempSync(join(tmpdir(), "apk-fx-"));
    try {
      const observation = runInspect({
        variant: "debug",
        apk: makeApk(dir),
        aapt2: makeAapt2(dir, DEBUG_CONFIG),
      });
      expect(observation.stdout).toContain("PASS: debug APK network policy is correct");
      expect(observation.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 0 for a valid release APK", () => {
    const dir = mkdtempSync(join(tmpdir(), "apk-fx-"));
    try {
      const observation = runInspect({
        variant: "release",
        apk: makeApk(dir),
        aapt2: makeAapt2(dir, RELEASE_CONFIG),
      });
      expect(observation.stdout).toContain("PASS: release APK network policy is correct");
      expect(observation.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let a failing diagnostic probe turn PASS into exit 1", () => {
    // The regression: `aapt2 version` failing inside the report note, and the EXIT
    // trap reading a variable that no longer exists, both used to abort after the
    // verdict was printed.
    const dir = mkdtempSync(join(tmpdir(), "apk-fx-"));
    try {
      const observation = runInspect({
        variant: "debug",
        apk: makeApk(dir),
        aapt2: makeAapt2(dir, DEBUG_CONFIG, { supportsVersion: false }),
      });
      expect(observation.stdout).toContain("PASS: debug APK network policy is correct");
      expect(observation.stderr).not.toContain("unbound variable");
      expect(observation.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 for a debug APK without a local cleartext exception", () => {
    const dir = mkdtempSync(join(tmpdir(), "apk-fx-"));
    try {
      const observation = runInspect({
        variant: "debug",
        apk: makeApk(dir),
        aapt2: makeAapt2(dir, RELEASE_CONFIG),
      });
      expect(observation.status).toBe(1);
      expect(observation.report).toContain("verdict: FAIL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 for a release APK carrying the debug policy", () => {
    const dir = mkdtempSync(join(tmpdir(), "apk-fx-"));
    try {
      const observation = runInspect({
        variant: "release",
        apk: makeApk(dir),
        aapt2: makeAapt2(dir, DEBUG_CONFIG),
      });
      expect(observation.status).toBe(1);
      expect(observation.report).toContain("debug policy leaked into release");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 when the APK is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "apk-fx-"));
    try {
      const observation = runInspect({
        variant: "debug",
        apk: join(dir, "nao-existe.apk"),
        aapt2: makeAapt2(dir, DEBUG_CONFIG),
      });
      expect(observation.status).toBe(1);
      expect(observation.report).toContain("APK not found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 when aapt2 is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "apk-fx-"));
    try {
      const observation = runInspect({
        variant: "debug",
        apk: makeApk(dir),
        // Point AAPT2 at a non-existent file so find_aapt2 cannot fall back.
        aapt2: join(dir, "aapt2-inexistente"),
      });
      // find_aapt2 trusts AAPT2 when set, so the failure surfaces at dump time.
      expect(observation.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 when aapt2 fails while dumping the manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "apk-fx-"));
    try {
      const brokenAapt2 = join(dir, "aapt2-broken");
      writeFileSync(brokenAapt2, '#!/usr/bin/env bash\nexit 3\n');
      chmodSync(brokenAapt2, 0o755);

      const observation = runInspect({
        variant: "debug",
        apk: makeApk(dir),
        aapt2: brokenAapt2,
      });
      expect(observation.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shell prerequisites", () => {
  it("runs under set -euo pipefail", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain("set -euo pipefail");
  });

  it("keeps the temporary directory reachable from the EXIT trap", () => {
    // Guards the exact regression: a `local workdir` would be out of scope when the
    // trap runs, and `set -u` would then fail the script after a successful verdict.
    const source = readFileSync(script, "utf8");
    expect(source).not.toMatch(/^\s*local\s+workdir\s*$/m);
    expect(source).toContain('trap \'rm -rf "${workdir:-}"\' EXIT');
  });
});
