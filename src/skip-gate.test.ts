/**
 * The `tests:skipped` gate, as a unit against real git trees. No pipeline is
 * spawned: the gate's whole verdict is a comparison of two trees' bytes, so a
 * fixture repo with one commit and one working-tree edit exercises every branch
 * it has (`CLAUDE.md`, "Where a new assertion goes").
 */
import { describe, it, expect, afterAll } from "vitest";
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
import { fileURLToPath } from "node:url";
import { DEFAULT_SKIP_DETECTORS, DEFAULT_TEST_GLOBS } from "./gate-policy.js";
import {
  runSkipGate,
  skipGateDeclaration,
  SKIP_GATE_ID,
  SKIP_GATE_STAGE,
} from "./skip-gate.js";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function write(repo: string, path: string, contents: string): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf-8");
}

const PASSING_SUITE = [
  'import { describe, it, expect } from "vitest";',
  'describe("thing", () => {',
  '  it("works", () => expect(1).toBe(1));',
  '  it.skip("was already off before this slice", () => {});',
  "});",
  "",
].join("\n");

/** A repo whose base commit already carries one pre-existing `it.skip`. */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "afk-skip-gate-"));
  tempDirs.push(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "afk@example.com"]);
  git(repo, ["config", "user.name", "AFK"]);
  write(repo, "src/thing.ts", "export const thing = 1;\n");
  write(repo, "src/thing.test.ts", PASSING_SUITE);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  return repo;
}

function runOn(repo: string) {
  return runSkipGate({
    worktreeDir: repo,
    featureRef: "main",
    detectors: DEFAULT_SKIP_DETECTORS,
    testFileGlobs: DEFAULT_TEST_GLOBS,
  });
}

