/**
 * The `tests:skipped` gate: a candidate may not disable a test to go green.
 *
 * Declared through the in-process `GateDeclaration.run` seam, modelled on
 * `src/scope-gate.ts` (#195), because the verdict is derived from file
 * *content* and `classifyExecution` can only read an exit code (D22). Nothing
 * spawns a test runner here — the comparison is textual, on two trees.
 *
 * Two properties do the work:
 *
 * - **Only an increase fails.** The same detector counts on the base tree and
 *   on the candidate tree, so a skip that was already there is not this slice's
 *   finding. A gate that failed on pre-existing occurrences would fire on every
 *   candidate in a repo that has one legacy `it.skip`, and would be turned off.
 * - **It fails closed.** A file the project itself declares as a test file
 *   (`gatePolicy.protectedPaths.testGlobs`) that no detector's `testGlobs`
 *   cover is a file this gate cannot speak for, so it reports FAIL naming those
 *   files rather than a green verdict about files it never read (D7, plan item
 *   17). A project on another runner declares its own detector.
 *
 * Authorization is a **launch** input, never a candidate one: the waivers this
 * gate honors are the `skipped-test` entries `parseAfkManifest` read out of the
 * PRD directory's `afk.json` (#193, `prd.md` D5). There is one waiver reader
 * and one waiver shape — a second one is exactly the defect that PRD exists to
 * remove — and a waiver a candidate wrote for itself is just a file.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeWaiverPath,
  type ProtectedChangeWaiver,
} from "./afk-manifest.js";
import { matchesGlob, type GatePolicySkipDetector } from "./gate-policy.js";
import type { GateDeclaration, GateRunOutcome } from "./gate-runner.js";

/** The declared gate id, so callers and assertions share one spelling. */
export const SKIP_GATE_ID = "tests:skipped";

/** The stage every content-derived gate reports under (`prd.md` D2-D4). */
export const SKIP_GATE_STAGE = "deterministic";

export interface SkipGateInput {
  /**
   * The live slice worktree, not a checkpoint directory: only it carries the
   * working-tree and untracked changes, and at the post-QA call site the
   * candidate is not committed yet — the same reason the file-scope gate takes
   * this pair (`prd.md` D3).
   */
  worktreeDir: string;
  /** The feature branch the candidate is measured against. */
  featureRef: string;
  /** `gatePolicy.cost.skipDetectors`, resolved by `resolveTestCostPlan`. */
  detectors: readonly GatePolicySkipDetector[];
  /**
   * `gatePolicy.protectedPaths.testGlobs`: the project's own answer to "which
   * files are test files", and therefore the oracle for the fail-closed check.
   */
  testFileGlobs: readonly string[];
  /**
   * The launch manifest's `protectedChangeWaivers` (#193). Only `skipped-test`
   * entries mean anything here, and only by exact path: a waiver names one file
   * a human signed off on, so it is not a glob and it does not travel to a
   * sibling. A declared `fileScope` is not one of these — that is what an agent
   * negotiated, and the whole point of a waiver is that a human wrote it down
   * somewhere no agent may write.
   */
  waivers?: readonly ProtectedChangeWaiver[];
}

function matchesAny(globs: readonly string[], path: string): boolean {
  return globs.some((glob) => matchesGlob(glob, path));
}

