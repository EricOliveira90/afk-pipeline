/**
 * Shared fixtures for the resume integration suites.
 *
 * The resume tests live in two files — `resume-integration.test.ts`
 * (the two-run retry scenarios, spec #33) and `resume-worktree.test.ts`
 * (`prepareSliceWorktree`) — so one `vitest run` schedules them across
 * both workers (`maxWorkers: 2`); a single file always ran on one. This
 * module is the top-level helper section both halves used to share. Not
 * a test file itself: the `.fixtures.ts` suffix keeps it out of the
 * `src/**\/*.test.ts` include.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  saveContractFindingLineage,
  type ContractFindingLineage,
} from "./contract-convergence.js";
import { recordExactStageCheckpoint } from "./exact-stage-resume.js";
import { runScopeFingerprint } from "./preserve-work-recovery.js";
import { RECOVERY_FINGERPRINT_ABSENT } from "./run-state.js";
import type { PersistedRunScope } from "./slice-scope.js";
import { validExplorerContext } from "./explorer-test-fixtures.js";
import type { Slice } from "./issues-parser.js";
import { writeContractReview, writeQAReview } from "./test-support.js";
import type { AgentProvider, InvokeOptions, InvokeResult } from "./agent-provider.js";

const tempDirs: string[] = [];

/**
 * Removes every test-lifetime repo `makeRepo` created since the last
 * call. Each test file registers this in its own `afterEach` — a hook
 * registered here at module scope would depend on vitest's per-file
 * module isolation, which is one refactor away from silently not
 * running.
 */
export function cleanupResumeTempDirs(): void {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/**
 * A throwaway git repo. By default the per-test `afterEach` removes it;
 * pass `{ lifetime: "describe" }` when a block spawns its runs once in
 * `beforeAll` and splits the assertions across `it` cases — those cases
 * still need the repo on disk, so the caller owns cleanup in `afterAll`.
 */
export function makeRepo(opts: { lifetime?: "test" | "describe" } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-resume-int-"));
  if (opts.lifetime !== "describe") tempDirs.push(dir);
  git(dir, ["init", "--initial-branch=main"]);
  writeFileSync(join(dir, "README.md"), "test\n", "utf-8");
  // A behavior's gate IDs must name a baseline gate backed by a
  // discovered command, so the fixture repo needs the one sanity script
  // the derived catalog reads (`resolveSanityPlan`). Without it no
  // manifest could bind, and every negotiation here would refuse (#76).
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "resume-fixture",
      private: true,
      scripts: { "test:run": "node -e \"process.exit(0)\"" },
    }),
    "utf-8",
  );
  git(dir, ["add", "README.md", "package.json"]);
  git(dir, ["commit", "-m", "root"]);
  return dir;
}

export function writePrdFixture(repoDir: string, slug: string): { prdDir: string; specsDir: string } {
  const specsDir = join(".kiro", "specs", slug);
  const prdDir = join(repoDir, specsDir);
  mkdirSync(prdDir, { recursive: true });
  writeFileSync(
    join(prdDir, "prd.md"),
    `# ${slug}\n\n## Relevant Files\n- README.md — root readme\n`,
    "utf-8",
  );
  return { prdDir, specsDir };
}

export function makeSlice(): Slice {
  return {
    number: "01",
    ghIssue: "4001",
    title: "Resumable",
    type: "AFK",
    blockedBy: [],
    userStories: "",
  };
}

/** Locate the slice artifact dir inside a worktree (same walk as orchestrator tests). */
export function findSliceArtifactDir(cwd: string, sliceNumber: string): string | null {
  const specsRoot = join(cwd, ".kiro", "specs");
  if (!existsSync(specsRoot)) return null;
  for (const slug of readdirSync(specsRoot)) {
    const slicesDir = join(specsRoot, slug, "slices");
    if (!existsSync(slicesDir)) continue;
    for (const entry of readdirSync(slicesDir)) {
      if (entry.startsWith(`${sliceNumber}-`)) return join(slicesDir, entry);
    }
  }
  return null;
}