describe("tests:skipped gate", () => {
  it("[behavior:B-06] declares itself through the in-process run seam", () => {
    const repo = makeRepo();
    const declaration = skipGateDeclaration({
      worktreeDir: repo,
      featureRef: "main",
      detectors: DEFAULT_SKIP_DETECTORS,
      testFileGlobs: DEFAULT_TEST_GLOBS,
    });
    expect(declaration.id).toBe(SKIP_GATE_ID);
    expect(SKIP_GATE_ID).toBe("tests:skipped");
    expect(declaration.stage).toBe(SKIP_GATE_STAGE);
    expect(declaration.required).toBe(true);
    // A content-derived status cannot come from `classifyExecution`, so this
    // declaration carries `run` and no command at all (D22).
    expect(declaration.command).toBeUndefined();
    expect(declaration.run).toBeTypeOf("function");
    // The declaration closes over its own inputs, so the runner's context is
    // not what decides the verdict.
    expect(declaration.run!({ treeId: "unused", cwd: repo })).toMatchObject({
      status: "PASS",
    });
  });

  it("[behavior:B-06] passes a pre-existing skip and a candidate that adds none", () => {
    const repo = makeRepo();
    expect(runOn(repo)).toMatchObject({ status: "PASS", failureKind: null });

    // An ordinary candidate: new source, a new test, no new skip.
    write(repo, "src/added.ts", "export const added = 2;\n");
    write(
      repo,
      "src/added.test.ts",
      'import { it, expect } from "vitest";\nit("adds", () => expect(2).toBe(2));\n',
    );
    expect(runOn(repo)).toMatchObject({ status: "PASS", failureKind: null });
  });

  it("[behavior:B-06] fails on an increase, naming the detector and the pattern", () => {
    const repo = makeRepo();
    write(
      repo,
      "src/thing.test.ts",
      PASSING_SUITE.replace('it("works"', 'it.skip("works"'),
    );
    const outcome = runOn(repo);
    expect(outcome).toMatchObject({ status: "FAIL", failureKind: "COMMAND" });
    expect(outcome.detail).toContain("vitest-ts");
    expect(outcome.detail).toContain("it\\.skip");
    // The base count is named beside the candidate's, so the operator can see
    // the pre-existing occurrence was not the finding.
    expect(outcome.detail).toContain("1 → 2");
  });

  it("[behavior:B-06] catches a skip smuggled into a brand-new test file", () => {
    const repo = makeRepo();
    write(
      repo,
      "src/added.test.ts",
      'import { describe, it } from "vitest";\ndescribe.only("narrowed", () => {\n  it.todo("later");\n});\n',
    );
    const outcome = runOn(repo);
    expect(outcome.status).toBe("FAIL");
    expect(outcome.detail).toContain("it\\.todo");
    expect(outcome.detail).toContain("describe\\.only");
  });

  it("[behavior:B-06] counts detector text only where it is code, not in a string or a comment", () => {
    const repo = makeRepo();
    // Exactly the shape of this gate's own fixtures and of the parser examples
    // in `src/gate-policy.test.ts`: a test file that must *spell* a skip in
    // order to test one. Counting these made the gate fail the slice that
    // introduced it (QA-01).
    write(
      repo,
      "src/detector.test.ts",
      [
        'import { it, expect } from "vitest";',
        '// A comment about it.skip and describe.only must not count.',
        '/* Nor a block comment naming it.todo. */',
        'const patterns = ["it\\\\.skip", "describe\\\\.only", "it\\\\.todo"];',
        'const sample = `it.skip("x", () => {});`;',
        'it("counts nothing here", () => expect(patterns.length + sample.length).toBeGreaterThan(0));',
        "",
      ].join("\n"),
    );
    expect(runOn(repo)).toMatchObject({ status: "PASS", failureKind: null });

    // The same file with one real call is still caught.
    write(
      repo,
      "src/detector.test.ts",
      [
        'import { it, expect } from "vitest";',
        '// A comment about it.skip must not count.',
        'it.skip("genuinely disabled", () => expect(1).toBe(1));',
        "",
      ].join("\n"),
    );
    const outcome = runOn(repo);
    expect(outcome).toMatchObject({ status: "FAIL", failureKind: "COMMAND" });
    expect(outcome.detail).toContain("it\\.skip");
    expect(outcome.detail).toContain("1 → 2");
  });

  it("[behavior:B-06] keeps its own module a text file Git can diff", () => {
    // A raw control byte in the source makes Git classify the module as binary,
    // and then no diff, review or text merge can read it (QA-02). The composite
    // key's separator is written as an escape instead.
    const source = readFileSync(
      fileURLToPath(new URL("./skip-gate.ts", import.meta.url)),
      "utf-8",
    );
    const control = [...source].filter((char) => {
      const code = char.charCodeAt(0);
      return code < 32 && char !== "\n" && char !== "\r" && char !== "\t";
    });
    expect(control).toEqual([]);
    expect(source).toContain('const KEY_SEPARATOR = "\\u001f"');
  });

  it("[behavior:B-06] fails closed with no detector, and with a declared test file no detector covers", () => {
    const repo = makeRepo();
    // No detector at all: the gate read nothing, so it may not report PASS.
    const undeclared = runSkipGate({
      worktreeDir: repo,
      featureRef: "main",
      detectors: [],
      testFileGlobs: DEFAULT_TEST_GLOBS,
    });
    expect(undeclared).toMatchObject({
      status: "FAIL",
      failureKind: "CONFIGURATION",
    });
    expect(undeclared.detail).toContain("skipDetectors");

    // A project that declares `*.spec.rb` as a test file but ships only the
    // TypeScript detector: this gate cannot speak for that file.
    write(repo, "spec/thing.spec.rb", "describe 'thing'\n");
    const uncovered = runSkipGate({
      worktreeDir: repo,
      featureRef: "main",
      detectors: DEFAULT_SKIP_DETECTORS,
      testFileGlobs: [...DEFAULT_TEST_GLOBS, "**/*.spec.rb"],
    });
    expect(uncovered).toMatchObject({
      status: "FAIL",
      failureKind: "CONFIGURATION",
    });
    expect(uncovered.detail).toContain("spec/thing.spec.rb");

    // The same tree with that file undeclared is a PASS: the oracle is what the
    // project itself calls a test file, not what this gate guesses.
    expect(runOn(repo)).toMatchObject({ status: "PASS" });
  });
});
