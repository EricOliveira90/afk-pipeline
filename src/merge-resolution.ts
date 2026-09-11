/**
 * One scoped merge-resolution round (#132).
 *
 * A real textual conflict at the wave's merge path used to be terminal:
 * `mergeSliceBranch` aborts the conflicting merge before its caller sees it
 * (`src/git.ts`), so the wave recorded `CONFLICT` with a details string and a
 * human had to finish the job. This module spends exactly one round trying to
 * finish it automatically, inside the same `mergeMutex` acquisition as the
 * refused attempt (ADR 0029: the check and the merge are atomic).
 *
 * The tree the round produces is stated once, because every step below depends
 * on it:
 *
 *   1. The round runs in the slice's **own** worktree on the slice branch. No
 *      disposable worktree, no second checkout of the slice branch.
 *   2. This module merges the **feature-branch tip into the slice branch**
 *      there (`git merge --no-commit`, PRD D3's re-resolved base) and leaves
 *      the conflicted index in place — which is what makes the hunks readable
 *      at all. It therefore never calls `git.mergeSliceBranch`.
 *   3. The generator resolves and **commits the in-progress merge**, so the
 *      resolution commit is a merge commit whose first parent is the pre-round
 *      slice tip and whose second parent is the merged feature tip. That is the
 *      tree the gates prove and the tree the retry ships: because the mutex is
 *      still held, the retried `git.attemptMerge` is a fast-forward of the
 *      feature branch onto this commit, so no third tree exists.
 *   4. A generator that leaves the merge unresolved gets the merge *this
 *      module started* aborted, restoring the slice tip.
 *   5. A resolution merge commit the generator did make is **kept** on the
 *      slice branch on every failure path — ADR 0039, unmerged commits are
 *      never destroyed. A failed round leaves the feature tip unmoved and both
 *      refs alive; it does not promise an unchanged slice tip.
 *   6. Because the retry is a fast-forward, the gate re-run is not the last
 *      thing standing between a bad resolution and the feature branch: a tree
 *      can pass `tests` and `typecheck` while still carrying conflict markers
 *      in a file no gate reads. So the resolution commit's blobs for the paths
 *      that were conflicted are scanned for marker lines *before* the retry,
 *      and any hit refuses it. The scan is a pure function over path/content
 *      pairs and deliberately not a gate declaration: it guards this round's
 *      own retry and belongs to no slice's declared gate set.
 */
import { execFileSync } from "node:child_process";
import {
  runCandidateGatePhase,
  type CandidateGatePhaseResult,
} from "./candidate-gate-phase.js";
import type { GateDeclaration } from "./gate-runner.js";
import { SCOPE_GATE_ID } from "./scope-gate.js";

/**
 * How the round ended. `RESOLVED` is the only verdict that earns a retry;
 * every other one falls back to today's terminal `CONFLICT`.
 */
export type MergeResolutionVerdict =
  /** Gates green, no markers left: the retry may fast-forward this tree. */
  | "RESOLVED"
  /** The re-resolved base merged cleanly here, so there was nothing to resolve. */
  | "NO-CONFLICT"
  /** The generator left no resolution merge commit; the merge was aborted. */
  | "UNRESOLVED"
  /** A required gate on the resolved tree was not `PASS`. */
  | "GATES-RED"
  /** The resolved tree still carries conflict markers (tree model step 6). */
  | "CONFLICT-MARKERS";

export interface MergeResolutionRoundResult {
  verdict: MergeResolutionVerdict;
  /** Wall clock for the whole round, including the generator dispatch. */
  durationMs: number;
  /** Operator-facing one-liner; the wave's `CONFLICT` keeps git's own details. */
  detail: string;
  /** Paths the re-resolved base conflicted on, in git's order. */
  conflictedPaths: readonly string[];
  /** The generator's resolution merge commit, when it made one. */
  resolutionCommit?: string;
  /** `HEAD^{tree}` of that commit — the id the gate re-run proved. */
  treeId?: string;
  /** The gate re-run's evidence, when the round got as far as running it. */
  gateRun?: CandidateGatePhaseResult;
  /** Paths whose resolved blob still carried markers (`CONFLICT-MARKERS`). */
  markerPaths?: readonly string[];
}