/**
 * Slice number the invocation's worktree belongs to — worktrees live at
 * `.afk/worktrees/<prefix>-<slug>-s<NN>` (see `sliceWorktreeDir`). Empty
 * for the post-merge review worktree, which belongs to no slice.
 */
export function sliceNumberFromCwd(cwd: string): string {
  return /-s(\d+)$/.exec(cwd.replace(/\\/g, "/"))?.[1] ?? "";
}

export interface PromptRecord {
  role: string;
  /** Slice the invocation ran for, so merged multi-slice runs stay assertable. */
  sliceNumber: string;
  prompt: string;
  /** Whether run 1's uncommitted casualty file was visible at invocation time. */
  dirtyFilePresent: boolean;
  /** Whether the sibling commit that advanced the feature branch was visible. */
  featureFilePresent: boolean;
  /** Whether BOTH colliding migration files (slice's + feature's) were visible. */
  migrationCollisionPresent: boolean;
  /** Whether the previous run's UNCOMMITTED in-flight edit survived (#49). */
  inFlightPresent: boolean;
  /** Whether the preserved stuck.md diagnosis survived into this run (#49). */
  stuckFilePresent: boolean;
  /** Slice artifact directory observed by this invocation. */
  sliceArtifactDir: string;
  /** Exact diagnosis bytes before this invocation could change them. */
  stuckContentsAtInvocation: string;
}

/**
 * Stub provider. Explorer/planner/evaluator behave like the standard
 * fixture stub; the generator behavior is injected per run.
 */
