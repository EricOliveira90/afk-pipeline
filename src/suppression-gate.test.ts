/**
 * The `suppressions` gate, as a unit against real git trees. No pipeline is
 * spawned: the gate's whole verdict is a comparison of two trees' bytes, so a
 * fixture repo with two commits exercises every branch it has (`CLAUDE.md`,
 * "Where a new assertion goes").
 *
 * The pragmas below are spelled with a runtime `PRAGMA` prefix rather than
 * written literally, so this file does not itself carry the suppressions it is
 * about.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_SUPPRESSION_DETECTORS,
  GATE_RISK_CLASSES,
  type GatePolicySuppressionDetector,
} from "./gate-policy.js";
import {
  runSuppressionGate,
  suppressionGateDeclaration,
  SUPPRESSION_GATE_ID,
  SUPPRESSION_GATE_STAGE,
} from "./suppression-gate.js";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Built at runtime so this test file carries no suppression of its own. */
const TS_IGNORE = `@${"ts"}-ignore`;
const TS_EXPECT_ERROR = `@${"ts"}-expect-error`;
const ESLINT_DISABLE = `${"eslint"}-disable-next-line no-console`;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function write(repo: string, path: string, contents: string): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf-8");
}

function commitAll(repo: string, message: string): string {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD^{tree}"]).trim();
}

/** A repo whose input tree already carries one pre-existing `@ts-ignore`. */
function makeRepo(): { repo: string; inputTree: string } {
  const repo = mkdtempSync(join(tmpdir(), "afk-suppression-gate-"));
  tempDirs.push(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "afk@example.com"]);
  git(repo, ["config", "user.name", "AFK"]);
  write(
    repo,
    "src/thing.ts",
    [`// ${TS_IGNORE} legacy, predates this slice`, "export const thing = 1;", ""].join(
      "\n",
    ),
  );
  write(repo, "docs/notes.md", `A note mentioning ${TS_EXPECT_ERROR}.\n`);
  const inputTree = commitAll(repo, "base");
  return { repo, inputTree };
}

function runOn(
  repo: string,
  inputTree: string,
  outputTree: string,
  detectors: readonly GatePolicySuppressionDetector[] = DEFAULT_SUPPRESSION_DETECTORS,
) {
  return runSuppressionGate({
    cwd: repo,
    inputCheckpointTree: inputTree,
    outputCheckpointTree: outputTree,
    detectors,
  });
}