/**
 * Everything `runCandidateGatePhase` needs except the tree identity, which is
 * the one thing this round computes rather than receives: the declarations —
 * including `scope` and `acceptance:behaviors` — are built by
 * `src/orchestrator.ts`, which already builds both, and passed in. This module
 * assembles no declaration of its own.
 */
export type MergeResolutionGatePhaseInput = Omit<
  Parameters<typeof runCandidateGatePhase>[0],
  "treeId" | "cwd"
>;

export interface MergeResolutionRoundInput {
  /** The slice's own worktree, on the slice branch (tree model step 1). */
  worktreeDir: string;
  /** The feature-branch tip to merge in — PRD D3's re-resolved base. */
  featureRef: string;
  /** git's own output from the refused first attempt, quoted to the generator. */
  conflictDetails: string;
  /** Bytes the repair envelope leaves the data block (#230). */
  blockBudgetBytes: number;
  /**
   * Hand the bounded data block to the slice's generator. The generator is
   * expected to resolve the in-progress merge and commit it; this module
   * inspects the worktree afterwards rather than trusting a report.
   */
  dispatchGenerator: (block: string) => Promise<void>;
  gatePhase: MergeResolutionGatePhaseInput;
  /** Injected clock, so the recorded duration is assertable. */
  now?: () => number;
  log?: (message: string) => void;
}

/** The level-2 headings of the data block, so tests and prose share a spelling. */
export const MERGE_RESOLUTION_BLOCK_HEADINGS = {
  conflictedPaths: "Conflicted paths",
  hunks: "Conflict hunks",
  siblingDiffs: "Already-merged sibling changes",
} as const;

/**
 * The three marker lines a conflicted file carries, matched at line start.
 *
 * Each carries its trailing space on purpose. git writes `<<<<<<< HEAD` and
 * `>>>>>>> <ref>`, so every genuinely unresolved file hits one of those two;
 * demanding the space on `=======` as well is what keeps a Markdown setext
 * underline from being read as a conflict in a doc no gate opens.
 */
export const CONFLICT_MARKER_PREFIXES = [
  "<<<<<<< ",
  "======= ",
  ">>>>>>> ",
] as const;

/**
 * Pure: which of the given path/content pairs still carry conflict markers.
 *
 * Pure and exported so the refusal that guards the retry is unit-testable
 * without a repository — the round feeds it the resolution commit's blobs.
 */
export function conflictMarkerPaths(
  files: readonly { path: string; content: string }[],
): string[] {
  return files
    .filter(({ content }) =>
      content
        .split("\n")
        .some((line) =>
          CONFLICT_MARKER_PREFIXES.some((marker) => line.startsWith(marker)),
        ),
    )
    .map(({ path }) => path);
}

/** One file's contribution to the data block. */
export interface MergeResolutionEntry {
  path: string;
  /** Unified diff text — a hunk, never a commit history. */
  diff: string;
}

export interface MergeResolutionBlockInput {
  /** The slice's own worktree, named in the drop note so the paths are findable. */
  worktreeDir: string;
  featureRef: string;
  conflictDetails: string;
  hunks: readonly MergeResolutionEntry[];
  siblingDiffs: readonly MergeResolutionEntry[];
  /** Bytes available for the whole block. */
  budgetBytes: number;
}

/**
 * Pure: the bounded data block.
 *
 * Whole files are dropped — never a truncated diff, which would hand the
 * generator a hunk that lies about its own extent — and the drop note names
 * every omitted path and where to read it. Conflict hunks are kept ahead of
 * sibling diffs because a round that loses its hunks has nothing to resolve,
 * while a round that loses a sibling diff has only lost context it can open
 * the file for.
 */