export function buildProvider(opts: {
  generator: (
    cwd: string,
    options: InvokeOptions,
    sliceNumber: string,
  ) => Promise<void> | void;
  records?: PromptRecord[];
  /**
   * Paths this run's generator writes beyond `src/work-<NN>.ts`, declared in
   * the slice's acceptance manifest so the post-QA file-scope gate (#195)
   * stays green on a scenario that is not about scope. Per-slice by design:
   * a shared path declared for every slice would collapse the fixture's
   * disjoint lanes.
   */
  extraScopePaths?: (sliceNumber: string) => string[];
  /** Deterministic QA verdict for every evaluator-qa invocation. */
  qaVerdict?: "PASS" | "FAIL";
  /** Explicit lifecycle disposition for the fixture's deterministic finding. */
  qaFindingState?: "OPEN" | "RESOLVED";
  /** Per-slice override for deterministic QA lifecycle fixtures. */
  qaResult?: (sliceNumber: string) => {
    verdict: "PASS" | "FAIL";
    findingState?: "OPEN" | "RESOLVED";
    additionalFindingState?: "OPEN" | "RESOLVED";
    error?: string;
  } | undefined;
}): AgentProvider {
  return {
    name: "stub",
    async invoke(options: InvokeOptions): Promise<InvokeResult> {
      const { role, cwd } = options;
      const sliceNumber = sliceNumberFromCwd(cwd);
      const artifactDir = findSliceArtifactDir(cwd, sliceNumber);
      const stuckPath =
        artifactDir === null ? null : join(artifactDir, "stuck.md");
      opts.records?.push({
        role,
        sliceNumber,
        prompt: options.prompt,
        dirtyFilePresent: existsSync(join(cwd, "src", "half-written.ts")),
        featureFilePresent: existsSync(join(cwd, "src", "sibling.ts")),
        migrationCollisionPresent:
          existsSync(join(cwd, "supabase", "migrations", "125_slice_work.sql")) &&
          existsSync(join(cwd, "supabase", "migrations", "125_sibling.sql")),
        inFlightPresent: existsSync(join(cwd, "src", "in-flight.ts")),
        stuckFilePresent: stuckPath !== null && existsSync(stuckPath),
        sliceArtifactDir: artifactDir ?? "",
        stuckContentsAtInvocation:
          stuckPath !== null && existsSync(stuckPath)
            ? readFileSync(stuckPath, "utf-8")
            : "",
      });
      if (role === "explorer" && artifactDir) {
        writeFileSync(
          join(artifactDir, "context.md"),
          validExplorerContext(`Resume context for ${sliceNumber}`),
          "utf-8",
        );
      } else if (role === "planner" && artifactDir) {
        writeFileSync(
          join(artifactDir, "contract.md"),
          // Per-slice declared file, so a merged multi-slice run gets
          // disjoint lanes and its slices really do overlap.
          `# Slice Contract\n\n**Status:** LOCKED\n\n## Files expected to change\n- src/work-${sliceNumber}.ts\n`,
          "utf-8",
        );
        writeFileSync(
          join(artifactDir, "acceptance-manifest.json"),
          JSON.stringify({
            version: 2,
            fileScope: {
              kind: "paths",
              paths: [
                `src/work-${sliceNumber}.ts`,
                ...(opts.extraScopePaths?.(sliceNumber) ?? []),
              ],
            },
            migrationCount: 0,
            behaviors: [
              {
                id: "B-01",
                source: "resume fixture",
                given: "a resumable slice",
                when: "its contract is negotiated",
                then: "the behavior lock passes",
                observableResult: "the slice reaches its own assertions",
                preservation: false,
                gateIds: ["tests"],
              },
            ],
          }),
          "utf-8",
        );
      } else if (role === "evaluator-contract" && artifactDir) {
        writeFileSync(
          join(artifactDir, "feedback-r1.md"),
          "## Evaluator feedback — round 1\n\nThe contract is testable.\n",
          "utf-8",
        );
        writeContractReview(artifactDir, "ACCEPT");
      } else if (role === "generator") {
        await opts.generator(cwd, options, sliceNumber);
      } else if (role === "evaluator-qa" && artifactDir) {
        const qaResult = opts.qaResult?.(sliceNumber) ?? {
          verdict: opts.qaVerdict ?? "PASS",
          findingState: opts.qaFindingState,
        };
        writeFileSync(
          join(artifactDir, "qa-report.md"),
          `# QA Report\n\n**Verdict:** ${qaResult.verdict}\n`,
          "utf-8",
        );
        const findings = [
          ...(qaResult.findingState
            ? [
                {
                  id: "QA-01",
                  severity: "BLOCKING" as const,
                  behaviorIds: [],
                  summary: "Fixture implementation finding",
                  evidence:
                    "The fixture evaluator observed a failing behavior",
                  expected: "The behavior passes",
                  observed: "The behavior fails",
                  clearCondition:
                    "The fixture evaluator observes the behavior passing",
                  state: qaResult.findingState,
                },
              ]
            : []),
          ...(qaResult.additionalFindingState
            ? [
                {
                  id: "QA-02",
                  severity: "BLOCKING" as const,
                  behaviorIds: [],
                  summary: "Fresh fixture implementation finding",
                  evidence:
                    "The fixture evaluator observed another failing behavior",
                  expected: "The additional behavior passes",
                  observed: "The additional behavior fails",
                  clearCondition:
                    "The fixture evaluator observes the additional behavior passing",
                  state: qaResult.additionalFindingState,
                },
              ]
            : []),
        ];
        writeQAReview(artifactDir, "deterministic", {
          verdict: qaResult.verdict,
          ...(findings.length > 0 ? { findings } : {}),
        });
        if (qaResult.error) throw new Error(qaResult.error);
      }
      return { exitCode: 0, stdout: "", stats: {} };
    },
  };
}

/** Concatenated run.log content across every run directory for the slug. */
export function allRunLogs(repo: string, loggerSlug: string): string {
  const logsRoot = join(repo, ".afk", "logs", loggerSlug);
  if (!existsSync(logsRoot)) return "";
  let out = "";
  for (const entry of readdirSync(logsRoot)) {
    const logPath = join(logsRoot, entry, "run.log");
    if (existsSync(logPath)) out += readFileSync(logPath, "utf-8");
  }
  return out;
}