describe("[behavior:#87:B-10] the suppressions gate", () => {
  it("[behavior:#87:B-10] declares itself as a required in-process deterministic gate", () => {
    const declaration = suppressionGateDeclaration({
      cwd: ".",
      inputCheckpointTree: "a",
      outputCheckpointTree: "b",
      detectors: DEFAULT_SUPPRESSION_DETECTORS,
    });
    expect(declaration.id).toBe("suppressions");
    expect(SUPPRESSION_GATE_ID).toBe("suppressions");
    expect(declaration.stage).toBe(SUPPRESSION_GATE_STAGE);
    expect(SUPPRESSION_GATE_STAGE).toBe("deterministic");
    expect(declaration.required).toBe(true);
    expect(declaration.command).toBeUndefined();
    expect(typeof declaration.run).toBe("function");
  });

  it("[behavior:#87:B-10] passes a tree that changed nothing a detector covers", () => {
    const { repo, inputTree } = makeRepo();
    write(repo, "docs/notes.md", "A rewritten note.\n");
    const outputTree = commitAll(repo, "docs only");

    const outcome = runOn(repo, inputTree, outputTree);
    expect(outcome.status).toBe("PASS");
    expect(outcome.findings).toBeUndefined();
  });

  it("[behavior:#87:B-10] passes a pre-existing suppression: only an increase fails", () => {
    const { repo, inputTree } = makeRepo();
    write(
      repo,
      "src/thing.ts",
      [
        `// ${TS_IGNORE} legacy, predates this slice`,
        "export const thing = 2;",
        "",
      ].join("\n"),
    );
    const outputTree = commitAll(repo, "edit beside the legacy pragma");

    const outcome = runOn(repo, inputTree, outputTree);
    expect(outcome.status).toBe("PASS");
    expect(outcome.detail).toContain("No detector counts more suppressions");
  });

  it("[behavior:#87:B-10] passes a tree that removed a suppression", () => {
    const { repo, inputTree } = makeRepo();
    write(repo, "src/thing.ts", "export const thing = 3;\n");
    const outputTree = commitAll(repo, "remove the pragma");

    expect(runOn(repo, inputTree, outputTree).status).toBe("PASS");
  });

  it("[behavior:#87:B-10] fails an added suppression and names the exact path, line and detector", () => {
    const { repo, inputTree } = makeRepo();
    write(
      repo,
      "src/thing.ts",
      [
        `// ${TS_IGNORE} legacy, predates this slice`,
        "export const thing = 1;",
        `// ${TS_EXPECT_ERROR} silenced instead of fixed`,
        "export const other = wrong();",
        "",
      ].join("\n"),
    );
    const outputTree = commitAll(repo, "silence it");

    const outcome = runOn(repo, inputTree, outputTree);
    expect(outcome.status).toBe("FAIL");
    expect(outcome.failureKind).toBe("COMMAND");
    expect(outcome.findings?.suppressions).toEqual([
      { path: "src/thing.ts", line: 3, detectorId: "ts-eslint" },
    ]);
    expect(outcome.detail).toContain("src/thing.ts:3 (ts-eslint)");
    expect(outcome.detail).toContain("Remove the pragma");
  });

  it("[behavior:#87:B-10] counts an added file's suppressions, which have no input-side counterpart", () => {
    const { repo, inputTree } = makeRepo();
    write(
      repo,
      "src/added.ts",
      ["export function log(): void {", `  // ${ESLINT_DISABLE}`, "  console.log(1);", "}", ""].join(
        "\n",
      ),
    );
    const outputTree = commitAll(repo, "add a file with a pragma");

    const outcome = runOn(repo, inputTree, outputTree);
    expect(outcome.status).toBe("FAIL");
    expect(outcome.findings?.suppressions).toEqual([
      { path: "src/added.ts", line: 2, detectorId: "ts-eslint" },
    ]);
  });

  it("[behavior:#87:B-10] a changed file no glob covers is not a failure", () => {
    const { repo, inputTree } = makeRepo();
    write(repo, "docs/notes.md", `Now with ${TS_IGNORE} in prose.\n`);
    const outputTree = commitAll(repo, "prose pragma");

    const outcome = runOn(repo, inputTree, outputTree);
    expect(outcome.status).toBe("PASS");
    // Unlike `tests:skipped`, an uncovered path is not a fail-closed condition:
    // a markdown file cannot hold a pragma the toolchain honours.
    expect(outcome.failureKind).toBeNull();
  });

  it("[behavior:#87:B-10] refuses a policy that declares no detector rather than reporting clean", () => {
    const { repo, inputTree } = makeRepo();
    const outcome = runOn(repo, inputTree, inputTree, []);
    expect(outcome.status).toBe("FAIL");
    expect(outcome.failureKind).toBe("CONFIGURATION");
    expect(outcome.detail).toContain("No suppression detector is declared");
  });

  it("[behavior:#87:B-10] honours a project's own detector over the shipped default", () => {
    const { repo, inputTree } = makeRepo();
    write(repo, "src/thing.ts", ["export const thing = 1; // NOSONAR", ""].join("\n"));
    const outputTree = commitAll(repo, "project-specific pragma");

    expect(runOn(repo, inputTree, outputTree).status).toBe("PASS");
    const outcome = runOn(repo, inputTree, outputTree, [
      { id: "sonar", globs: ["src/**"], patterns: ["NOSONAR"] },
    ]);
    expect(outcome.status).toBe("FAIL");
    expect(outcome.findings?.suppressions).toEqual([
      { path: "src/thing.ts", line: 1, detectorId: "sonar" },
    ]);
  });

  it("[behavior:#87:B-10] runs whenever the stage runs, never consulting gatePolicy.riskClasses", () => {
    // `"suppression"` is waiver vocabulary: it names what an operator may waive
    // *after* the gate has reported, not a switch that decides whether it runs.
    // A gate that could be turned off by omitting its risk class from the
    // policy is a gate a run can silence by editing one config line — which is
    // exactly the move this gate exists to catch.
    expect(GATE_RISK_CLASSES).toContain("suppression");
    const source = readFileSync(
      new URL("./suppression-gate.ts", import.meta.url),
      "utf-8",
    );
    expect(source).not.toContain("riskClasses");

    // And the input carries no policy at all, so there is nothing to consult:
    // the same two trees give the same verdict under any risk-class list.
    const { repo, inputTree } = makeRepo();
    write(
      repo,
      "src/thing.ts",
      [
        `// ${TS_IGNORE} legacy, predates this slice`,
        `// ${TS_IGNORE} added by this round`,
        "export const thing = 1;",
        "",
      ].join("\n"),
    );
    const outputTree = commitAll(repo, "one more pragma");
    expect(runOn(repo, inputTree, outputTree).status).toBe("FAIL");
  });
});