export function boundMergeResolutionBlock(
  input: MergeResolutionBlockInput,
): string {
  const header = [
    `The re-resolved base \`${input.featureRef}\` was merged into your slice ` +
      `branch in your own worktree and left the merge in progress with ` +
      `${input.hunks.length} conflicted path(s). Resolve them, then commit the ` +
      `in-progress merge.`,
    "",
    "git refused the slice's merge with:",
    "",
    "```",
    input.conflictDetails.trim() || "(no details reported)",
    "```",
    "",
    `## ${MERGE_RESOLUTION_BLOCK_HEADINGS.conflictedPaths}`,
    "",
    ...(input.hunks.length === 0
      ? ["(none reported)"]
      : input.hunks.map((entry) => `- \`${entry.path}\``)),
  ].join("\n");

  const sections: Array<{ entry: MergeResolutionEntry; heading: string }> = [
    ...input.hunks.map((entry) => ({
      entry,
      heading: MERGE_RESOLUTION_BLOCK_HEADINGS.hunks,
    })),
    ...input.siblingDiffs.map((entry) => ({
      entry,
      heading: MERGE_RESOLUTION_BLOCK_HEADINGS.siblingDiffs,
    })),
  ];
  // Reserved at its widest — every entry dropped — so the reservation cannot
  // grow as entries are kept and push the result back over budget. Same shape
  // as `boundRepairSituationCommitLog` (#230).
  const reserved = Buffer.byteLength(
    dropNote(
      sections.map(({ entry }) => entry.path),
      input.worktreeDir,
    ),
    "utf-8",
  );
  let used = Buffer.byteLength(header, "utf-8") + reserved;
  const kept: typeof sections = [];
  const dropped: string[] = [];
  for (const section of sections) {
    const rendered = renderEntry(section.heading, section.entry, kept);
    const size = Buffer.byteLength(rendered, "utf-8");
    if (used + size > input.budgetBytes) {
      dropped.push(section.entry.path);
      continue;
    }
    kept.push(section);
    used += size;
  }

  let block = header;
  const rendered: typeof kept = [];
  for (const section of kept) {
    block += renderEntry(section.heading, section.entry, rendered);
    rendered.push(section);
  }
  return dropped.length === 0
    ? block
    : block + dropNote(dropped, input.worktreeDir);
}

/**
 * One entry, with its level-2 heading emitted only the first time that heading
 * is used. Level 2 and never level 1: the block sits inside one level-1
 * section of the repair situation, whose extents are computed from level-1
 * headings alone (`src/context-envelope.ts`).
 */
function renderEntry(
  heading: string,
  entry: MergeResolutionEntry,
  already: readonly { heading: string }[],
): string {
  const opensSection = !already.some((section) => section.heading === heading);
  return (
    (opensSection ? `\n\n## ${heading}` : "") +
    `\n\n### ${entry.path}\n\n\`\`\`diff\n${entry.diff.replace(/\s+$/, "")}\n\`\`\``
  );
}

function dropNote(paths: readonly string[], worktreeDir: string): string {
  return (
    `\n\n(${paths.length} file(s) omitted to fit the inline-size budget: ` +
    `${paths.map((path) => `\`${path}\``).join(", ")}. ` +
    `Read them in your worktree at \`${worktreeDir}\` — this block carries ` +
    `hunks and diffs, never sibling commit history.)`
  );
}

/**
 * Direct git plumbing, following `src/change-summary.ts`'s precedent for a
 * two-ref read that lives outside `src/git.ts`. It has to be direct here:
 * `git.mergeSliceBranch` aborts a conflicting merge before returning, so no
 * helper in that file can leave a conflicted index for this module to read.
 */
function git(args: string[], cwd: string): string {
  return (
    execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    }) as string
  ).trimEnd();
}