/**
 * Everything one admitted preserved-work recovery attempt starts from (#332).
 *
 * An extension of this module's negotiation fixture rather than a new one: the
 * repo, the PRD layout and the slice identity are `makeRepo`/`writePrdFixture`/
 * `makeSlice`'s, and what is added is the state a *resumed* run carries — resume
 * counters, a second slice's outcome, migration claims, guardian history — plus
 * the committed `PENDING` lineage event and the two live negotiation controls.
 *
 * Written rather than run: building the fixture spawns no pipeline, because every
 * fact here is reachable by writing it, and the assertion it was built for is
 * "execution changed only two of these" (`AGENTS.md` assertion ladder, #332
 * B-06). #334 hands the same fixture to one real `runPipeline` — the claim there
 * is dispatch *order* at the orchestrator seam, which no written state can show —
 * and that run exits before any agent invocation, so it costs no agent round.
 */
export interface RecoveryExecutionFixture {
  repo: string;
  slug: string;
  /**
   * Run slug — the state file's key. The bare PRD slug by default, which is what
   * a direct call to the recovery API passes; a `runPipeline` caller passes the
   * provider-qualified slug its journal uses instead (ADR 0002).
   */
  runSlug: string;
  /** Absolute PRD directory, as `runPipeline` expects it. */
  prdDir: string;
  /** Repo-relative specs directory, as `runPipeline` expects it. */
  specsDir: string;
  ghIssue: string;
  /** A second in-scope slice, whose checkpoint and lineage must survive. */
  otherGhIssue: string;
  sliceDir: string;
  statePath: string;
  attemptId: string;
  candidateTreeId: string;
  /** Live negotiation files the fixture wrote, keyed by name. */
  negotiationFiles: Record<string, string>;
  /** Artifacts execution must leave byte-identical, keyed by `/`-joined path. */
  preservedArtifacts: Record<string, string>;
}

const RECOVERY_LOCKED_CONTRACT = [
  "# Slice Contract — recovery fixture",
  "",
  "**Status:** LOCKED",
  "",
  "### In scope",
  "",
  "- [behavior:B-01] The fixture behavior, anchored so coverage validates.",
  "",
].join("\n");

const RECOVERY_ACCEPTED_MANIFEST = `${JSON.stringify(
  {
    version: 2,
    fileScope: { kind: "paths", paths: ["src/work-01.ts"] },
    migrationCount: 0,
    behaviors: [
      {
        id: "B-01",
        source: "recovery fixture",
        given: "a preserved worktree",
        when: "its accepted pair is renegotiated",
        then: "the behavior lock passes",
        observableResult: "the slice reaches its own assertions",
        preservation: false,
        gateIds: ["tests"],
      },
    ],
  },
  null,
  2,
)}\n`;

const RECOVERY_NEGOTIATION_BYTES: Record<string, string> = {
  "context.md": "# Explorer context\n\nFACT: the accepted pair predates the discovery.\n",
  "contract-review.json": '{"version":2,"verdict":"ACCEPT","findings":[]}\n',
  "contract-response.json": '{"round":2,"response":"accepted"}\n',
  "contract-negotiation-outcome.json": '{"outcome":"ACCEPTED","rounds":2}\n',
  "planner-escalation.md": "# Planner escalation\n\nNothing was escalated.\n",
  "feedback-r1.md": "## Evaluator feedback — round 1\n",
  "feedback-r2.md": "## Evaluator feedback — round 2\n",
};

const RECOVERY_PRESERVED_ARTIFACTS: Record<string, string> = {
  "reviews/contract-review-r1.json": '{"version":2,"verdict":"REVISE","findings":[]}\n',
  "reviews/qa-review-r1.json": '{"version":2,"verdict":"FAIL"}\n',
  "qa-report.md": "# QA Report\n\n**Verdict:** PASS\n",
  "handoff.md": "## What shipped\n\n- B-01: src/work-01.ts\n",
  "run-summary.md": "# Run summary\n\nThe generator wrote src/work-01.ts.\n",
};

