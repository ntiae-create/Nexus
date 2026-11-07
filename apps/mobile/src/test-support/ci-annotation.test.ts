import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Annotation contract of the CI verification steps.
 *
 * The workflow used to emit `::error` unconditionally, so a passing run carried a
 * red annotation. These tests execute the actual `run:` script taken from
 * `.github/workflows/android-apk.yml` — not a copy — with a stubbed verifier, and
 * assert both the annotation level and the exit status.
 */
const workflowPath = resolve(import.meta.dirname, "../../../../.github/workflows/android-apk.yml");

/**
 * Minimal extraction of the `run:` block for a named step.
 *
 * A YAML parser is not a repository dependency, and pulling one in just for this
 * test would be a heavier change than the fix itself.
 */
function extractStepScript(stepName: string): string {
  const lines = readFileSync(workflowPath, "utf8").split("\n");
  const startIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (startIndex === -1) throw new Error(`step not found: ${stepName}`);

  const runIndex = lines.findIndex(
    (line, index) => index > startIndex && line.trim().startsWith("run: |"),
  );
  if (runIndex === -1) throw new Error(`no run block for step: ${stepName}`);

  const indent = lines[runIndex + 1]!.search(/\S/);
  const body: string[] = [];
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    if (line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

interface StepResult {
  readonly status: number;
  readonly stdout: string;
  readonly summary: string;
}

function runStep(stepName: string, verifierExitCode: number): StepResult {
  const dir = mkdtempSync(join(tmpdir(), "wf-step-"));
  try {
    // Stub `scripts/apk-network-policy.sh` so the step's own logic is what is under
    // test: it must pass the verifier's verdict through unchanged either way.
    mkdirSync(join(dir, "scripts"), { recursive: true });
    const variant = stepName.includes("debug") ? "debug" : "release";
    const stub = join(dir, "scripts", "apk-network-policy.sh");
    writeFileSync(
      stub,
      [
        "#!/usr/bin/env bash",
        `printf 'verdict: ${verifierExitCode === 0 ? "PASS" : "FAIL"} - ${variant} APK network policy is correct\\n' > apk-policy-${variant}.txt`,
        `printf 'verdict: ${verifierExitCode === 0 ? "PASS" : "FAIL"} - ${variant}\\n'`,
        `exit ${verifierExitCode}`,
        "",
      ].join("\n"),
    );
    chmodSync(stub, 0o755);

    const summaryPath = join(dir, "summary.md");
    writeFileSync(summaryPath, "");

    // The workflow interpolates `${{ steps.apks.outputs.<variant>_apk }}`; substitute
    // it the same way the runner would.
    const script = extractStepScript(stepName).replace(
      /\$\{\{\s*steps\.apks\.outputs\.\w+_apk\s*\}\}/g,
      "/tmp/fixture.apk",
    );

    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      cwd: dir,
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
    });

    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      summary: readFileSync(summaryPath, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const STEPS = ["Verify debug APK network policy", "Verify release APK network policy"] as const;

describe("CI verification step annotations", () => {
  for (const step of STEPS) {
    describe(step, () => {
      it("emits a notice, not an error, when the policy passes", () => {
        const result = runStep(step, 0);
        expect(result.stdout).toContain("::notice");
        expect(result.stdout).not.toContain("::error");
        expect(result.status).toBe(0);
      });

      it("keeps the error annotation and exit 1 when the policy fails", () => {
        const result = runStep(step, 1);
        expect(result.stdout).toContain("::error");
        expect(result.stdout).not.toContain("::notice");
        expect(result.status).toBe(1);
      });

      it("preserves the verifier verdict verbatim in the annotation", () => {
        expect(runStep(step, 0).stdout).toMatch(/::notice [^\n]*verdict: PASS/);
        expect(runStep(step, 1).stdout).toMatch(/::error [^\n]*verdict: FAIL/);
      });

      it("writes the report to the job summary in both cases", () => {
        expect(runStep(step, 0).summary).toContain("network policy");
        expect(runStep(step, 1).summary).toContain("network policy");
      });
    });
  }
});

describe("workflow annotation policy", () => {
  it("emits ::error only from the failure branch", () => {
    // Guard against a regression where reporting is added back unconditionally.
    const script = extractStepScript("Verify debug APK network policy");
    const codeLines = script
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

    const errorLines = codeLines.filter((line) => line.includes("::error"));
    expect(errorLines).toHaveLength(1);

    // The single emitter must come after the notice one, i.e. in the else branch.
    const noticeIndex = codeLines.findIndex((line) => line.includes("::notice"));
    const errorIndex = codeLines.findIndex((line) => line.includes("::error"));
    expect(noticeIndex).toBeGreaterThan(-1);
    expect(errorIndex).toBeGreaterThan(noticeIndex);
  });
});