/** Tracked plus untracked candidate files, repo-relative with `/` separators. */
function candidateFiles(worktreeDir: string): string[] {
  return gitLines(worktreeDir, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
}

/** Every file on the base ref. */
function baseFiles(worktreeDir: string, featureRef: string): string[] {
  return gitLines(worktreeDir, ["ls-tree", "-r", "--name-only", featureRef]);
}

function gitLines(cwd: string, args: readonly string[]): string[] {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Read many blobs from one ref in a single `git cat-file --batch` process.
 * One process per file would make this gate cost tens of git spawns on every
 * post-QA phase, which is the cost this whole slice exists to reduce.
 */
function readBaseContents(
  worktreeDir: string,
  featureRef: string,
  paths: readonly string[],
): Map<string, string> {
  const contents = new Map<string, string>();
  if (paths.length === 0) return contents;
  const stdout = execFileSync("git", ["cat-file", "--batch"], {
    cwd: worktreeDir,
    input: paths.map((path) => `${featureRef}:${path}`).join("\n") + "\n",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
  let offset = 0;
  for (const path of paths) {
    const newline = stdout.indexOf(0x0a, offset);
    if (newline === -1) break;
    const header = stdout.subarray(offset, newline).toString("utf-8");
    offset = newline + 1;
    const fields = header.split(" ");
    // `<oid> missing` carries no content block; a path absent from the base ref
    // is simply a file with no prior occurrences.
    if (fields.length < 3 || fields[1] !== "blob") continue;
    const size = Number(fields[2]);
    if (!Number.isFinite(size)) break;
    contents.set(path, stdout.subarray(offset, offset + size).toString("utf-8"));
    offset += size + 1;
  }
  return contents;
}

/**
 * Blank out comments and string/template literals, keeping the file's length
 * and line structure so a pattern can still only match code.
 *
 * A detector's text is code — `it.skip(` is a call. The same characters inside
 * a quoted string or a comment are *about* a skip, not a skip: this gate's own
 * fixtures (`src/skip-gate.test.ts`) and the parser examples in
 * `src/gate-policy.test.ts` have to spell `it.skip` to test it, and a raw
 * `content.match` counted those, so the gate failed the very slice that
 * introduced it. Every test file that documents a skip in a comment or asserts
 * on a detector pattern would inherit that false positive.
 *
 * Regular-expression literals are deliberately not tracked: a `/.../` is
 * ambiguous with division without a full parse, and a detector's text inside a
 * regex source is rare enough that a false positive there is the safer error
 * than a scanner that loses the rest of a line.
 */
function stripNonCode(content: string): string {
  let out = "";
  let index = 0;
  const blank = (from: number, to: number): void => {
    // Keep newlines so nothing merges across lines and offsets stay honest.
    out += content.slice(from, to).replace(/[^\r\n]/g, " ");
  };
  while (index < content.length) {
    const char = content[index];
    const next = content[index + 1];
    if (char === "/" && next === "/") {
      const end = content.indexOf("\n", index);
      const stop = end === -1 ? content.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = content.indexOf("*/", index + 2);
      const stop = end === -1 ? content.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      let cursor = index + 1;
      while (cursor < content.length) {
        if (content[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (content[cursor] === char) {
          cursor += 1;
          break;
        }
        // An unterminated single- or double-quoted string ends at the line
        // break, so a lone apostrophe cannot swallow the rest of the file.
        if (char !== "`" && content[cursor] === "\n") break;
        cursor += 1;
      }
      blank(index, cursor);
      index = cursor;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function countPattern(pattern: string, content: string): number {
  return content.match(new RegExp(pattern, "g"))?.length ?? 0;
}

interface DetectorCount {
  detectorId: string;
  pattern: string;
  count: number;
}

/**
 * The composite key's separator, written as an escape rather than as the byte
 * itself: a literal control character in the source makes Git classify this
 * module as binary, and then no diff, review or text merge can read it. U+001F
 * (unit separator) cannot occur in a detector id or a regex source, so the two
 * halves stay distinguishable.
 */
const KEY_SEPARATOR = "\u001f";

function countKey(detectorId: string, pattern: string): string {
  return `${detectorId}${KEY_SEPARATOR}${pattern}`;
}

function countAll(
  detectors: readonly GatePolicySkipDetector[],
  files: readonly string[],
  read: (path: string) => string | undefined,
): DetectorCount[] {
  const counts: DetectorCount[] = [];
  // One strip per file, reused by every pattern: the scan is the expensive part
  // and a detector declares several patterns over the same globs.
  const code = new Map<string, string | undefined>();
  const readCode = (path: string): string | undefined => {
    if (!code.has(path)) {
      const content = read(path);
      code.set(path, content === undefined ? undefined : stripNonCode(content));
    }
    return code.get(path);
  };
  for (const detector of detectors) {
    const matched = files.filter((path) =>
      matchesAny(detector.testGlobs, path),
    );
    for (const pattern of detector.patterns) {
      let total = 0;
      for (const path of matched) {
        const content = readCode(path);
        if (content === undefined) continue;
        total += countPattern(pattern, content);
      }
      counts.push({ detectorId: detector.id, pattern, count: total });
    }
  }
  return counts;
}

/**
 * Run the comparison. Exported for direct unit coverage; the pipeline reaches
 * it through {@link skipGateDeclaration}.
 */
export function runSkipGate(input: SkipGateInput): GateRunOutcome {
  if (input.detectors.length === 0) {
    return {
      status: "FAIL",
      failureKind: "CONFIGURATION",
      detail:
        `No skip detector is declared, so this candidate's test files were ` +
        `never read. Declare gatePolicy.cost.skipDetectors with the patterns ` +
        `your runner uses to disable a test.`,
    };
  }

  /**
   * Exact repo-relative paths a human waived for this risk class. Applied
   * before every scan — the base one included — so a waived file is simply not
   * a file this gate counts. Excluding it from the candidate side alone would
   * turn a *removed* skip in a waived file into a base count the candidate can
   * never match, and the gate would fail on the very file it was told to
   * ignore.
   */
  const waivedPaths = new Set(
    (input.waivers ?? [])
      .filter((waiver) => waiver.riskClass === "skipped-test")
      .map((waiver) => normalizeWaiverPath(waiver.path)),
  );
  const waived = (path: string): boolean =>
    waivedPaths.has(normalizeWaiverPath(path));

  const candidate = candidateFiles(input.worktreeDir).filter(
    (path) => !waived(path),
  );

  // Fail closed before counting: a declared test file no detector covers is a
  // file this gate has no evidence about, and reporting PASS would be a claim
  // it cannot support.
  const uncovered = candidate.filter(
    (path) =>
      matchesAny(input.testFileGlobs, path) &&
      !input.detectors.some((detector) =>
        matchesAny(detector.testGlobs, path),
      ),
  );
  if (uncovered.length > 0) {
    return {
      status: "FAIL",
      failureKind: "CONFIGURATION",
      detail:
        `${uncovered.length} declared test file(s) match no skip detector, so ` +
        `this gate could not tell whether a test was disabled: ` +
        `${uncovered.slice(0, 20).join(", ")}. Declare a detector whose ` +
        `testGlobs cover them in gatePolicy.cost.skipDetectors.`,
    };
  }

  const base = baseFiles(input.worktreeDir, input.featureRef);
  const relevantBase = base.filter(
    (path) =>
      !waived(path) &&
      input.detectors.some((detector) => matchesAny(detector.testGlobs, path)),
  );
  /**
   * The waivers this run actually spent: one whose path exists on neither tree
   * exempted nothing, and recording it would put an authorization in the run
   * summary that changed no verdict.
   */
  const appliedWaivers = (input.waivers ?? []).filter(
    (waiver) =>
      waiver.riskClass === "skipped-test" &&
      (existsSync(join(input.worktreeDir, waiver.path)) ||
        base.some((path) => normalizeWaiverPath(path) === normalizeWaiverPath(waiver.path))),
  );
  const waiverFindings =
    appliedWaivers.length > 0 ? { findings: { appliedWaivers } } : {};
  const waiverDetail =
    appliedWaivers.length > 0
      ? ` ${appliedWaivers.length} path(s) excluded by a launch skipped-test ` +
        `waiver: ${appliedWaivers.map((waiver) => waiver.path).join(", ")}.`
      : "";
  const baseContents = readBaseContents(
    input.worktreeDir,
    input.featureRef,
    relevantBase,
  );

  const readCandidate = (path: string): string | undefined => {
    const absolute = join(input.worktreeDir, path);
    if (!existsSync(absolute)) return undefined;
    try {
      return readFileSync(absolute, "utf-8");
    } catch {
      return undefined;
    }
  };
  const candidateCounts = countAll(input.detectors, candidate, readCandidate);
  const baseCounts = countAll(input.detectors, relevantBase, (path) =>
    baseContents.get(path),
  );
  const baseByKey = new Map(
    baseCounts.map((entry) => [
      countKey(entry.detectorId, entry.pattern),
      entry.count,
    ]),
  );

  const increases = candidateCounts.filter(
    (entry) =>
      entry.count >
      (baseByKey.get(countKey(entry.detectorId, entry.pattern)) ?? 0),
  );
  if (increases.length === 0) {
    return {
      status: "PASS",
      failureKind: null,
      detail:
        `No detector counts more disabled tests on this candidate than on ` +
        `${input.featureRef} (${input.detectors.length} detector(s) over ` +
        `${candidate.length} candidate path(s)).${waiverDetail}`,
      ...waiverFindings,
    };
  }
  // Each increase named exactly, because this text is what the repair round
  // reads out of the gate log.
  return {
    status: "FAIL",
    failureKind: "COMMAND",
    detail:
      `This candidate disables more tests than ${input.featureRef} does: ` +
      `${increases
        .map(
          (entry) =>
            `${entry.detectorId} "${entry.pattern}" ${
              baseByKey.get(countKey(entry.detectorId, entry.pattern)) ?? 0
            } → ${entry.count}`,
        )
        .join("; ")}. Re-enable the test, or fix what it caught.${waiverDetail}`,
    // A waiver that excluded one file is still an applied authorization even
    // when another file failed the gate: the record is of what was spent, not
    // of the verdict.
    ...waiverFindings,
  };
}

/**
 * The declaration. Required and in-process: no toolchain, no working directory,
 * and therefore nothing that can make it skippable — a check on whether the
 * suite was hollowed out must not itself depend on the suite running.
 */
export function skipGateDeclaration(input: SkipGateInput): GateDeclaration {
  return {
    id: SKIP_GATE_ID,
    stage: SKIP_GATE_STAGE,
    required: true,
    // The counting lives inside the closure, so the bytes compared are the
    // bytes on disk at gate time.
    run: () => runSkipGate(input),
  };
}