/** A valid non-empty durable contract lineage for one slice. */
function recoveryLineageFixture(id: string): ContractFindingLineage {
  return {
    version: 1,
    extensionUsed: false,
    revision: 1,
    findings: {
      [id]: {
        stableId: id,
        currentId: id,
        disposition: "OPEN",
        firstSeenRevision: 1,
        lastSeenRevision: 1,
        occurrences: 1,
        finding: {
          id,
          severity: "BLOCKING",
          behaviorIds: ["B-01"],
          evidence: `"${id} evidence"`,
          expected: `${id} expected`,
          observed: `${id} observed`,
          clearCondition: `${id} clears`,
          state: "OPEN",
          revisionCitation: null,
        },
      },
    },
  };
}

function writeRecoveryFiles(root: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, ...name.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body, "utf-8");
  }
}

export function makeRecoveryExecutionFixture(
  opts: {
    slug?: string;
    /**
     * Which run-state file to write. Defaults to the bare PRD slug; a
     * `runPipeline` caller passes the provider-qualified journal slug, because
     * that is the only file the pipeline itself reads (#334 B-04).
     */
    runSlug?: string;
  } = {},
): RecoveryExecutionFixture {
  const slug = opts.slug ?? "recovery-execution";
  const runSlug = opts.runSlug ?? slug;
  const repo = makeRepo();
  const { prdDir, specsDir } = writePrdFixture(repo, slug);
  const slice = makeSlice();
  const otherGhIssue = "4002";
  const sliceDir = join(prdDir, "slices", `${slice.number}-resumable`);
  const attemptId = "attempt-fixture";
  const candidateTreeId = "c3".repeat(20);
  const sliceBranch = `afk/${slug}/slice-${slice.number}`;
  const featureBranch = `feat/${slug}`;

  writeRecoveryFiles(sliceDir, {
    "contract.md": RECOVERY_LOCKED_CONTRACT,
    "acceptance-manifest.json": RECOVERY_ACCEPTED_MANIFEST,
    ...RECOVERY_NEGOTIATION_BYTES,
    ...RECOVERY_PRESERVED_ARTIFACTS,
  });
  // The attempt's already-published pair snapshot, in the one immutable
  // directory identity admission gave it.
  const snapshotDir = join(sliceDir, "recovery-snapshots", attemptId);
  writeRecoveryFiles(snapshotDir, {
    "contract.md": RECOVERY_LOCKED_CONTRACT,
    "acceptance-manifest.json": RECOVERY_ACCEPTED_MANIFEST,
  });
  const digest = (text: string): string =>
    createHash("sha256").update(text, "utf-8").digest("hex");

  const statePath = join(repo, ".afk", "state", `${runSlug}.json`);
  mkdirSync(join(repo, ".afk", "state"), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        version: 7,
        prdSlug: runSlug,
        featureBranch,
        specsDir,
        scope: {
          mode: "explicit",
          slices: [
            { number: slice.number, ghIssue: slice.ghIssue },
            { number: "02", ghIssue: otherGhIssue },
          ],
        },
        slices: {
          [slice.ghIssue]: { phase: "STUCK", branch: sliceBranch },
          [otherGhIssue]: {
            phase: "PASS",
            branch: `afk/${slug}/slice-02`,
            mergedToFeature: true,
          },
        },
        resume: {
          [slice.ghIssue]: { attempts: 2, lastDecision: "resumed on the same tree" },
          [otherGhIssue]: { attempts: 0 },
        },
        migrations: {
          pool: ["125", "126"],
          claims: { [slice.ghIssue]: ["125"], [otherGhIssue]: ["126"] },
        },
        reviewPhase: {
          sanity: { treeSha: "d4".repeat(20), ok: true },
          architect: { headSha: "e5".repeat(20), verdict: "ACCEPT-WITH-NOTES" },
          pm: { headSha: "e5".repeat(20), verdict: "SHIP" },
          rounds: [
            {
              round: 1,
              reviewedHeadSha: "e5".repeat(20),
              headSha: "e5".repeat(20),
              architect: {
                source: "INVOKED",
                outcome: "ACCEPT-WITH-NOTES",
                findingsOriginRound: 1,
                findings: [
                  {
                    stableId: "A-01",
                    currentId: "A-01",
                    title: "A guardian note",
                    class: "clarity",
                    clearCondition: "the note is addressed",
                    disposition: "OPEN",
                    reachableTrigger: null,
                    introducedByReviewedDiff: true,
                  },
                ],
              },
              // An INVOKED record's `findingsOriginRound` must be its own round
              // even when it carried no finding (`sanitizeGuardianRecord`), or
              // the whole all-or-nothing ledger reads back as absent.
              pm: {
                source: "INVOKED",
                outcome: "SHIP",
                findingsOriginRound: 1,
                findings: [],
              },
            },
          ],
          filedFindings: [
            {
              guardian: "architect",
              stableId: "A-01",
              fingerprint: "clarity|the note is addressed",
              kind: "NOTE",
              round: 1,
              issue: "https://example.invalid/issues/1",
            },
          ],
        },
        recoveryLineage: {
          [slice.ghIssue]: [
            {
              attemptId,
              state: "PENDING",
              target: { number: slice.number.replace(/^0+/, ""), ghIssue: slice.ghIssue },
              reason: "the accepted pair predates the discovery",
              extensions: [],
              provider: "stub",
              sliceBranch,
              sliceHead: "f6".repeat(20),
              featureHead: "a7".repeat(20),
              scopeFingerprint: "b8".repeat(32),
              snapshotPath: `${specsDir.split("\\").join("/")}/slices/${slice.number}-resumable/recovery-snapshots/${attemptId}`,
              contractFingerprint: digest(RECOVERY_LOCKED_CONTRACT),
              manifestFingerprint: digest(RECOVERY_ACCEPTED_MANIFEST),
              recordedAt: "2026-09-14T00:00:00.000Z",
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  // Seeded through the APIs that own each value, which also normalizes the
  // document written above — so a caller's "before" snapshot is already the
  // loaded-and-rewritten shape and its diff measures execution alone.
  for (const [ghIssue, treeId] of [
    [slice.ghIssue, candidateTreeId],
    [otherGhIssue, "d9".repeat(20)],
  ] as const) {
    recordExactStageCheckpoint(
      { repoRoot: repo, prdSlug: runSlug, ghIssue },
      {
        version: 1,
        completedStage: "deterministic-qa",
        candidateTreeId: treeId,
        nextPendingStage: "post-qa-deterministic",
        round: 1,
      },
    );
  }
  saveContractFindingLineage(
    { repoRoot: repo, runSlug, ghIssue: slice.ghIssue },
    recoveryLineageFixture("F-01"),
  );
  saveContractFindingLineage(
    { repoRoot: repo, runSlug, ghIssue: otherGhIssue },
    recoveryLineageFixture("F-02"),
  );

  return {
    repo,
    slug,
    runSlug,
    prdDir,
    specsDir,
    ghIssue: slice.ghIssue,
    otherGhIssue,
    sliceDir,
    statePath,
    attemptId,
    candidateTreeId,
    negotiationFiles: { ...RECOVERY_NEGOTIATION_BYTES },
    preservedArtifacts: { ...RECOVERY_PRESERVED_ARTIFACTS },
  };
}

/** What a reopened negotiation leaves where a fixture's accepted pair was. */
export const RECOVERY_REOPENED_CONTRACT = [
  "# Slice Contract — reopened for renegotiation",
  "",
  "**Status:** NEGOTIATING",
  "",
].join("\n");

/** The valid LOCKED pair a renegotiation puts in place of the stale one (#335). */
export const RECOVERY_REPLACEMENT_CONTRACT = [
  "# Slice Contract — recovery fixture, renegotiated",
  "",
  "**Status:** LOCKED",
  "",
  "### In scope",
  "",
  "- [behavior:B-01] The fixture behavior, restated after the pair went stale.",
  "",
].join("\n");

/** What a caller needs to say which pair a completion should have recorded. */
export interface RecoveryReplacementPair {
  contract: string;
  manifest: string;
  contractFingerprint: string;
  manifestFingerprint: string;
}

/**
 * Put the fixture where a completion is called from (#335 B-02/B-04).
 *
 * Two edits, both of them the renegotiation's own doing. The replacement pair
 * replaces the stale one in the live artifact directory — the manifest is reused
 * byte-for-byte, so the contract fingerprint alone moves and a completion that
 * recorded the wrong file cannot pass. And the committed `PENDING` event's
 * `scopeFingerprint` is rewritten to the digest of the scope actually persisted
 * here: this fixture records a stand-in value, which the rollback and
 * reconciliation paths never read, but a completion rechecks it under the lock
 * and would refuse a stand-in as lost consensus.
 *
 * The published snapshot is left alone, because the pair it holds is exactly what
 * a rollback would have to put back.
 */
export function writeRecoveryReplacementPair(
  fixture: RecoveryExecutionFixture,
): RecoveryReplacementPair {
  writeRecoveryFiles(fixture.sliceDir, {
    "contract.md": RECOVERY_REPLACEMENT_CONTRACT,
    "acceptance-manifest.json": RECOVERY_ACCEPTED_MANIFEST,
  });
  const document = JSON.parse(readFileSync(fixture.statePath, "utf-8")) as {
    scope: PersistedRunScope;
    recoveryLineage: Record<string, Record<string, unknown>[]>;
  };
  const scopeFingerprint = runScopeFingerprint(document.scope);
  document.recoveryLineage[fixture.ghIssue] = document.recoveryLineage[
    fixture.ghIssue
  ]!.map((event) => ({ ...event, scopeFingerprint }));
  writeFileSync(
    fixture.statePath,
    `${JSON.stringify(document, null, 2)}\n`,
    "utf-8",
  );
  const digest = (text: string): string =>
    createHash("sha256").update(text, "utf-8").digest("hex");
  return {
    contract: RECOVERY_REPLACEMENT_CONTRACT,
    manifest: RECOVERY_ACCEPTED_MANIFEST,
    contractFingerprint: digest(RECOVERY_REPLACEMENT_CONTRACT),
    manifestFingerprint: digest(RECOVERY_ACCEPTED_MANIFEST),
  };
}

/** One unresolved target planted beside the fixture's own, with its expectation. */
export interface PlantedRecoveryTarget {
  ghIssue: string;
  attemptId: string;
  /** Absolute artifact directory a restore writes to, or would have. */
  sliceDir: string;
  /** Absolute snapshot directory the recorded locator resolves to. */
  snapshotDir: string;
  /** The locator as recorded in the lineage event. */
  snapshotPath: string;
  /** The state launch-time reconciliation is expected to append, if any. */
  appends: "ROLLED_BACK" | "ROLLBACK_FAILED" | "none";
}

/**
 * Plant one unresolved target per reported outcome family (#334 B-05).
 *
 * The fixture's own target is included and returned first: its snapshot is intact
 * and its live pair is reopened here, so a launch that reconciles it has
 * something to put back. The other three are written directly into the same PRD
 * layout — a snapshot whose `contract.md` is gone (so the restore cannot verify),
 * the same obstacle behind a trailing `ROLLBACK_FAILED` (so the retry appends
 * nothing), and a two-segment locator that never resolves at all.
 *
 * Each event is cloned from the fixture's own so the persisted shape stays one
 * fact: a field added to the lineage event reaches these targets automatically.
 */
export function plantUnresolvedRecoveryTargets(
  fixture: RecoveryExecutionFixture,
): PlantedRecoveryTarget[] {
  const document = JSON.parse(readFileSync(fixture.statePath, "utf-8")) as {
    recoveryLineage: Record<string, Record<string, unknown>[]>;
  };
  const template = document.recoveryLineage[fixture.ghIssue]![0]!;
  const digest = (text: string): string =>
    createHash("sha256").update(text, "utf-8").digest("hex");
  const specs = fixture.specsDir.split("\\").join("/");
  const planted: PlantedRecoveryTarget[] = [];

  const plant = (opts: {
    ghIssue: string;
    attemptId: string;
    dirName: string;
    locator?: string;
    breakSnapshot?: boolean;
    heldAlready?: boolean;
    appends: PlantedRecoveryTarget["appends"];
  }): void => {
    const sliceDir = join(fixture.prdDir, "slices", opts.dirName);
    const snapshotDir = join(sliceDir, "recovery-snapshots", opts.attemptId);
    writeRecoveryFiles(sliceDir, {
      "contract.md": RECOVERY_REOPENED_CONTRACT,
      "acceptance-manifest.json": '{"version":2,"behaviors":[]}\n',
    });
    writeRecoveryFiles(snapshotDir, {
      "contract.md": RECOVERY_LOCKED_CONTRACT,
      "acceptance-manifest.json": RECOVERY_ACCEPTED_MANIFEST,
    });
    if (opts.breakSnapshot === true) rmSync(join(snapshotDir, "contract.md"));
    const snapshotPath =
      opts.locator ??
      `${specs}/slices/${opts.dirName}/recovery-snapshots/${opts.attemptId}`;
    const pending = {
      ...template,
      attemptId: opts.attemptId,
      state: "PENDING",
      target: { number: opts.dirName.split("-")[0], ghIssue: opts.ghIssue },
      snapshotPath,
    };
    document.recoveryLineage[opts.ghIssue] =
      opts.heldAlready === true
        ? [
            pending,
            {
              ...pending,
              state: "ROLLBACK_FAILED",
              rollbackError: "an earlier launch could not read the snapshot",
              observedContractFingerprint: digest(RECOVERY_REOPENED_CONTRACT),
              observedManifestFingerprint: RECOVERY_FINGERPRINT_ABSENT,
            },
          ]
        : [pending];
    planted.push({
      ghIssue: opts.ghIssue,
      attemptId: opts.attemptId,
      sliceDir,
      snapshotDir,
      snapshotPath,
      appends: opts.appends,
    });
  };

  // The fixture's own target, its live pair reopened so the restore is visible.
  writeRecoveryFiles(fixture.sliceDir, {
    "contract.md": RECOVERY_REOPENED_CONTRACT,
  });
  planted.push({
    ghIssue: fixture.ghIssue,
    attemptId: fixture.attemptId,
    sliceDir: fixture.sliceDir,
    snapshotDir: join(
      fixture.sliceDir,
      "recovery-snapshots",
      fixture.attemptId,
    ),
    snapshotPath: String(template.snapshotPath),
    appends: "ROLLED_BACK",
  });
  plant({
    ghIssue: "5002",
    attemptId: "attempt-unverifiable",
    dirName: "02-unverifiable",
    breakSnapshot: true,
    appends: "ROLLBACK_FAILED",
  });
  plant({
    ghIssue: "5003",
    attemptId: "attempt-held",
    dirName: "03-held",
    breakSnapshot: true,
    heldAlready: true,
    appends: "none",
  });
  plant({
    ghIssue: "5004",
    attemptId: "attempt-unusable",
    dirName: "04-unusable",
    locator: "recovery-snapshots/attempt-unusable",
    appends: "none",
  });

  writeFileSync(
    fixture.statePath,
    `${JSON.stringify(document, null, 2)}\n`,
    "utf-8",
  );
  return planted;
}

/**
 * The run.log lines belonging to one slice. Every per-slice line carries
 * the slice's tag (`[afk] Slice #<id> (<title>)`), so a merged run stays
 * as assertable as a single-slice one.
 */
export function sliceLogLines(repo: string, loggerSlug: string, ghIssue: string): string {
  return allRunLogs(repo, loggerSlug)
    .split(/\r?\n/)
    .filter((line) => line.includes(`Slice #${ghIssue}`))
    .join("\n");
}