function gitOrNull(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/**
 * Resolve a ref to its commit sha in the given worktree.
 *
 * Exported for the caller that has to *prove* the feature tip it names rather
 * than pass a branch label and hope: the scope gate's `featureRef` must be the
 * feature tip this round merges (#132 B-07), and under the held merge mutex
 * that sha is fixed for the whole round.
 */
export function resolveRef(worktreeDir: string, ref: string): string {
  return git(["rev-parse", ref], worktreeDir);
}

/** Paths git left unmerged in the index — the conflict, as git sees it. */
export function conflictedPaths(worktreeDir: string): string[] {
  const out = gitOrNull(["diff", "--name-only", "--diff-filter=U"], worktreeDir);
  if (out === null) return [];
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * One scoped resolution round. Returns a verdict; the caller decides what to
 * do with it. Never throws for a resolution that simply failed — a failed
 * round is data, and its fallback is the terminal `CONFLICT` the merge path
 * would have recorded anyway.
 */
export async function runMergeResolutionRound(
  input: MergeResolutionRoundInput,
): Promise<MergeResolutionRoundResult> {
  const {
    worktreeDir,
    featureRef,
    conflictDetails,
    blockBudgetBytes,
    dispatchGenerator,
    gatePhase,
  } = input;
  const now = input.now ?? (() => Date.now());
  const log = input.log ?? (() => {});
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  requireDeclaredScopeGate(gatePhase.declarations);

  const featureTip = git(["rev-parse", featureRef], worktreeDir);
  const preRoundTip = git(["rev-parse", "HEAD"], worktreeDir);
  const mergeBase = git(["merge-base", "HEAD", featureTip], worktreeDir);

  // `--no-commit` and `--no-ff`: the conflicted index has to survive the call
  // (step 2), and a fast-forward here would move the slice branch without
  // producing the merge commit the retry fast-forwards onto (step 3).
  let conflicted: string[] = [];
  try {
    git(["merge", "--no-commit", "--no-ff", featureTip], worktreeDir);
  } catch {
    conflicted = conflictedPaths(worktreeDir);
  }
  if (conflicted.length === 0) {
    // Nothing to resolve here, so there is nothing for a generator to do. The
    // merge this module started is the only state to undo.
    abortStartedMerge(worktreeDir);
    return {
      verdict: "NO-CONFLICT",
      durationMs: elapsed(),
      conflictedPaths: [],
      detail:
        `Merging ${featureRef} into the slice branch in its own worktree ` +
        `produced no conflicted path, so the refused merge could not be ` +
        `reproduced for resolution.`,
    };
  }

  const block = boundMergeResolutionBlock({
    worktreeDir,
    featureRef,
    conflictDetails,
    hunks: conflicted.map((path) => ({
      path,
      // The conflicted index against the worktree: for an unmerged path this
      // is the combined diff, i.e. the hunks with their markers.
      diff: gitOrNull(["diff", "--", path], worktreeDir) ?? "(unreadable)",
    })),
    siblingDiffs: siblingDiffs(worktreeDir, mergeBase, featureTip, conflicted),
    budgetBytes: blockBudgetBytes,
  });

  log(`merge resolution: ${conflicted.length} conflicted path(s)`);
  await dispatchGenerator(block);

  const resolutionCommit = git(["rev-parse", "HEAD"], worktreeDir);
  const mergeStillOpen =
    gitOrNull(["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktreeDir) !==
    null;
  if (mergeStillOpen || resolutionCommit === preRoundTip) {
    // Step 4: abort the merge *this module* started, restoring the slice tip.
    abortStartedMerge(worktreeDir);
    return {
      verdict: "UNRESOLVED",
      durationMs: elapsed(),
      conflictedPaths: conflicted,
      detail:
        `The resolution round left no resolution commit ` +
        `(${mergeStillOpen ? "the merge is still in progress" : "the slice branch tip did not move"}), ` +
        `so the merge it started was aborted and the slice branch tip restored.`,
    };
  }
  const parents = git(
    ["rev-list", "--parents", "-n", "1", "HEAD"],
    worktreeDir,
  ).split(/\s+/);
  if (parents[1] !== preRoundTip || parents[2] !== featureTip) {
    // A plain commit, or a merge of something else: it is kept (step 5), but it
    // is not the tree this round promised the retry, so no retry is earned.
    return {
      verdict: "UNRESOLVED",
      durationMs: elapsed(),
      conflictedPaths: conflicted,
      resolutionCommit,
      detail:
        `The resolution commit ${resolutionCommit.slice(0, 12)} is not the ` +
        `in-progress merge of ${featureTip.slice(0, 12)} into ` +
        `${preRoundTip.slice(0, 12)}, so it cannot be fast-forwarded onto ` +
        `the feature branch. It is kept on the slice branch (ADR 0039).`,
    };
  }

  // The tree, not the branch label: the id has to name what the fast-forward
  // will ship, and the gate cache is keyed by it.
  const treeId = git(["rev-parse", "HEAD^{tree}"], worktreeDir);
  const gateRun = await runCandidateGatePhase({
    ...gatePhase,
    treeId,
    cwd: worktreeDir,
  });
  const red = gateRun.evidence.results.filter(
    (result) =>
      result.status !== "PASS" &&
      gatePhase.declarations.some(
        (declaration) =>
          declaration.id === result.gateId && declaration.required,
      ),
  );
  if (red.length > 0) {
    return {
      verdict: "GATES-RED",
      durationMs: elapsed(),
      conflictedPaths: conflicted,
      resolutionCommit,
      treeId,
      gateRun,
      detail:
        `The resolved tree ${treeId.slice(0, 12)} left required gate(s) not ` +
        `PASS: ${red.map((result) => `${result.gateId} ${result.status}`).join(", ")}. ` +
        `No merge retry ran; the resolution commit is kept on the slice ` +
        `branch (ADR 0039).`,
    };
  }

  const markerPaths = conflictMarkerPaths(
    conflicted.flatMap((path) => {
      const content = gitOrNull(["show", `HEAD:${path}`], worktreeDir);
      // A path the resolution deleted has no blob and no markers.
      return content === null ? [] : [{ path, content }];
    }),
  );
  if (markerPaths.length > 0) {
    return {
      verdict: "CONFLICT-MARKERS",
      durationMs: elapsed(),
      conflictedPaths: conflicted,
      resolutionCommit,
      treeId,
      gateRun,
      markerPaths,
      detail:
        `The resolved tree still carries conflict markers in ` +
        `${markerPaths.map((path) => `\`${path}\``).join(", ")}, so the merge ` +
        `retry was refused even though every required gate passed. The ` +
        `resolution commit is kept on the slice branch (ADR 0039).`,
    };
  }

  return {
    verdict: "RESOLVED",
    durationMs: elapsed(),
    conflictedPaths: conflicted,
    resolutionCommit,
    treeId,
    gateRun,
    detail:
      `Resolved ${conflicted.length} conflicted path(s) as merge commit ` +
      `${resolutionCommit.slice(0, 12)}; every required gate passed on tree ` +
      `${treeId.slice(0, 12)} and no conflict marker survived.`,
  };
}

/**
 * The declarations must be the slice's own required set. Only the `scope` gate
 * is demanded by name: it is built unconditionally for every slice, while the
 * acceptance gate is absent by design on a manifest that binds no behavior.
 * Refusing loudly beats gating a resolved tree on a set that forgot the
 * comparison a merged sibling's paths need.
 */
function requireDeclaredScopeGate(
  declarations: readonly GateDeclaration[],
): void {
  if (
    !declarations.some(
      (declaration) =>
        declaration.id === SCOPE_GATE_ID && declaration.required,
    )
  ) {
    throw new Error(
      `A merge-resolution gate re-run must carry the slice's required ` +
        `${SCOPE_GATE_ID} declaration; got ` +
        `[${declarations.map((declaration) => declaration.id).join(", ")}]`,
    );
  }
}

/**
 * Diffs of the paths an already-merged sibling changed between the fork point
 * and the feature tip — `merge-base..featureTip`, per file, so the block
 * carries diffs and never a sibling's commit history. The conflicted paths are
 * excluded: their hunks already say everything the diff would.
 */
function siblingDiffs(
  worktreeDir: string,
  mergeBase: string,
  featureTip: string,
  conflicted: readonly string[],
): MergeResolutionEntry[] {
  const names =
    gitOrNull(
      ["diff", "--name-only", `${mergeBase}..${featureTip}`],
      worktreeDir,
    ) ?? "";
  return names
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !conflicted.includes(line))
    .map((path) => ({
      path,
      diff:
        gitOrNull(
          ["diff", `${mergeBase}..${featureTip}`, "--", path],
          worktreeDir,
        ) ?? "(unreadable)",
    }));
}

/**
 * Abort the merge this module started — never a reset. The only state undone
 * is the in-progress merge; a commit the generator made is out of reach of
 * this call by construction (ADR 0039).
 */
function abortStartedMerge(worktreeDir: string): void {
  gitOrNull(["merge", "--abort"], worktreeDir);
}
