/**
 * The admission half of the preserved-work recovery protocol (#277).
 *
 * One real git repository is built once for the whole file and reset before each
 * test, because the only thing admission needs git itself for is resolving two
 * branch tips (`resolveCommit`) — every git-derived *eligibility* outcome comes
 * from the three injected probes P-05 pins, so a per-case `git init` would buy
 * nothing and cost seconds on every run (`AGENTS.md` assertion ladder).
 *
 * The one spawned child in this file is B-08's: the interleave it proves —
 * "the run's scope changed after snapshot publication and before this process
 * held the run-state lock" — exists only between two independent OS processes,
 * which is the documented last-resort case for a spawn.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACCEPTANCE_MANIFEST_FILENAME } from "./acceptance-manifest.js";
import {
  parsePipelineRuntimeOptions,
  parseStaleRenegotiationRequest,
} from "./cli-options.js";
import {
  emptyContractFindingLineage,
  loadContractFindingLineage,
  saveContractFindingLineage,
  type ContractFindingLineage,
} from "./contract-convergence.js";
import {
  inspectExactStageCheckpoint,
  recordExactStageCheckpoint,
  type ExactStageCheckpoint,
} from "./exact-stage-resume.js";
import {
  featureBranchForProviderName,
  sliceWorktreeDirForProviderName,
} from "./run-identity.js";
import * as runStateModule from "./run-state.js";
import {
  RECOVERY_FINGERPRINT_ABSENT,
  RUN_STATE_VERSION,
  appendRecoveryLineageEvent,
  loadRunState,
  recoveryLineageFor,
  type PersistedRecoveryLineageEvent,
  type RecoveryLineageState,
  type RunState,
} from "./run-state.js";
import type { PersistedRunScope } from "./slice-scope.js";
import {
  CONTRACT_FILENAME,
  RECOVERY_NEGOTIATION_DIRNAME,
  RECOVERY_NEGOTIATION_FILENAMES,
  RECOVERY_SNAPSHOT_DIRNAME,
  admitStaleRenegotiation,
  canonicalizeRecoveryRequest,
  describeRecoveryReconciliation,
  encodeRunScopeFingerprintPayload,
  evaluateRecoveryEligibility,
  executeRecoveryAttempt,
  hasOpenRecoveryAttempt,
  isLegalRecoveryTransition,
  listLiveNegotiationFiles,
  listPublishedPairSnapshots,
  publishAcceptedPairSnapshot,
  readLockedAcceptedPair,
  reconcileRecoveryLineage,
  recoveryDispatchRefusal,
  restoreAcceptedPairFromSnapshot,
  rollBackRecoveryAttempt,
  runScopeFingerprint,
  type ExecuteRecoveryAttemptArgs,
  type RecoveryAttemptLocator,
  type RecoveryFailure,
  type RecoveryFailureTrigger,
  type RecoveryGitProbes,
  type RecoveryRefusalCode,
  type RollBackRecoveryAttemptArgs,
} from "./preserve-work-recovery.js";

const PRD_SLUG = "preserved-work-fixture";
const PROVIDER = "claude-code";
const GH_ISSUE = "277";
/** Zero-padded on purpose: `canonicalSliceNumber` must be what resolves it. */
const SLICE_NUMBER = "07";
const CANONICAL_SLICE_NUMBER = "7";
const SLICE_BRANCH = "fixture/slice-07";

const SCOPE: PersistedRunScope = {
  mode: "explicit",
  slices: [
    { number: SLICE_NUMBER, ghIssue: GH_ISSUE },
    { number: "08", ghIssue: "278" },
  ],
};

const LOCKED_CONTRACT = [
  "# Slice 07 — fixture contract",
  "",
  "**Status:** LOCKED",
  "",
  "### In scope",
  "",
  "- [behavior:B-01] The fixture behavior, anchored so coverage validates.",
  "",
].join("\n");

const ACCEPTED_MANIFEST = `${JSON.stringify(
  {
    version: 2,
    fileScope: { kind: "paths", paths: ["src/fixture.ts"] },
    migrationCount: 0,
    behaviors: [
      {
        id: "B-01",
        source: "fixture",
        given: "a fixture",
        when: "it runs",
        then: "it holds",
        observableResult: "a fixture assertion",
        preservation: false,
        gateIds: ["tests"],
      },
    ],
  },
  null,
  2,
)}\n`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

interface Fixture {
  repoRoot: string;
  sliceDir: string;
  worktreeDir: string;
  featureBranch: string;
  statePath: string;
}

let fixture: Fixture;

/** Source text with line endings normalized, so CRLF checkouts assert the same. */
function sourceOf(file: string): string {
  return readFileSync(join("src", file), "utf-8").split("\r\n").join("\n");
}

const MODULE_SOURCE = sourceOf("preserve-work-recovery.ts");

/** The module source with comments stripped, so prose is not mistaken for code. */
const MODULE_CODE = MODULE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /(^|[^:])\/\/.*$/gm,
  "$1",
);

function baselineStateDocument(featureBranch: string): unknown {
  return {
    version: RUN_STATE_VERSION,
    prdSlug: PRD_SLUG,
    featureBranch,
    specsDir: `.kiro/specs/${PRD_SLUG}`,
    scope: SCOPE,
    slices: {
      [GH_ISSUE]: { phase: "STUCK", branch: SLICE_BRANCH },
      "278": { phase: "PASS", branch: "fixture/slice-08", mergedToFeature: true },
    },
  };
}

function writeAcceptedPair(sliceDir: string, contract = LOCKED_CONTRACT): void {
  mkdirSync(sliceDir, { recursive: true });
  writeFileSync(join(sliceDir, CONTRACT_FILENAME), contract);
  writeFileSync(join(sliceDir, ACCEPTANCE_MANIFEST_FILENAME), ACCEPTED_MANIFEST);
}

/** Restore the whole fixture to its eligible baseline, refs excluded. */
function resetFixture(f: Fixture): void {
  rmSync(f.sliceDir, { recursive: true, force: true });
  writeAcceptedPair(f.sliceDir);

  rmSync(f.worktreeDir, { recursive: true, force: true });
  mkdirSync(f.worktreeDir, { recursive: true });
  // A linked worktree always carries a `.git` file; its presence is what the
  // module reads registration off, so the fixture supplies exactly that.
  writeFileSync(join(f.worktreeDir, ".git"), `gitdir: ${f.repoRoot}/.git\n`);

  mkdirSync(join(f.repoRoot, ".afk", "state"), { recursive: true });
  writeFileSync(
    f.statePath,
    `${JSON.stringify(baselineStateDocument(f.featureBranch), null, 2)}\n`,
  );
}

function createFixture(): Fixture {
  const repoRoot = mkdtempSync(join(tmpdir(), "afk-recovery-"));
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.email", "fixture@example.com");
  git(repoRoot, "config", "user.name", "Fixture");
  git(repoRoot, "config", "commit.gpgsign", "false");
  writeFileSync(join(repoRoot, "base.txt"), "base\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-m", "base");

  const featureBranch = featureBranchForProviderName(PRD_SLUG, PROVIDER);
  git(repoRoot, "branch", featureBranch);
  git(repoRoot, "checkout", "-b", SLICE_BRANCH);
  writeFileSync(join(repoRoot, "slice.txt"), "preserved work\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-m", "preserved slice work");
  git(repoRoot, "checkout", "main");

  const f: Fixture = {
    repoRoot,
    sliceDir: join(repoRoot, ".kiro", "specs", PRD_SLUG, "slices", "07-fixture"),
    worktreeDir: sliceWorktreeDirForProviderName(
      repoRoot,
      PRD_SLUG,
      CANONICAL_SLICE_NUMBER,
      PROVIDER,
    ),
    featureBranch,
    statePath: join(repoRoot, ".afk", "state", `${PRD_SLUG}.json`),
  };
  resetFixture(f);
  return f;
}

/** All three probes answering "eligible", with every call recorded. */
function eligibleProbes(
  overrides: Partial<RecoveryGitProbes> = {},
): RecoveryGitProbes & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    hasUncommittedChanges: (cwd) => {
      calls.push(`hasUncommittedChanges:${cwd}`);
      return overrides.hasUncommittedChanges?.(cwd) ?? false;
    },
    countCommitsAhead: (repoRoot, source, target) => {
      calls.push(`countCommitsAhead:${source}:${target}`);
      return overrides.countCommitsAhead?.(repoRoot, source, target) ?? 1;
    },
    isAncestor: (repoRoot, ancestor, descendant) => {
      calls.push(`isAncestor:${ancestor}:${descendant}`);
      return overrides.isAncestor?.(repoRoot, ancestor, descendant) ?? true;
    },
  };
}

function request(selector = SLICE_NUMBER, reason = "the pair went stale") {
  return { selector, reason };
}

function tips(f: Fixture): Record<string, string> {
  return {
    slice: git(f.repoRoot, "rev-parse", SLICE_BRANCH),
    feature: git(f.repoRoot, "rev-parse", f.featureBranch),
  };
}

function stateDocument(f: Fixture): Record<string, unknown> {
  return JSON.parse(readFileSync(f.statePath, "utf-8")) as Record<
    string,
    unknown
  >;
}

function admit(f: Fixture, overrides: Record<string, unknown> = {}) {
  return admitStaleRenegotiation({
    repoRoot: f.repoRoot,
    prdSlug: PRD_SLUG,
    providerName: PROVIDER,
    sliceDir: f.sliceDir,
    request: request(),
    probes: eligibleProbes(),
    ...overrides,
  });
}

beforeAll(() => {
  fixture = createFixture();
}, 120_000);

afterAll(() => {
  if (fixture) rmSync(fixture.repoRoot, { recursive: true, force: true });
});

beforeEach(() => {
  resetFixture(fixture);
});

describe("canonical recovery request identity", () => {
  it("[behavior:#277:B-03] trims the reason and nothing else — code points survive", () => {
    const reason = "\t Contract  MISSED the Ünicode café  \n";

    const result = canonicalizeRecoveryRequest(
      { selector: SLICE_NUMBER, reason },
      SCOPE,
    );

    expect(result.ok).toBe(true);
    const canonical = result.ok ? result.request.reason : "";
    expect(canonical).toBe(reason.trim());
    // Code-point equality, not just string equality: a Unicode normalization
    // pass would still satisfy `toBe` on a composed source while changing what
    // the operator wrote.
    expect([...canonical].map((c) => c.codePointAt(0))).toEqual(
      [...reason.trim()].map((c) => c.codePointAt(0)),
    );
    expect(canonical).toContain("  MISSED the");
  });

  it.each([
    ["a zero-padded slice selector", SLICE_NUMBER],
    ["an unpadded slice selector", CANONICAL_SLICE_NUMBER],
    ["a GitHub-issue selector", GH_ISSUE],
  ])(
    "[behavior:#277:B-03] resolves %s to the canonical {number, ghIssue} pair",
    (_label, selector) => {
      const result = canonicalizeRecoveryRequest(
        { selector, reason: "stale" },
        SCOPE,
      );

      expect(result).toEqual({
        ok: true,
        request: {
          target: { number: CANONICAL_SLICE_NUMBER, ghIssue: GH_ISSUE },
          reason: "stale",
        },
      });
    },
  );

  it.each([
    ["scope-absent", undefined],
    ["scope-absent", { mode: "explicit", slices: [] } as PersistedRunScope],
  ])(
    "[behavior:#277:B-03] refuses with %s when the run has no persisted scope",
    (code, scope) => {
      expect(canonicalizeRecoveryRequest(request(), scope)).toEqual({
        ok: false,
        code,
      });
    },
  );

  it("[behavior:#277:B-03] refuses a selector that is in no persisted scope entry", () => {
    expect(canonicalizeRecoveryRequest(request("99"), SCOPE)).toEqual({
      ok: false,
      code: "target-out-of-scope",
    });
  });

  it("[behavior:#277:B-03] refuses a selector that matches two different entries", () => {
    // `8` is slice 08's number and also #8's issue id on a different entry: the
    // selector names no single slice, so neither worktree may be recovered.
    const ambiguous: PersistedRunScope = {
      mode: "explicit",
      slices: [
        { number: "08", ghIssue: "278" },
        { number: "12", ghIssue: "8" },
      ],
    };

    expect(canonicalizeRecoveryRequest(request("8"), ambiguous)).toEqual({
      ok: false,
      code: "selector-ambiguous",
    });
  });
});

describe("canonical scope fingerprint", () => {
  it("[behavior:#277:B-04] encodes exactly one byte string, in persisted order", () => {
    expect(encodeRunScopeFingerprintPayload(SCOPE)).toBe(
      '{"mode":"explicit","slices":[{"number":"7","ghIssue":"277"},' +
        '{"number":"8","ghIssue":"278"}]}',
    );
  });

  it("[behavior:#277:B-04] digests that byte string with SHA-256 over UTF-8", () => {
    const independent = createHash("sha256")
      .update(
        '{"mode":"explicit","slices":[{"number":"7","ghIssue":"277"},' +
          '{"number":"8","ghIssue":"278"}]}',
        "utf-8",
      )
      .digest("hex");

    expect(runScopeFingerprint(SCOPE)).toBe(independent);
    expect(runScopeFingerprint(SCOPE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("[behavior:#277:B-04] is order- and mode-sensitive, and padding-insensitive", () => {
    const reordered: PersistedRunScope = {
      mode: SCOPE.mode,
      slices: [...SCOPE.slices].reverse(),
    };
    const otherMode: PersistedRunScope = { ...SCOPE, mode: "all-afk" };
    const unpadded: PersistedRunScope = {
      mode: SCOPE.mode,
      slices: [
        { number: CANONICAL_SLICE_NUMBER, ghIssue: GH_ISSUE },
        { number: "8", ghIssue: "278" },
      ],
    };

    expect(runScopeFingerprint(reordered)).not.toBe(runScopeFingerprint(SCOPE));
    expect(runScopeFingerprint(otherMode)).not.toBe(runScopeFingerprint(SCOPE));
    expect(runScopeFingerprint(unpadded)).toBe(runScopeFingerprint(SCOPE));
  });
});

describe("read-only eligibility", () => {
  /**
   * One row per distinguishable ineligibility, each failing exactly one
   * predicate from the eligible baseline.
   */
  const CASES: {
    code: RecoveryRefusalCode;
    selector?: string;
    mutate?: (f: Fixture) => void;
    probes?: Partial<RecoveryGitProbes>;
  }[] = [
    {
      code: "scope-absent",
      mutate: (f) => {
        const doc = stateDocument(f);
        delete doc.scope;
        writeFileSync(f.statePath, `${JSON.stringify(doc, null, 2)}\n`);
      },
    },
    { code: "target-out-of-scope", selector: "99" },
    {
      code: "slice-branch-unrecorded",
      mutate: (f) => {
        const doc = stateDocument(f);
        (doc.slices as Record<string, unknown>)[GH_ISSUE] = { phase: "STUCK" };
        writeFileSync(f.statePath, `${JSON.stringify(doc, null, 2)}\n`);
      },
    },
    {
      code: "worktree-unregistered",
      mutate: (f) => rmSync(f.worktreeDir, { recursive: true, force: true }),
    },
    {
      code: "accepted-pair-invalid",
      mutate: (f) =>
        writeAcceptedPair(
          f.sliceDir,
          LOCKED_CONTRACT.replace("**Status:** LOCKED", "**Status:** DRAFT"),
        ),
    },
    { code: "worktree-dirty", probes: { hasUncommittedChanges: () => true } },
    { code: "no-commits-ahead", probes: { countCommitsAhead: () => 0 } },
    {
      code: "feature-head-not-contained",
      probes: { isAncestor: () => false },
    },
  ];

  it.each(CASES)(
    "[behavior:#277:B-05] refuses with $code and changes nothing",
    ({ code, selector, mutate, probes }) => {
      mutate?.(fixture);
      // Captured after the mutation, so "unchanged" means unchanged by the call.
      const before = {
        tips: tips(fixture),
        state: readFileSync(fixture.statePath, "utf-8"),
        contract: readFileSync(join(fixture.sliceDir, CONTRACT_FILENAME), "utf-8"),
        manifest: readFileSync(
          join(fixture.sliceDir, ACCEPTANCE_MANIFEST_FILENAME),
          "utf-8",
        ),
      };

      const outcome = admit(fixture, {
        request: request(selector),
        probes: eligibleProbes(probes),
      });

      expect(outcome).toMatchObject({ admitted: false, code });
      expect(tips(fixture)).toEqual(before.tips);
      expect(readFileSync(fixture.statePath, "utf-8")).toBe(before.state);
      expect(readFileSync(join(fixture.sliceDir, CONTRACT_FILENAME), "utf-8")).toBe(
        before.contract,
      );
      expect(
        readFileSync(join(fixture.sliceDir, ACCEPTANCE_MANIFEST_FILENAME), "utf-8"),
      ).toBe(before.manifest);
      expect(listPublishedPairSnapshots(fixture.sliceDir)).toEqual([]);
    },
    30_000,
  );

  it("[behavior:#277:B-05] gives every ineligibility its own reason code", () => {
    expect(new Set(CASES.map(({ code }) => code)).size).toBe(CASES.length);
  });

  it("[behavior:#277:B-05] admits the baseline, so each row above failed one predicate", () => {
    const eligibility = evaluateRecoveryEligibility({
      repoRoot: fixture.repoRoot,
      prdSlug: PRD_SLUG,
      providerName: PROVIDER,
      state: loadRunState(fixture.repoRoot, PRD_SLUG),
      request: request(),
      sliceDir: fixture.sliceDir,
      probes: eligibleProbes(),
    });

    expect(eligibility).toEqual({
      ok: true,
      facts: {
        target: { number: CANONICAL_SLICE_NUMBER, ghIssue: GH_ISSUE },
        reason: "the pair went stale",
        sliceBranch: SLICE_BRANCH,
        featureBranch: fixture.featureBranch,
        worktreeDir: fixture.worktreeDir,
        scopeFingerprint: runScopeFingerprint(SCOPE),
      },
    });
  });
});

describe("no ref is ever moved", () => {
  it("[behavior:#277:B-06] invokes no merge, reset or rebase anywhere in the module", () => {
    expect(MODULE_CODE).not.toMatch(/\b(?:merge|reset|rebase)\b/i);
    // The prose that promises it is still there; only the code is word-free.
    expect(MODULE_SOURCE).toMatch(/No merge, reset or rebase is invoked/);
  });

  it("[behavior:#277:B-06] leaves both branch tips unmoved across every exercised path", () => {
    const before = tips(fixture);

    // Refusal, admission, snapshot refusal and locked-drift refusal in turn.
    expect(admit(fixture, { request: request("99") }).admitted).toBe(false);
    expect(admit(fixture, { attemptId: "attempt-a" }).admitted).toBe(true);
    expect(admit(fixture, { attemptId: "attempt-a" }).admitted).toBe(false);
    expect(
      publishAcceptedPairSnapshot({
        repoRoot: fixture.repoRoot,
        sliceDir: fixture.sliceDir,
        attemptId: "attempt-a",
      }).ok,
    ).toBe(false);

    expect(tips(fixture)).toEqual(before);
  }, 30_000);
});

describe("byte-verified accepted-pair snapshot", () => {
  it("[behavior:#277:B-07] publishes byte-identical copies and leaves no temporary sibling", () => {
    const result = publishAcceptedPairSnapshot({
      repoRoot: fixture.repoRoot,
      sliceDir: fixture.sliceDir,
      attemptId: "attempt-1",
    });

    expect(result.ok).toBe(true);
    const snapshot = result.ok ? result.snapshot : undefined;
    expect(snapshot?.locator).toBe(
      `.kiro/specs/${PRD_SLUG}/slices/07-fixture/${RECOVERY_SNAPSHOT_DIRNAME}/attempt-1`,
    );
    expect(readFileSync(join(snapshot!.dir, CONTRACT_FILENAME), "utf-8")).toBe(
      LOCKED_CONTRACT,
    );
    expect(
      readFileSync(join(snapshot!.dir, ACCEPTANCE_MANIFEST_FILENAME), "utf-8"),
    ).toBe(ACCEPTED_MANIFEST);
    const source = readLockedAcceptedPair(fixture.sliceDir)!;
    expect(snapshot?.contractFingerprint).toBe(source.contractFingerprint);
    expect(snapshot?.manifestFingerprint).toBe(source.manifestFingerprint);
    // Only the published directory survives — the `.partial` sibling is gone.
    expect(listPublishedPairSnapshots(fixture.sliceDir)).toEqual(["attempt-1"]);
    expect(
      existsSync(
        join(fixture.sliceDir, RECOVERY_SNAPSHOT_DIRNAME, ".attempt-1.partial"),
      ),
    ).toBe(false);
  });

  it("[behavior:#277:B-07] never overwrites a published snapshot directory", () => {
    publishAcceptedPairSnapshot({
      repoRoot: fixture.repoRoot,
      sliceDir: fixture.sliceDir,
      attemptId: "attempt-1",
    });
    const published = join(
      fixture.sliceDir,
      RECOVERY_SNAPSHOT_DIRNAME,
      "attempt-1",
    );
    const before = readFileSync(join(published, CONTRACT_FILENAME), "utf-8");
    writeAcceptedPair(
      fixture.sliceDir,
      `${LOCKED_CONTRACT}\nA later edit of the accepted contract.\n`,
    );

    const again = publishAcceptedPairSnapshot({
      repoRoot: fixture.repoRoot,
      sliceDir: fixture.sliceDir,
      attemptId: "attempt-1",
    });

    expect(again).toMatchObject({
      ok: false,
      code: "snapshot-already-published",
    });
    expect(readFileSync(join(published, CONTRACT_FILENAME), "utf-8")).toBe(before);
  });

  it("[behavior:#277:B-07] publishes nothing and appends no lineage when verification fails", () => {
    const temporary = join(
      fixture.sliceDir,
      RECOVERY_SNAPSHOT_DIRNAME,
      ".attempt-2.partial",
    );

    const outcome = admit(fixture, {
      attemptId: "attempt-2",
      // Corrupt the copy that is about to be published: verification reads the
      // temporary sibling, so this is the only place the check can be proven.
      afterTemporaryWritten: () => {
        writeFileSync(join(temporary, CONTRACT_FILENAME), "not the accepted pair");
      },
    });

    expect(outcome).toMatchObject({
      admitted: false,
      code: "snapshot-publication-failed",
    });
    expect(existsSync(temporary)).toBe(false);
    expect(listPublishedPairSnapshots(fixture.sliceDir)).toEqual([]);
    expect(
      recoveryLineageFor(loadRunState(fixture.repoRoot, PRD_SLUG), GH_ISSUE),
    ).toEqual([]);
    expect(stateDocument(fixture).recoveryLineage).toBeUndefined();
  }, 30_000);
});

/**
 * The child changes the run's persisted *scope* rather than the accepted pair,
 * so the same test can assert both halves of B-08's observable: the recheck
 * refuses on drift, and the accepted-pair bytes are untouched by the whole
 * episode.
 */
const SCOPE_CHANGING_CHILD = `
  import { transactRunState } from "./src/run-state.ts";
  const [repoRoot, prdSlug] = process.argv.slice(1);
  transactRunState(repoRoot, prdSlug, (state) => {
    state.scope = {
      mode: state.scope.mode,
      slices: [...state.scope.slices, { number: "09", ghIssue: "279" }],
    };
    return { changed: true, result: null };
  });
`;

describe("locked recheck against cross-process drift", () => {
  it("[behavior:#277:B-08] refuses when another process changed the scope before the lock", () => {
    const contractBefore = readFileSync(
      join(fixture.sliceDir, CONTRACT_FILENAME),
      "utf-8",
    );
    const manifestBefore = readFileSync(
      join(fixture.sliceDir, ACCEPTANCE_MANIFEST_FILENAME),
      "utf-8",
    );
    let childStatus: number | null = null;

    const outcome = admit(fixture, {
      attemptId: "attempt-contended",
      // The seam is the module's own `beforeLockAcquired`, not `withFileLock`'s
      // `afterLockPublished`: the ordering being proven belongs to this module,
      // and the shared lock primitive stays unmodified.
      beforeLockAcquired: () => {
        const child = spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            SCOPE_CHANGING_CHILD,
            fixture.repoRoot,
            PRD_SLUG,
          ],
          { cwd: process.cwd(), encoding: "utf-8", timeout: 60_000 },
        );
        childStatus = child.status;
        if (child.status !== 0) throw new Error(child.stderr);
      },
    });

    expect(childStatus).toBe(0);
    expect(outcome).toMatchObject({
      admitted: false,
      code: "facts-changed-before-lock",
    });
    expect(
      outcome.admitted === false ? outcome.message : "",
    ).toMatch(/persisted scope changed/);
    // The snapshot was published before the lock and is inert: no lineage event
    // references it, so it grants no recovery authority.
    expect(listPublishedPairSnapshots(fixture.sliceDir)).toEqual([
      "attempt-contended",
    ]);
    expect(stateDocument(fixture).recoveryLineage).toBeUndefined();
    expect(
      recoveryLineageFor(loadRunState(fixture.repoRoot, PRD_SLUG), GH_ISSUE),
    ).toEqual([]);
    expect(readFileSync(join(fixture.sliceDir, CONTRACT_FILENAME), "utf-8")).toBe(
      contractBefore,
    );
    expect(
      readFileSync(join(fixture.sliceDir, ACCEPTANCE_MANIFEST_FILENAME), "utf-8"),
    ).toBe(manifestBefore);
  }, 120_000);

  it("[behavior:#277:B-08] leaves src/file-lock.ts and both lock wrappers unmodified", () => {
    // "Unmodified" asserted as source text rather than by diffing the checkout:
    // the seam this slice added is a parameter on its own entry point, so the
    // ADR 0056 primitive and its run-state wrapper must still read exactly this.
    expect(sourceOf("run-state.ts")).toContain(
      [
        "export function withRunStateLock<T>(",
        "  repoRoot: string,",
        "  prdSlug: string,",
        "  action: () => T,",
        "): T {",
        "  return withFileLock(statePath(repoRoot, prdSlug), action);",
        "}",
      ].join("\n"),
    );
    const lockSource = sourceOf("file-lock.ts");
    expect(lockSource).toContain("export function withFileLock<T>(");
    expect(lockSource).toContain("afterLockPublished");
    // Nothing in this slice's module reaches for the lock primitive directly.
    expect(MODULE_SOURCE).not.toContain('from "./file-lock.js"');
    expect(MODULE_CODE).not.toContain("afterLockPublished");
  });
});

describe("admission commits exactly one PENDING event", () => {
  it("[behavior:#277:B-09] appends one event carrying every recorded member", () => {
    const before = stateDocument(fixture);
    const expectedTips = tips(fixture);

    const outcome = admit(fixture, { attemptId: "attempt-admitted" });

    expect(outcome.admitted).toBe(true);
    const after = stateDocument(fixture);
    const lineage = (after.recoveryLineage as Record<string, unknown[]>)[GH_ISSUE];
    expect(lineage).toHaveLength(1);
    expect(lineage![0]).toEqual({
      attemptId: "attempt-admitted",
      state: "PENDING",
      target: { number: CANONICAL_SLICE_NUMBER, ghIssue: GH_ISSUE },
      reason: "the pair went stale",
      extensions: [],
      provider: PROVIDER,
      sliceBranch: SLICE_BRANCH,
      sliceHead: expectedTips.slice,
      featureHead: expectedTips.feature,
      scopeFingerprint: runScopeFingerprint(SCOPE),
      snapshotPath:
        `.kiro/specs/${PRD_SLUG}/slices/07-fixture/` +
        `${RECOVERY_SNAPSHOT_DIRNAME}/attempt-admitted`,
      contractFingerprint: createHash("sha256")
        .update(LOCKED_CONTRACT, "utf-8")
        .digest("hex"),
      manifestFingerprint: createHash("sha256")
        .update(ACCEPTED_MANIFEST, "utf-8")
        .digest("hex"),
      recordedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
    });
    // The run-state diff is that one appended event and nothing else.
    expect(after).toEqual({
      ...before,
      version: RUN_STATE_VERSION,
      recoveryLineage: { [GH_ISSUE]: lineage },
    });
    expect(outcome.admitted === true ? outcome.event : undefined).toEqual(
      lineage![0],
    );
  }, 30_000);

  it("[behavior:#277:B-09] refuses a second admission while the last event is PENDING", () => {
    expect(admit(fixture, { attemptId: "attempt-first" }).admitted).toBe(true);
    const afterFirst = stateDocument(fixture);

    const second = admit(fixture, { attemptId: "attempt-second" });

    expect(second).toMatchObject({
      admitted: false,
      code: "attempt-already-pending",
    });
    expect(stateDocument(fixture)).toEqual(afterFirst);
    expect(listPublishedPairSnapshots(fixture.sliceDir)).toEqual([
      "attempt-first",
    ]);
    expect(
      hasOpenRecoveryAttempt(loadRunState(fixture.repoRoot, PRD_SLUG), GH_ISSUE),
    ).toBe(true);
  }, 30_000);
});

describe("recovery lineage transitions", () => {
  const STATES: RecoveryLineageState[] = [
    "PENDING",
    "COMPLETED",
    "ROLLED_BACK",
    "ROLLBACK_FAILED",
  ];
  const LEGAL = new Set([
    "PENDING>COMPLETED",
    "PENDING>ROLLED_BACK",
    "PENDING>ROLLBACK_FAILED",
    "ROLLBACK_FAILED>ROLLED_BACK",
  ]);
  const PAIRS = STATES.flatMap((from) => STATES.map((to) => [from, to] as const));

  it.each(PAIRS)(
    "[behavior:#277:B-11] decides %s -> %s by the transition table alone",
    (from, to) => {
      expect(isLegalRecoveryTransition(from, to)).toBe(LEGAL.has(`${from}>${to}`));
    },
  );

  it("[behavior:#277:B-11] admits exactly four transitions and no return to PENDING", () => {
    const accepted = PAIRS.filter(([from, to]) =>
      isLegalRecoveryTransition(from, to),
    );

    expect(accepted).toHaveLength(4);
    expect(accepted.some(([, to]) => to === "PENDING")).toBe(false);
  });

  it("[behavior:#277:B-11] appends without shortening or rewriting the existing list", () => {
    const first = lineageEvent({ attemptId: "one" });
    const second = lineageEvent({ attemptId: "two", state: "COMPLETED" });
    const state: RunState = {
      version: RUN_STATE_VERSION,
      prdSlug: PRD_SLUG,
      featureBranch: fixture.featureBranch,
      slices: {},
      recoveryLineage: { [GH_ISSUE]: [first], "278": [lineageEvent({})] },
    };
    const untouched = recoveryLineageFor(state, "278");

    appendRecoveryLineageEvent(state, GH_ISSUE, second);

    expect(recoveryLineageFor(state, GH_ISSUE)).toEqual([first, second]);
    // The pre-existing event is the same value, not a rewritten copy.
    expect(recoveryLineageFor(state, GH_ISSUE)[0]).toEqual(first);
    expect(recoveryLineageFor(state, "278")).toEqual(untouched);
  });

  it("[behavior:#277:B-11] mints a fresh attempt ID for a retry, leaving the earlier event's bytes alone", () => {
    // Neither admission supplies `attemptId`, so the module's own minting is
    // what makes a retry a new attempt — the point B-11 records.
    const first = admit(fixture);
    expect(first.admitted).toBe(true);
    const firstId = first.admitted ? first.attemptId : "";
    const firstBytes = JSON.stringify(
      (stateDocument(fixture).recoveryLineage as Record<string, unknown[]>)[
        GH_ISSUE
      ]![0],
    );

    // Resolve the first attempt so a retry is admissible at all. The fixture
    // records the legal `PENDING -> COMPLETED` itself rather than calling #335's
    // writer, because what B-11 is about is the *second* admission.
    expect(isLegalRecoveryTransition("PENDING", "COMPLETED")).toBe(true);
    const document = stateDocument(fixture);
    const events = (document.recoveryLineage as Record<
      string,
      PersistedRecoveryLineageEvent[]
    >)[GH_ISSUE]!;
    // The three completion members #335 B-12 requires on `COMPLETED`, with
    // replacement fingerprints that are not the pair now on disk: a completion
    // accepts a *replacement* pair, and #335's replay check keys on exactly that
    // comparison — matching fingerprints here would make the retry a replay.
    events.push({
      ...events[0]!,
      state: "COMPLETED",
      replacementContractFingerprint: "9".repeat(64),
      replacementManifestFingerprint: "a".repeat(64),
      lockProvenance: "fixture-recorded completion",
    });
    writeFileSync(fixture.statePath, `${JSON.stringify(document, null, 2)}\n`);

    const second = admit(fixture);

    expect(second.admitted).toBe(true);
    const secondId = second.admitted ? second.attemptId : "";
    expect(secondId).not.toBe(firstId);
    expect(firstId).not.toBe("");
    const lineage = (stateDocument(fixture).recoveryLineage as Record<
      string,
      unknown[]
    >)[GH_ISSUE]!;
    // Append-only: the retry added one new `PENDING` event and rewrote nothing,
    // so the first attempt's bytes are still exactly its own.
    expect(lineage).toHaveLength(3);
    expect(JSON.stringify(lineage[0])).toBe(firstBytes);
    expect((lineage[2] as PersistedRecoveryLineageEvent).attemptId).toBe(secondId);
    // Two attempt IDs mean two snapshot directories; one ID would have collided
    // with the published-never-overwritten rule instead.
    expect(listPublishedPairSnapshots(fixture.sliceDir).sort()).toEqual(
      [firstId, secondId].sort(),
    );
  }, 30_000);

  function lineageEvent(
    overrides: Partial<PersistedRecoveryLineageEvent>,
  ): PersistedRecoveryLineageEvent {
    return {
      attemptId: "attempt",
      state: "PENDING",
      target: { number: CANONICAL_SLICE_NUMBER, ghIssue: GH_ISSUE },
      reason: "stale",
      extensions: [],
      provider: PROVIDER,
      sliceBranch: SLICE_BRANCH,
      sliceHead: "a".repeat(40),
      featureHead: "b".repeat(40),
      scopeFingerprint: "c".repeat(64),
      snapshotPath: "slices/07-fixture/recovery-snapshots/attempt",
      contractFingerprint: "d".repeat(64),
      manifestFingerprint: "e".repeat(64),
      recordedAt: "2026-09-14T00:00:00.000Z",
      ...overrides,
    };
  }
});

describe("the eligibility predicates' git surface", () => {
  const GIT_IMPORTS = [
    "countCommitsAhead",
    "hasUncommittedChanges",
    "isAncestor",
    "resolveCommit",
  ];

  it.each([
    ["worktree-dirty", { hasUncommittedChanges: () => true }],
    ["no-commits-ahead", { countCommitsAhead: () => 0 }],
    ["feature-head-not-contained", { isAncestor: () => false }],
  ] as [RecoveryRefusalCode, Partial<RecoveryGitProbes>][])(
    "[behavior:#277:P-05] flips the %s outcome from the three stubs alone",
    (code, overrides) => {
      const probes = eligibleProbes(overrides);

      const eligibility = evaluateRecoveryEligibility({
        repoRoot: fixture.repoRoot,
        prdSlug: PRD_SLUG,
        providerName: PROVIDER,
        state: loadRunState(fixture.repoRoot, PRD_SLUG),
        request: request(),
        sliceDir: fixture.sliceDir,
        probes,
      });

      expect(eligibility).toMatchObject({ ok: false, code });
      // Only the three pinned predicates were consulted, at their current
      // signatures — the recorder would have logged anything else.
      expect(
        probes.calls.every((call) =>
          /^(?:hasUncommittedChanges|countCommitsAhead|isAncestor):/.test(call),
        ),
      ).toBe(true);
    },
  );

  it("[behavior:#277:P-05] reaches no other git export from inside the predicates", () => {
    const start = MODULE_CODE.indexOf("export function evaluateRecoveryEligibility");
    const rest = MODULE_CODE.slice(start + 1);
    const body = MODULE_CODE.slice(start, start + 1 + rest.indexOf("\nexport "));

    expect(start).toBeGreaterThan(-1);
    for (const name of GIT_IMPORTS) {
      // Every git call inside eligibility goes through the injected probes;
      // a bare `name(` would be a direct reach into `src/git.ts`.
      expect(body).not.toMatch(new RegExp(String.raw`(?<!probes\.)\b${name}\(`));
    }
    expect(body).toContain("probes.hasUncommittedChanges(");
    expect(body).toContain("probes.countCommitsAhead(");
    expect(body).toContain("probes.isAncestor(");
  });

  it("[behavior:#277:P-05] imports nothing else from git.ts or worktree-processes.ts", () => {
    const gitImport = MODULE_SOURCE.match(/import \{([^}]*)\} from "\.\/git\.js";/);

    expect(
      gitImport?.[1]
        ?.split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "")
        .sort(),
    ).toEqual([...GIT_IMPORTS].sort());
    // Comments name the module the predicates must not reach; the code must not.
    expect(MODULE_CODE).not.toContain("worktree-processes");
  });
});

/*
 * ---------------------------------------------------------------------------
 * Recovery attempt execution (#332)
 * ---------------------------------------------------------------------------
 *
 * Every case below reuses the file's one real git repo and the same stubbed
 * probes: execution reads run state and moves bytes, so the only thing git is
 * needed for is the `admitStaleRenegotiation` call that commits the `PENDING`
 * event each case starts from. No spawned pipeline scenario is added — the state
 * execution needs (a committed attempt, seeded checkpoint and lineage, live
 * negotiation files) is reachable by writing it, which is the top of the
 * `AGENTS.md` assertion ladder rather than the bottom.
 */

/** The seven live negotiation files execution preserves, with distinct bytes. */
const NEGOTIATION_BYTES: Record<string, string> = {
  "context.md": "# Explorer context\n\nFACT: the accepted pair predates the discovery.\n",
  "contract-review.json": '{"version":2,"verdict":"ACCEPT","findings":[]}\n',
  "contract-response.json": '{"round":2,"response":"accepted"}\n',
  "contract-negotiation-outcome.json": '{"outcome":"ACCEPTED","rounds":2}\n',
  "planner-escalation.md": "# Planner escalation\n\nNothing was escalated.\n",
  "feedback-r1.md": "## Evaluator feedback — round 1\n",
  "feedback-r2.md": "## Evaluator feedback — round 2\n",
};

/** Live artifacts execution must leave alone: reviews/, QA, implementation. */
const PRESERVED_ARTIFACTS: Record<string, string> = {
  "reviews/contract-review-r1.json": '{"version":2,"verdict":"REVISE","findings":[]}\n',
  "reviews/qa-review-r1.json": '{"version":2,"verdict":"FAIL"}\n',
  "qa-report.md": "# QA Report\n\n**Verdict:** PASS\n",
  "handoff.md": "## What shipped\n\n- B-01: src/fixture.ts\n",
  "run-summary.md": "# Run summary\n\nThe generator wrote src/fixture.ts.\n",
};

const TARGET_TREE = "a1".repeat(20);
const OTHER_TREE = "b2".repeat(20);

/** The one checkpoint shape this repository can hold, as B-05 pins it. */
const TARGET_CHECKPOINT: ExactStageCheckpoint = {
  version: 1,
  completedStage: "deterministic-qa",
  candidateTreeId: TARGET_TREE,
  nextPendingStage: "post-qa-deterministic",
  round: 1,
};

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Every file under `root`, keyed by `/`-separated relative path, as SHA-256. */
function digestTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const key = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, key);
      else out[key] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  if (existsSync(root)) walk(root, "");
  return out;
}

function writeSliceFiles(sliceDir: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    const path = join(sliceDir, ...name.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
}

/** A valid non-empty durable lineage — the value B-07 measures the clear against. */
function seededLineage(id: string): ContractFindingLineage {
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

/** Seed both negotiation controls for the target and for the second slice. */
function seedNegotiationControls(f: Fixture): void {
  recordExactStageCheckpoint(
    { repoRoot: f.repoRoot, prdSlug: PRD_SLUG, ghIssue: GH_ISSUE },
    TARGET_CHECKPOINT,
  );
  recordExactStageCheckpoint(
    { repoRoot: f.repoRoot, prdSlug: PRD_SLUG, ghIssue: "278" },
    { ...TARGET_CHECKPOINT, candidateTreeId: OTHER_TREE, round: 2 },
  );
  saveContractFindingLineage(
    { repoRoot: f.repoRoot, runSlug: PRD_SLUG, ghIssue: GH_ISSUE },
    seededLineage("F-01"),
  );
  saveContractFindingLineage(
    { repoRoot: f.repoRoot, runSlug: PRD_SLUG, ghIssue: "278" },
    seededLineage("F-02"),
  );
}

function inspectTarget(f: Fixture, ghIssue = GH_ISSUE, tree = TARGET_TREE) {
  return inspectExactStageCheckpoint({
    repoRoot: f.repoRoot,
    prdSlug: PRD_SLUG,
    ghIssue,
    currentCandidateTreeId: tree,
    expectedCompletedStage: "deterministic-qa",
    maximumRound: 3,
  });
}

function lineageOf(f: Fixture, ghIssue: string): ContractFindingLineage {
  return loadContractFindingLineage({
    repoRoot: f.repoRoot,
    runSlug: PRD_SLUG,
    ghIssue,
  });
}

function checkpointsOf(f: Fixture): Record<string, unknown> {
  return (stateDocument(f).stageCheckpoints ?? {}) as Record<string, unknown>;
}

/** Commit one `PENDING` attempt and return its published snapshot directory. */
function admitPending(f: Fixture, attemptId = "attempt-exec"): string {
  const outcome = admit(f, { attemptId });
  expect(outcome.admitted).toBe(true);
  return join(f.sliceDir, RECOVERY_SNAPSHOT_DIRNAME, attemptId);
}

function execute(
  f: Fixture,
  overrides: Partial<ExecuteRecoveryAttemptArgs> = {},
) {
  return executeRecoveryAttempt({
    repoRoot: f.repoRoot,
    prdSlug: PRD_SLUG,
    sliceDir: f.sliceDir,
    ghIssue: GH_ISSUE,
    ...overrides,
  });
}

describe("execution refuses without a committed PENDING attempt", () => {
  it.each([
    ["the target has no recovery lineage at all", undefined],
    ["the target's lineage ends on a terminal event", "COMPLETED" as const],
  ])(
    "[behavior:#332:B-01] refuses with no-pending-attempt and writes nothing when %s",
    (_label, terminal) => {
      writeSliceFiles(fixture.sliceDir, NEGOTIATION_BYTES);
      if (terminal !== undefined) {
        admitPending(fixture, "attempt-resolved");
        const document = stateDocument(fixture);
        const events = (document.recoveryLineage as Record<
          string,
          PersistedRecoveryLineageEvent[]
        >)[GH_ISSUE]!;
        events.push({
          ...events[0]!,
          state: terminal as RecoveryLineageState,
        });
        writeFileSync(fixture.statePath, `${JSON.stringify(document, null, 2)}\n`);
      }
      // Captured after the setup, so "unchanged" means unchanged by the call.
      const before = {
        tree: digestTree(fixture.sliceDir),
        state: readFileSync(fixture.statePath, "utf-8"),
      };

      const outcome = execute(fixture);

      expect(outcome).toMatchObject({ ok: false, code: "no-pending-attempt" });
      expect(outcome.ok === false ? outcome.message : "").toContain(
        `#${GH_ISSUE}`,
      );
      // Not a byte under the slice directory, and not a run-state field.
      expect(digestTree(fixture.sliceDir)).toEqual(before.tree);
      expect(readFileSync(fixture.statePath, "utf-8")).toBe(before.state);
    },
    30_000,
  );
});

describe("the attempt's immutable negotiation history", () => {
  it("[behavior:#332:B-02] byte-copies every present kind into the attempt's own directory", () => {
    const attemptDir = admitPending(fixture);
    writeSliceFiles(fixture.sliceDir, NEGOTIATION_BYTES);
    const liveBefore = Object.fromEntries(
      Object.keys(NEGOTIATION_BYTES).map((name) => [
        name,
        readFileSync(join(fixture.sliceDir, name)),
      ]),
    );

    const outcome = execute(fixture);

    expect(outcome.ok).toBe(true);
    const history = join(attemptDir, RECOVERY_NEGOTIATION_DIRNAME);
    expect(outcome.ok === true ? outcome.historyDir : "").toBe(history);
    expect(outcome.ok === true ? outcome.historyLocator : "").toBe(
      `.kiro/specs/${PRD_SLUG}/slices/07-fixture/${RECOVERY_SNAPSHOT_DIRNAME}/` +
        `attempt-exec/${RECOVERY_NEGOTIATION_DIRNAME}`,
    );
    for (const [name, bytes] of Object.entries(liveBefore)) {
      // The bytes that were live, not a re-derivation of the fixture constant.
      expect(readFileSync(join(history, name)).equals(bytes)).toBe(true);
      expect(existsSync(join(fixture.sliceDir, name))).toBe(false);
    }
    expect(readdirSync(history).sort()).toEqual(
      Object.keys(NEGOTIATION_BYTES).sort(),
    );
    // Published through a temporary sibling and one rename: nothing is left.
    expect(
      existsSync(join(attemptDir, `.${RECOVERY_NEGOTIATION_DIRNAME}.partial`)),
    ).toBe(false);
  }, 30_000);

  it("[behavior:#332:B-02] deletes nothing and publishes nothing when the copy fails verification", () => {
    const attemptDir = admitPending(fixture);
    writeSliceFiles(fixture.sliceDir, NEGOTIATION_BYTES);
    const before = digestTree(fixture.sliceDir);

    const outcome = execute(fixture, {
      // Corrupt the copy that is about to be published: verification reads the
      // temporary sibling, so this is the only place the check can be proven.
      afterHistoryWritten: (temporary) => {
        writeFileSync(join(temporary, "feedback-r2.md"), "not the live bytes");
      },
    });

    expect(outcome).toMatchObject({
      ok: false,
      code: "snapshot-publication-failed",
    });
    expect(outcome.ok === false ? outcome.message : "").toContain("feedback-r2.md");
    // Every live file still exists with its original bytes, and no history —
    // partial or published — is on disk.
    expect(digestTree(fixture.sliceDir)).toEqual(before);
    for (const name of Object.keys(NEGOTIATION_BYTES)) {
      expect(existsSync(join(fixture.sliceDir, name))).toBe(true);
    }
    expect(existsSync(join(attemptDir, RECOVERY_NEGOTIATION_DIRNAME))).toBe(false);
    expect(
      existsSync(join(attemptDir, `.${RECOVERY_NEGOTIATION_DIRNAME}.partial`)),
    ).toBe(false);
  }, 30_000);

  it("[behavior:#332:B-02] keeps the snapshot-already-published refusal code and message unchanged", () => {
    publishAcceptedPairSnapshot({
      repoRoot: fixture.repoRoot,
      sliceDir: fixture.sliceDir,
      attemptId: "attempt-pinned",
    });
    const published = join(
      fixture.sliceDir,
      RECOVERY_SNAPSHOT_DIRNAME,
      "attempt-pinned",
    );

    const again = publishAcceptedPairSnapshot({
      repoRoot: fixture.repoRoot,
      sliceDir: fixture.sliceDir,
      attemptId: "attempt-pinned",
    });

    expect(again).toEqual({
      ok: false,
      code: "snapshot-already-published",
      message:
        `A recovery snapshot is already published at ${published}; ` +
        "a published snapshot is never overwritten",
    });
    // The docstring's invariant now reads over the pair *files*, because the
    // history above is a child inside an already-published attempt directory.
    expect(MODULE_SOURCE).toContain(
      "A published pair file is never overwritten.",
    );
    expect(MODULE_SOURCE).not.toContain("A published directory is never overwritten");
  });

  it("[behavior:#332:B-03] moves exactly the present kinds, reports them, and skips the absent", () => {
    const attemptDir = admitPending(fixture);
    const present = {
      "context.md": NEGOTIATION_BYTES["context.md"]!,
      "feedback-r1.md": NEGOTIATION_BYTES["feedback-r1.md"]!,
      "feedback-r2.md": NEGOTIATION_BYTES["feedback-r2.md"]!,
    };
    writeSliceFiles(fixture.sliceDir, { ...present, ...PRESERVED_ARTIFACTS });
    const absent = RECOVERY_NEGOTIATION_FILENAMES.filter(
      (name) => !(name in present),
    );
    expect(absent).toHaveLength(4);

    const outcome = execute(fixture);

    expect(outcome).toMatchObject({
      ok: true,
      movedFiles: ["context.md", "feedback-r1.md", "feedback-r2.md"],
    });
    expect(readdirSync(join(attemptDir, RECOVERY_NEGOTIATION_DIRNAME)).sort()).toEqual(
      Object.keys(present).sort(),
    );
    for (const name of Object.keys(present)) {
      expect(existsSync(join(fixture.sliceDir, name))).toBe(false);
    }
    // An absent kind is skipped without error and without being invented.
    for (const name of absent) {
      expect(existsSync(join(fixture.sliceDir, name))).toBe(false);
      expect(
        existsSync(join(attemptDir, RECOVERY_NEGOTIATION_DIRNAME, name)),
      ).toBe(false);
    }
    for (const name of Object.keys(PRESERVED_ARTIFACTS)) {
      expect(existsSync(join(fixture.sliceDir, ...name.split("/")))).toBe(true);
    }
    expect(listLiveNegotiationFiles(fixture.sliceDir)).toEqual([]);
  }, 30_000);

  it("[behavior:#332:B-03] orders feedback rounds by round number, not by name", () => {
    admitPending(fixture);
    writeSliceFiles(fixture.sliceDir, {
      "feedback-r1.md": "r1\n",
      "feedback-r2.md": "r2\n",
      "feedback-r10.md": "r10\n",
    });

    expect(listLiveNegotiationFiles(fixture.sliceDir)).toEqual([
      "feedback-r1.md",
      "feedback-r2.md",
      "feedback-r10.md",
    ]);
    expect(execute(fixture)).toMatchObject({
      ok: true,
      movedFiles: ["feedback-r1.md", "feedback-r2.md", "feedback-r10.md"],
    });
  }, 30_000);

  it("[behavior:#332:B-04] leaves reviews/, QA and implementation artifacts and both published pair bytes identical", () => {
    const attemptDir = admitPending(fixture);
    writeSliceFiles(fixture.sliceDir, {
      ...NEGOTIATION_BYTES,
      ...PRESERVED_ARTIFACTS,
    });
    const untouchedPaths = [
      ...Object.keys(PRESERVED_ARTIFACTS),
      CONTRACT_FILENAME,
      ACCEPTANCE_MANIFEST_FILENAME,
    ];
    const before = {
      live: Object.fromEntries(
        untouchedPaths.map((name) => [
          name,
          readFileSync(join(fixture.sliceDir, ...name.split("/")), "utf-8"),
        ]),
      ),
      snapshot: digestTree(attemptDir),
    };
    expect(Object.keys(before.snapshot).sort()).toEqual(
      [ACCEPTANCE_MANIFEST_FILENAME, CONTRACT_FILENAME].sort(),
    );

    expect(execute(fixture).ok).toBe(true);

    for (const [name, bytes] of Object.entries(before.live)) {
      expect(
        readFileSync(join(fixture.sliceDir, ...name.split("/")), "utf-8"),
      ).toBe(bytes);
    }
    // The two published pair files are byte-identical; the attempt directory
    // only gained the `negotiation/` child.
    const after = digestTree(attemptDir);
    for (const [name, digest] of Object.entries(before.snapshot)) {
      expect(after[name]).toBe(digest);
    }
  }, 30_000);
});

describe("execution clears exactly the two negotiation controls", () => {
  it("[behavior:#332:B-05] drops the target's checkpoint and lineage and no other slice's", () => {
    admitPending(fixture);
    writeSliceFiles(fixture.sliceDir, NEGOTIATION_BYTES);
    seedNegotiationControls(fixture);
    const otherCheckpointBefore = JSON.stringify(checkpointsOf(fixture)["278"]);
    const otherLineageBefore = lineageOf(fixture, "278");
    expect(Object.keys(checkpointsOf(fixture)).sort()).toEqual([GH_ISSUE, "278"]);

    expect(execute(fixture).ok).toBe(true);

    expect(GH_ISSUE in checkpointsOf(fixture)).toBe(false);
    expect(JSON.stringify(checkpointsOf(fixture)["278"])).toBe(
      otherCheckpointBefore,
    );
    expect(lineageOf(fixture, GH_ISSUE)).toEqual(emptyContractFindingLineage());
    expect(lineageOf(fixture, "278")).toEqual(otherLineageBefore);
  }, 30_000);

  it("[behavior:#332:B-05] reaches each clear through one wrapper over the API that owns it", () => {
    const checkpointImport = MODULE_SOURCE.match(
      /import \{([^}]*)\} from "\.\/exact-stage-resume\.js";/,
    );
    const convergenceImport = MODULE_SOURCE.match(
      /import \{([^}]*)\} from "\.\/contract-convergence\.js";/,
    );
    const named = (match: RegExpMatchArray | null): string[] =>
      (match?.[1] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "")
        .sort();

    expect(named(checkpointImport)).toEqual(["clearExactStageCheckpoint"]);
    expect(named(convergenceImport)).toEqual([
      "emptyContractFindingLineage",
      "saveContractFindingLineage",
    ]);
    // Exactly one call site each: the wrapper. A second would be a second
    // adaptation of the same clear.
    expect(occurrences(MODULE_CODE, "clearExactStageCheckpoint(")).toBe(1);
    expect(occurrences(MODULE_CODE, "saveContractFindingLineage(")).toBe(1);
    expect(MODULE_CODE).toContain("export function clearRecoveryStageCheckpoint(");
    expect(MODULE_CODE).toContain(
      "export function clearRecoveryContractConvergence(",
    );
    // The coarser dispatch clear is never reached: it would drop facts recovery
    // exists to preserve. Named in a comment there, absent from the code.
    expect(MODULE_CODE).not.toContain("clearSliceStateForDispatch");
    expect(MODULE_SOURCE).toContain("`clearSliceStateForDispatch` is deliberately not used");
  });

  it("[behavior:#332:B-06] changes no other persisted fact than those two entries", () => {
    // A second, smaller guard beside the fixture-built B-06 assertion in
    // `resume-integration.test.ts`: this one measures the diff on the file's own
    // baseline state, so a regression is caught by the fast suite too.
    admitPending(fixture);
    writeSliceFiles(fixture.sliceDir, NEGOTIATION_BYTES);
    seedNegotiationControls(fixture);
    const before = stateDocument(fixture);

    expect(execute(fixture).ok).toBe(true);

    const after = stateDocument(fixture);
    const differing = Object.keys({ ...before, ...after }).filter(
      (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    );
    expect(differing.sort()).toEqual(["contractConvergence", "stageCheckpoints"]);
    expect(after.slices).toEqual(before.slices);
    expect(after.scope).toEqual(before.scope);
    expect(after.recoveryLineage).toEqual(before.recoveryLineage);
    expect(
      (after.contractConvergence as Record<string, unknown>)["278"],
    ).toEqual((before.contractConvergence as Record<string, unknown>)["278"]);
  }, 30_000);

  it("[behavior:#332:B-07] turns a measured resume decision into a reevaluation", () => {
    admitPending(fixture);
    writeSliceFiles(fixture.sliceDir, NEGOTIATION_BYTES);
    seedNegotiationControls(fixture);
    // Measured first, so the post-execution assertion cannot pass vacuously on a
    // target that never had a checkpoint or a lineage.
    expect(inspectTarget(fixture)).toEqual({
      action: "resume",
      checkpoint: TARGET_CHECKPOINT,
    });
    const seeded = lineageOf(fixture, GH_ISSUE);
    expect(Object.keys(seeded.findings)).toEqual(["F-01"]);
    expect(seeded).not.toEqual(emptyContractFindingLineage());

    expect(execute(fixture).ok).toBe(true);

    expect(inspectTarget(fixture)).toEqual({
      action: "reevaluate",
      reason: "no exact-stage checkpoint was recorded for this slice",
    });
    expect(lineageOf(fixture, GH_ISSUE)).toEqual(emptyContractFindingLineage());
    // The second slice's resume decision is untouched, so the clear was per-slice.
    expect(inspectTarget(fixture, "278", OTHER_TREE)).toMatchObject({
      action: "resume",
    });
  }, 30_000);
});

describe("execution preserves the work it exists to protect", () => {
  it("[behavior:#332:B-08] moves no ref, writes no worktree byte and spends no attempt", () => {
    const document = stateDocument(fixture);
    document.resume = { [GH_ISSUE]: { attempts: 2, lastDecision: "resumed" } };
    writeFileSync(fixture.statePath, `${JSON.stringify(document, null, 2)}\n`);
    admitPending(fixture);
    writeSliceFiles(fixture.sliceDir, NEGOTIATION_BYTES);
    seedNegotiationControls(fixture);
    const before = {
      tips: tips(fixture),
      worktree: digestTree(fixture.worktreeDir),
      resume: stateDocument(fixture).resume,
      slices: stateDocument(fixture).slices,
    };
    // The preserved branch really is ahead, so a lost commit would be visible.
    expect(git(fixture.repoRoot, "rev-list", "--count", `${fixture.featureBranch}..${SLICE_BRANCH}`)).toBe("1");

    expect(execute(fixture).ok).toBe(true);

    expect(tips(fixture)).toEqual(before.tips);
    expect(digestTree(fixture.worktreeDir)).toEqual(before.worktree);
    expect(stateDocument(fixture).resume).toEqual(before.resume);
    expect(stateDocument(fixture).slices).toEqual(before.slices);
    expect(
      git(fixture.repoRoot, "rev-list", "--count", `${fixture.featureBranch}..${SLICE_BRANCH}`),
    ).toBe("1");
    // No merge, reset or rebase is reachable: the word is absent from the code.
    expect(MODULE_CODE).not.toMatch(/\b(?:merge|reset|rebase)\b/i);
  }, 30_000);

  it("[behavior:#332:B-09] appends no lineage event and still ends on the same PENDING event", () => {
    admitPending(fixture);
    writeSliceFiles(fixture.sliceDir, NEGOTIATION_BYTES);
    seedNegotiationControls(fixture);
    const before = recoveryLineageFor(
      loadRunState(fixture.repoRoot, PRD_SLUG),
      GH_ISSUE,
    );
    expect(before).toHaveLength(1);

    expect(execute(fixture).ok).toBe(true);

    const after = recoveryLineageFor(
      loadRunState(fixture.repoRoot, PRD_SLUG),
      GH_ISSUE,
    );
    expect(after).toEqual(before);
    expect(after.map((event) => event.state)).toEqual(["PENDING"]);
    expect(hasOpenRecoveryAttempt(loadRunState(fixture.repoRoot, PRD_SLUG), GH_ISSUE)).toBe(true);
    // Verified restore is #333: no terminal writer exists on this path.
    for (const terminal of ["COMPLETED", "ROLLED_BACK", "ROLLBACK_FAILED"]) {
      expect(after.some((event) => event.state === terminal)).toBe(false);
    }
  }, 30_000);

  it("[behavior:#332:P-01] leaves admission's single-PENDING mutation intact", () => {
    const before = stateDocument(fixture);

    const outcome = admit(fixture, { attemptId: "attempt-preserved" });

    expect(outcome.admitted).toBe(true);
    const after = stateDocument(fixture);
    const lineage = (after.recoveryLineage as Record<string, unknown[]>)[GH_ISSUE]!;
    expect(lineage).toHaveLength(1);
    expect((lineage[0] as PersistedRecoveryLineageEvent).state).toBe("PENDING");
    // The append is still admission's only mutation, and the seams are still
    // parameters on its own entry point.
    expect(after).toEqual({
      ...before,
      version: RUN_STATE_VERSION,
      recoveryLineage: { [GH_ISSUE]: lineage },
    });
    expect(MODULE_SOURCE).toContain("beforeLockAcquired?: () => void;");
    expect(MODULE_SOURCE).toContain("afterTemporaryWritten?: () => void;");
  }, 30_000);

  it("[behavior:#332:P-02] still refuses --renegotiate-stale on the one shared parse path", () => {
    // Re-pinned from this slice's own test file so `src/cli-options.test.ts`
    // stays untouched and out of scope; #277's pin there is unchanged.
    expect(() =>
      parsePipelineRuntimeOptions([
        "--renegotiate-stale",
        SLICE_NUMBER,
        "--recovery-reason",
        "the pair went stale",
      ]),
    ).toThrow(/--renegotiate-stale is refused until #335 lands/);
    // The flags' own validation messages are unchanged, and still reachable.
    expect(
      parseStaleRenegotiationRequest([
        "--renegotiate-stale",
        SLICE_NUMBER,
        "--recovery-reason",
        "  stale  ",
      ]),
    ).toEqual({ selector: SLICE_NUMBER, reason: "stale" });
    expect(() => parseStaleRenegotiationRequest(["--renegotiate-stale", "7"])).toThrow(
      "--renegotiate-stale requires --recovery-reason <text> recording why the accepted pair is stale",
    );
    expect(() => parseStaleRenegotiationRequest(["--recovery-reason", "x"])).toThrow(
      "--recovery-reason requires --renegotiate-stale <slice|ghIssue> naming the target to renegotiate",
    );
    expect(() =>
      parseStaleRenegotiationRequest(["--renegotiate-stale", "7,7", "--recovery-reason", "x"]),
    ).toThrow("--renegotiate-stale names 7 more than once; supply the target exactly once");
    expect(() =>
      parseStaleRenegotiationRequest(["--renegotiate-stale", "7", "--recovery-reason", "  "]),
    ).toThrow("--recovery-reason requires non-blank text recording why the accepted pair is stale");
  });

  it("[behavior:#332:P-03] leaves both owning modules' signatures and semantics unmodified", () => {
    expect(sourceOf("exact-stage-resume.ts")).toContain(
      [
        "export function clearExactStageCheckpoint(",
        "  location: CheckpointLocation,",
        "): void {",
      ].join("\n"),
    );
    expect(sourceOf("contract-convergence.ts")).toContain(
      [
        "export function saveContractFindingLineage(",
        "  location: LineageLocation,",
        "  lineage: ContractFindingLineage,",
        "): void {",
      ].join("\n"),
    );
    // The existing consumer still consumes its checkpoint the same way.
    expect(sourceOf("exact-stage-resume.ts")).toContain(
      "  clearExactStageCheckpoint(input);\n  return { ok: true };",
    );
  });

  it("[behavior:#332:P-04] changes no live pair byte and adds no second pair-validation path", () => {
    admitPending(fixture);
    writeSliceFiles(fixture.sliceDir, NEGOTIATION_BYTES);
    const before = {
      contract: readFileSync(join(fixture.sliceDir, CONTRACT_FILENAME), "utf-8"),
      manifest: readFileSync(
        join(fixture.sliceDir, ACCEPTANCE_MANIFEST_FILENAME),
        "utf-8",
      ),
    };

    expect(execute(fixture).ok).toBe(true);

    expect(readFileSync(join(fixture.sliceDir, CONTRACT_FILENAME), "utf-8")).toBe(
      before.contract,
    );
    expect(
      readFileSync(join(fixture.sliceDir, ACCEPTANCE_MANIFEST_FILENAME), "utf-8"),
    ).toBe(before.manifest);
    // One validator, and no writer of the status line: a replacement pair still
    // reaches LOCKED only through the negotiation's own gate (ADR 0008, 0055).
    expect(occurrences(MODULE_CODE, "parseAcceptanceManifest(")).toBe(1);
    expect(occurrences(MODULE_CODE, "validateAcceptanceManifestCoverage(")).toBe(1);
    expect(MODULE_CODE).not.toContain("**Status:** LOCKED");
  }, 30_000);
});

/*
 * ---------------------------------------------------------------------------
 * Recovery rollback and the dispatch hold (#333)
 * ---------------------------------------------------------------------------
 *
 * Every case below reuses the file's one real git repo, its stubbed probes and
 * `admitPending`: restore-and-verify moves two artifact files, the rollback writer
 * appends one run-state event, and the dispatch hold reads one. None of the three
 * needs a pipeline, a provider or a second process, so no spawned scenario is
 * added — the states they need (a committed `PENDING` attempt, a reopened pair, a
 * removed snapshot file, an unwritable destination) are all reachable by writing
 * them, which is the top of the `AGENTS.md` assertion ladder rather than the
 * bottom (ADR 0063, `prd.md` Testing Decisions).
 */

/** What a reopened negotiation leaves where the accepted pair was. */
const REOPENED_CONTRACT = [
  "# Slice 07 — reopened for renegotiation",
  "",
  "**Status:** NEGOTIATING",
  "",
].join("\n");
const REOPENED_MANIFEST = '{"version":2,"behaviors":[]}\n';

const ROLLBACK_TRIGGERS: readonly RecoveryFailureTrigger[] = [
  "provider-failure",
  "evaluator-non-acceptance",
  "deterministic-validation-refusal",
  "lock-gate-refusal",
  "cancellation",
];

const PROVIDER_FAILURE: RecoveryFailure = {
  trigger: "provider-failure",
  message: "the renegotiation provider exited 1 after round 2",
};

function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** Overwrite the accepted pair the way a reopened negotiation would. */
function reopenAcceptedPair(f: Fixture): void {
  writeFileSync(join(f.sliceDir, CONTRACT_FILENAME), REOPENED_CONTRACT);
  writeFileSync(join(f.sliceDir, ACCEPTANCE_MANIFEST_FILENAME), REOPENED_MANIFEST);
}

function eventsOf(f: Fixture): readonly PersistedRecoveryLineageEvent[] {
  return recoveryLineageFor(loadRunState(f.repoRoot, PRD_SLUG), GH_ISSUE);
}

function trailingEvent(f: Fixture): PersistedRecoveryLineageEvent {
  const events = eventsOf(f);
  return events[events.length - 1]!;
}

/** The lineage as it sits in the file, so a round trip can be measured. */
function persistedLineage(f: Fixture): unknown {
  return (
    stateDocument(f).recoveryLineage as Record<string, unknown> | undefined
  )?.[GH_ISSUE];
}

function restoreFrom(f: Fixture, attempt: RecoveryAttemptLocator) {
  return restoreAcceptedPairFromSnapshot({
    repoRoot: f.repoRoot,
    sliceDir: f.sliceDir,
    attempt,
  });
}

function rollback(
  f: Fixture,
  overrides: Partial<RollBackRecoveryAttemptArgs<RecoveryFailure>> = {},
) {
  return rollBackRecoveryAttempt({
    repoRoot: f.repoRoot,
    prdSlug: PRD_SLUG,
    sliceDir: f.sliceDir,
    ghIssue: GH_ISSUE,
    failure: PROVIDER_FAILURE,
    ...overrides,
  });
}

/** A run state carrying exactly the lineage a case wants, with no disk write. */
function stateWithLineage(
  f: Fixture,
  events: PersistedRecoveryLineageEvent[],
): RunState {
  return {
    version: RUN_STATE_VERSION,
    prdSlug: PRD_SLUG,
    featureBranch: f.featureBranch,
    slices: {},
    recoveryLineage: { [GH_ISSUE]: events },
  };
}

describe("restoring the accepted pair from an attempt's snapshot", () => {
  it("[behavior:#333:B-01] rewrites both pair files from the snapshot the PENDING event names", () => {
    const attemptDir = admitPending(fixture, "attempt-restore");
    const snapshot = {
      contract: readFileSync(join(attemptDir, CONTRACT_FILENAME)),
      manifest: readFileSync(join(attemptDir, ACCEPTANCE_MANIFEST_FILENAME)),
    };
    reopenAcceptedPair(fixture);
    const event = trailingEvent(fixture);

    const result = restoreFrom(fixture, event);

    expect(result.ok).toBe(true);
    // The directory is the recorded locator resolved, not a re-derivation.
    expect(result.snapshotDir).toBe(
      join(fixture.repoRoot, ...event.snapshotPath.split("/")),
    );
    expect(result.snapshotDir).toBe(attemptDir);
    expect(
      readFileSync(join(fixture.sliceDir, CONTRACT_FILENAME)).equals(
        snapshot.contract,
      ),
    ).toBe(true);
    expect(
      readFileSync(join(fixture.sliceDir, ACCEPTANCE_MANIFEST_FILENAME)).equals(
        snapshot.manifest,
      ),
    ).toBe(true);
    // Nothing was appended: the routine restores and verifies, and records nothing.
    expect(eventsOf(fixture).map((e) => e.state)).toEqual(["PENDING"]);
  }, 30_000);

  it("[behavior:#333:B-01] reads the recorded locator even when a derived one would differ", () => {
    const attemptDir = admitPending(fixture, "attempt-recorded");
    // A second directory holding the same published bytes. Only the recorded
    // locator names it, so a routine that re-derived the path would miss it.
    const moved = join(
      fixture.sliceDir,
      RECOVERY_SNAPSHOT_DIRNAME,
      "attempt-recorded-moved",
    );
    mkdirSync(moved, { recursive: true });
    for (const name of [CONTRACT_FILENAME, ACCEPTANCE_MANIFEST_FILENAME]) {
      writeFileSync(join(moved, name), readFileSync(join(attemptDir, name)));
    }
    rmSync(attemptDir, { recursive: true, force: true });
    reopenAcceptedPair(fixture);
    const event = trailingEvent(fixture);
    const relocated: RecoveryAttemptLocator = {
      ...event,
      snapshotPath: `${event.snapshotPath}-moved`,
    };

    const result = restoreFrom(fixture, relocated);

    expect(result.ok).toBe(true);
    expect(result.snapshotDir).toBe(moved);
    expect(readLockedAcceptedPair(fixture.sliceDir)?.contract).toBe(
      LOCKED_CONTRACT,
    );
  }, 30_000);

  it("[behavior:#333:B-02] fails on the fingerprint compare when the snapshot was tampered with after publication", () => {
    const attemptDir = admitPending(fixture, "attempt-tampered");
    // Still a valid LOCKED pair, so the fingerprint compare is the check that
    // catches it — a tamper that broke validity would prove a different rule.
    const tampered = `${LOCKED_CONTRACT}A line added after publication.\n`;
    writeFileSync(join(attemptDir, CONTRACT_FILENAME), tampered);
    expect(readLockedAcceptedPair(attemptDir)).not.toBeUndefined();
    const event = trailingEvent(fixture);

    const result = restoreFrom(fixture, event);

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.message : "").toContain(
      "does not match the fingerprints attempt attempt-tampered recorded",
    );
    expect(result.observedContractFingerprint).toBe(sha256Of(tampered));
    expect(result.observedManifestFingerprint).toBe(sha256Of(ACCEPTED_MANIFEST));
    expect(event.contractFingerprint).toBe(sha256Of(LOCKED_CONTRACT));
    // No terminal event exists: the direct call records nothing at all.
    expect(eventsOf(fixture).map((e) => e.state)).toEqual(["PENDING"]);
    expect(rollback(fixture).rolledBack).toBe(false);
    expect(eventsOf(fixture).some((e) => e.state === "ROLLED_BACK")).toBe(false);
  }, 30_000);

  it("[behavior:#333:B-02] fails when the restored pair does not read back as a valid LOCKED pair", () => {
    const attemptDir = admitPending(fixture, "attempt-unlocked");
    writeFileSync(join(attemptDir, CONTRACT_FILENAME), REOPENED_CONTRACT);
    const event = trailingEvent(fixture);

    const result = restoreFrom(fixture, event);

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.message : "").toContain(
      "is not a valid LOCKED contract.md",
    );
    // Verification read the destination, not the snapshot in hand: the bytes it
    // fingerprinted are the ones now on disk.
    expect(result.observedContractFingerprint).toBe(sha256Of(REOPENED_CONTRACT));
  }, 30_000);
});

describe("rolling one admitted attempt back", () => {
  it.each(ROLLBACK_TRIGGERS)(
    "[behavior:#333:B-03] appends exactly one ROLLED_BACK event for a %s failure",
    (trigger) => {
      admitPending(fixture, `attempt-${trigger}`);
      reopenAcceptedPair(fixture);
      const before = eventsOf(fixture);
      expect(before.map((e) => e.state)).toEqual(["PENDING"]);

      const result = rollback(fixture, {
        failure: { trigger, message: `${trigger} ended the attempt` },
      });

      expect(result.rolledBack).toBe(true);
      const after = eventsOf(fixture);
      expect(after).toHaveLength(before.length + 1);
      const appended = after[after.length - 1]!;
      expect(appended.state).toBe("ROLLED_BACK");
      expect(appended.attemptId).toBe(before[0]!.attemptId);
      expect(appended.attemptId).toBe(`attempt-${trigger}`);
      // The append landed in the file the run-state lock guards, and survives a
      // reload through the validator unchanged.
      expect(result.rolledBack === true ? result.event : undefined).toEqual(
        appended,
      );
      expect(persistedLineage(fixture)).toEqual([...after]);
      // The three rollback-failure members belong to the other outcome only.
      expect(appended.rollbackError).toBeUndefined();
      expect(appended.observedContractFingerprint).toBeUndefined();
      expect(appended.observedManifestFingerprint).toBeUndefined();
      expect(readLockedAcceptedPair(fixture.sliceDir)?.contract).toBe(
        LOCKED_CONTRACT,
      );
    },
    30_000,
  );

  it("[behavior:#333:B-03] refuses with no-pending-attempt and appends nothing when no attempt is open", () => {
    const before = readFileSync(fixture.statePath, "utf-8");

    const result = rollback(fixture);

    expect(result).toMatchObject({
      rolledBack: false,
      code: "no-pending-attempt",
      failure: PROVIDER_FAILURE,
    });
    expect(readFileSync(fixture.statePath, "utf-8")).toBe(before);
  });

  it("[behavior:#333:B-04] returns the caller's failure unchanged and moves no ref, commit or worktree byte", () => {
    admitPending(fixture, "attempt-refs");
    reopenAcceptedPair(fixture);
    const failure: RecoveryFailure = {
      trigger: "cancellation",
      message: "the operator cancelled the run mid-negotiation",
    };
    const before = {
      tips: tips(fixture),
      worktree: digestTree(fixture.worktreeDir),
      status: git(fixture.repoRoot, "status", "--porcelain"),
      log: git(fixture.repoRoot, "log", "--oneline", "--all"),
    };

    const result = rollback(fixture, { failure });

    expect(result.rolledBack).toBe(true);
    // The same value, by identity: nothing re-wrapped, re-worded or re-triggered.
    expect(result.failure).toBe(failure);
    expect(result.failure).toEqual({
      trigger: "cancellation",
      message: "the operator cancelled the run mid-negotiation",
    });
    expect(tips(fixture)).toEqual(before.tips);
    expect(digestTree(fixture.worktreeDir)).toEqual(before.worktree);
    expect(git(fixture.repoRoot, "status", "--porcelain")).toBe(before.status);
    expect(git(fixture.repoRoot, "log", "--oneline", "--all")).toBe(before.log);
    // And no ref-mutating helper is reachable: the git import list is unchanged.
    const gitImport = MODULE_SOURCE.match(/import \{([^}]*)\} from "\.\/git\.js";/);
    expect(
      gitImport?.[1]
        ?.split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "")
        .sort(),
    ).toEqual(["countCommitsAhead", "hasUncommittedChanges", "isAncestor", "resolveCommit"]);
  }, 30_000);

  it("[behavior:#333:B-05] restores the pair only, leaving the published history and the cleared live files alone", () => {
    const attemptDir = admitPending(fixture, "attempt-history");
    writeSliceFiles(fixture.sliceDir, NEGOTIATION_BYTES);
    expect(execute(fixture).ok).toBe(true);
    reopenAcceptedPair(fixture);
    const history = join(attemptDir, RECOVERY_NEGOTIATION_DIRNAME);
    const before = digestTree(history);
    expect(Object.keys(before).sort()).toEqual(
      Object.keys(NEGOTIATION_BYTES).sort(),
    );
    expect(listLiveNegotiationFiles(fixture.sliceDir)).toEqual([]);

    expect(rollback(fixture).rolledBack).toBe(true);

    // Nothing execution cleared came back, and every published byte is intact.
    expect(listLiveNegotiationFiles(fixture.sliceDir)).toEqual([]);
    expect(digestTree(history)).toEqual(before);
    // The emptiness is not vacuous: neither restored filename is in the closed
    // set `listLiveNegotiationFiles` reports, so restoring them cannot re-add one.
    for (const name of [CONTRACT_FILENAME, ACCEPTANCE_MANIFEST_FILENAME]) {
      expect(existsSync(join(fixture.sliceDir, name))).toBe(true);
      expect(RECOVERY_NEGOTIATION_FILENAMES).not.toContain(name);
      expect(/^feedback-r(\d+)\.md$/.test(name)).toBe(false);
    }
    expect(readLockedAcceptedPair(fixture.sliceDir)?.manifest).toBe(
      ACCEPTED_MANIFEST,
    );
  }, 30_000);
});

describe("a rollback that cannot prove out holds instead of claiming success", () => {
  it("[behavior:#333:B-06] records the failure message and the fingerprints observed on disk", () => {
    const attemptDir = admitPending(fixture, "attempt-missing-snapshot");
    reopenAcceptedPair(fixture);
    // Two obstacles at once: an unreadable snapshot half, and a destination half
    // that is absent — which is what the explicit absent marker is for.
    rmSync(join(attemptDir, CONTRACT_FILENAME));
    rmSync(join(fixture.sliceDir, ACCEPTANCE_MANIFEST_FILENAME));

    const result = rollback(fixture);

    expect(result.rolledBack).toBe(false);
    const events = eventsOf(fixture);
    expect(events).toHaveLength(2);
    const failed = events[1]!;
    expect(failed.state).toBe("ROLLBACK_FAILED");
    expect(failed.attemptId).toBe(events[0]!.attemptId);
    expect(failed.rollbackError).toBe(
      result.rolledBack === false ? result.message : "",
    );
    expect(failed.observedContractFingerprint).toBe(sha256Of(REOPENED_CONTRACT));
    expect(failed.observedManifestFingerprint).toBe(RECOVERY_FINGERPRINT_ABSENT);
    expect(events.some((e) => e.state === "ROLLED_BACK")).toBe(false);
    expect(result).toMatchObject({
      rolledBack: false,
      code: "rollback-verification-failed",
    });
    // The event round-trips: what the file holds is what the validator returns.
    expect(persistedLineage(fixture)).toEqual([...events]);
  }, 30_000);

  it("[behavior:#333:B-06] records the absent marker when the destination itself cannot be read", () => {
    admitPending(fixture, "attempt-unwritable");
    // A directory where the file belongs: the write fails and the bytes cannot be
    // observed, which is the same answer as an absent file and is recorded as one.
    rmSync(join(fixture.sliceDir, CONTRACT_FILENAME));
    mkdirSync(join(fixture.sliceDir, CONTRACT_FILENAME));

    const result = rollback(fixture);

    expect(result.rolledBack).toBe(false);
    const failed = trailingEvent(fixture);
    expect(failed.state).toBe("ROLLBACK_FAILED");
    expect(failed.attemptId).toBe("attempt-unwritable");
    expect(failed.observedContractFingerprint).toBe(RECOVERY_FINGERPRINT_ABSENT);
    expect(failed.observedManifestFingerprint).toBe(sha256Of(ACCEPTED_MANIFEST));
    expect(failed.rollbackError).toContain(fixture.sliceDir);
    expect(eventsOf(fixture).some((e) => e.state === "ROLLED_BACK")).toBe(false);
    expect(persistedLineage(fixture)).toEqual([...eventsOf(fixture)]);
  }, 30_000);

  it("[behavior:#333:B-09] reaches the same failure identity through both entry points", () => {
    const attemptDir = admitPending(fixture, "attempt-one-routine");
    reopenAcceptedPair(fixture);
    rmSync(join(attemptDir, CONTRACT_FILENAME));

    // The direct call first: it writes nothing, so the rollback below meets the
    // identical obstacle and the identical bytes on disk.
    const direct = restoreFrom(fixture, trailingEvent(fixture));
    const result = rollback(fixture);

    expect(direct.ok).toBe(false);
    const failed = trailingEvent(fixture);
    expect(failed.state).toBe("ROLLBACK_FAILED");
    // One implementation, observed behaviourally: a second compare inside the
    // writer could not keep all three of these equal.
    expect(failed.rollbackError).toBe(direct.ok === false ? direct.message : "");
    expect(failed.observedContractFingerprint).toBe(
      direct.observedContractFingerprint,
    );
    expect(failed.observedManifestFingerprint).toBe(
      direct.observedManifestFingerprint,
    );
    expect(result.rolledBack === false ? result.message : "").toBe(
      direct.ok === false ? direct.message : "",
    );
  }, 30_000);
});

describe("the dispatch hold a failed rollback leaves behind", () => {
  function failedLineage(f: Fixture): PersistedRecoveryLineageEvent[] {
    const attemptDir = admitPending(f, "attempt-hold");
    rmSync(join(attemptDir, CONTRACT_FILENAME));
    rmSync(join(f.sliceDir, CONTRACT_FILENAME));
    expect(rollback(f).rolledBack).toBe(false);
    return [...eventsOf(f)];
  }

  it("[behavior:#333:B-07] refuses dispatch naming the attempt and its snapshot", () => {
    const events = failedLineage(fixture);
    const failed = events[events.length - 1]!;
    expect(failed.state).toBe("ROLLBACK_FAILED");

    const refusal = recoveryDispatchRefusal(
      stateWithLineage(fixture, events),
      GH_ISSUE,
    );

    expect(refusal).not.toBeUndefined();
    expect(refusal!.message).toContain(failed.attemptId);
    expect(refusal!.message).toContain(failed.snapshotPath);
    expect(refusal!.attemptId).toBe(failed.attemptId);
    expect(refusal!.snapshotPath).toBe(failed.snapshotPath);
    expect(refusal!.code).toBe("rollback-failed-hold");
  }, 30_000);

  it.each(["PENDING", "ROLLED_BACK", "COMPLETED"] as const)(
    "[behavior:#333:B-07] returns undefined when the last event is %s",
    (state) => {
      const events = failedLineage(fixture);
      const resolved: PersistedRecoveryLineageEvent = {
        ...events[0]!,
        state,
      };

      expect(
        recoveryDispatchRefusal(
          stateWithLineage(fixture, [...events, resolved]),
          GH_ISSUE,
        ),
      ).toBeUndefined();
      // And a target with no lineage at all is not held either.
      expect(
        recoveryDispatchRefusal(stateWithLineage(fixture, events), "278"),
      ).toBeUndefined();
    },
    30_000,
  );

  it("[behavior:#333:B-07] is imported by no module outside this one and its test", () => {
    const exports = [
      "recoveryDispatchRefusal",
      "rollBackRecoveryAttempt",
      "restoreAcceptedPairFromSnapshot",
    ];
    const consumers = readdirSync("src")
      .filter((name) => name.endsWith(".ts"))
      .filter(
        (name) =>
          name !== "preserve-work-recovery.ts" &&
          name !== "preserve-work-recovery.test.ts",
      )
      .filter((name) => {
        const source = sourceOf(name);
        return exports.some((symbol) => source.includes(symbol));
      });

    expect(consumers).toEqual([]);
  });
});

describe("retrying a failed rollback", () => {
  it("[behavior:#333:B-08] appends ROLLED_BACK for the same attempt once the obstacle is gone", () => {
    const attemptDir = admitPending(fixture, "attempt-retry");
    reopenAcceptedPair(fixture);
    const published = readFileSync(join(attemptDir, CONTRACT_FILENAME));
    rmSync(join(attemptDir, CONTRACT_FILENAME));
    expect(rollback(fixture).rolledBack).toBe(false);
    const beforeRetry = [...eventsOf(fixture)];
    expect(beforeRetry.map((e) => e.state)).toEqual([
      "PENDING",
      "ROLLBACK_FAILED",
    ]);

    writeFileSync(join(attemptDir, CONTRACT_FILENAME), published);
    const retry = rollback(fixture);

    expect(retry.rolledBack).toBe(true);
    const after = eventsOf(fixture);
    expect(after).toHaveLength(3);
    expect(after[2]!.state).toBe("ROLLED_BACK");
    expect(after[2]!.attemptId).toBe(beforeRetry[1]!.attemptId);
    // Append-only: every earlier record is still exactly what it was, at its
    // original index — nothing was edited or deleted.
    expect(after[0]).toEqual(beforeRetry[0]);
    expect(after[1]).toEqual(beforeRetry[1]);
    // And the ROLLED_BACK record does not inherit the failure's observations.
    expect(after[2]!.rollbackError).toBeUndefined();
    expect(after[2]!.observedContractFingerprint).toBeUndefined();
  }, 30_000);

  it("[behavior:#333:B-08] refuses every other outbound transition from ROLLBACK_FAILED", () => {
    for (const to of ["PENDING", "COMPLETED", "ROLLBACK_FAILED"] as const) {
      expect(isLegalRecoveryTransition("ROLLBACK_FAILED", to)).toBe(false);
    }
    expect(isLegalRecoveryTransition("ROLLBACK_FAILED", "ROLLED_BACK")).toBe(true);

    const attemptDir = admitPending(fixture, "attempt-refailed");
    rmSync(join(attemptDir, CONTRACT_FILENAME));
    expect(rollback(fixture).rolledBack).toBe(false);
    const afterFirst = [...eventsOf(fixture)];

    // A retry that fails again appends nothing: the hold already recorded is the
    // record, and a second ROLLBACK_FAILED is not a legal transition.
    const again = rollback(fixture);

    expect(again.rolledBack).toBe(false);
    expect(again.rolledBack === false ? again.event : undefined).toBeUndefined();
    expect(eventsOf(fixture)).toEqual(afterFirst);
  }, 30_000);

  it("[behavior:#333:B-08] admits a fresh attempt afterwards with a different id and snapshot", () => {
    admitPending(fixture, "attempt-first");
    reopenAcceptedPair(fixture);
    expect(rollback(fixture).rolledBack).toBe(true);
    const rolledBack = trailingEvent(fixture);

    const second = admit(fixture);

    expect(second.admitted).toBe(true);
    const fresh = trailingEvent(fixture);
    expect(fresh.state).toBe("PENDING");
    expect(fresh.attemptId).not.toBe(rolledBack.attemptId);
    expect(fresh.snapshotPath).not.toBe(rolledBack.snapshotPath);
    expect(listPublishedPairSnapshots(fixture.sliceDir).sort()).toEqual(
      ["attempt-first", fresh.attemptId].sort(),
    );
    // No second PENDING for the earlier attempt: the retry is a new attempt id.
    expect(
      eventsOf(fixture).filter(
        (e) => e.state === "PENDING" && e.attemptId === "attempt-first",
      ),
    ).toHaveLength(1);
  }, 30_000);
});

describe("what the rollback outcomes must not disturb", () => {
  it("[behavior:#333:P-01] moves no ref across the rollback, rollback-failure and refusal paths", () => {
    const attemptDir = admitPending(fixture, "attempt-no-refs");
    const before = tips(fixture);

    // Path 1: a verified rollback.
    reopenAcceptedPair(fixture);
    expect(rollback(fixture).rolledBack).toBe(true);
    // Path 2: a failed rollback.
    admit(fixture, { attemptId: "attempt-no-refs-2" });
    rmSync(
      join(
        fixture.sliceDir,
        RECOVERY_SNAPSHOT_DIRNAME,
        "attempt-no-refs-2",
        CONTRACT_FILENAME,
      ),
    );
    expect(rollback(fixture).rolledBack).toBe(false);
    // Path 3: the dispatch refusal.
    expect(
      recoveryDispatchRefusal(loadRunState(fixture.repoRoot, PRD_SLUG), GH_ISSUE),
    ).not.toBeUndefined();

    expect(tips(fixture)).toEqual(before);
    expect(existsSync(attemptDir)).toBe(true);
    // No ref-mutating helper is even nameable in the module's code.
    for (const forbidden of [
      "merge(",
      "resetHard",
      "rebase",
      "cherryPick",
      "checkoutBranch",
      "deleteBranch",
      "worktree-processes",
    ]) {
      expect(MODULE_CODE).not.toContain(forbidden);
    }
  }, 30_000);

  it("[behavior:#333:P-02] leaves executeRecoveryAttempt's four outcomes unchanged", () => {
    const attemptDir = admitPending(fixture, "attempt-preserved-exec");
    writeSliceFiles(fixture.sliceDir, NEGOTIATION_BYTES);
    seedNegotiationControls(fixture);
    const live = listLiveNegotiationFiles(fixture.sliceDir);
    expect(live).toHaveLength(7);

    const outcome = execute(fixture);

    expect(outcome).toMatchObject({ ok: true, movedFiles: live });
    // 1. The published history holds every copied file, byte for byte.
    const history = digestTree(join(attemptDir, RECOVERY_NEGOTIATION_DIRNAME));
    expect(Object.keys(history).sort()).toEqual([...live].sort());
    for (const [name, body] of Object.entries(NEGOTIATION_BYTES)) {
      expect(history[name]).toBe(sha256Of(body));
    }
    // 2. Exactly the copied set was deleted.
    expect(listLiveNegotiationFiles(fixture.sliceDir)).toEqual([]);
    // 3. and 4. The two cleared controls.
    expect(GH_ISSUE in checkpointsOf(fixture)).toBe(false);
    expect(lineageOf(fixture, GH_ISSUE)).toEqual(emptyContractFindingLineage());
  }, 30_000);

  it("[behavior:#333:P-03] appends only through the state-shaped writer, and adds no second one", () => {
    admitPending(fixture, "attempt-append-only");
    reopenAcceptedPair(fixture);
    const before = [...eventsOf(fixture)];

    expect(rollback(fixture).rolledBack).toBe(true);

    const after = eventsOf(fixture);
    before.forEach((event, index) => {
      expect(after[index]).toEqual(event);
    });
    expect(after).toHaveLength(before.length + 1);
    // Run state exports exactly the two recovery-lineage seams it did, plus the
    // one additive constant #333's persisted shape needs. The comparison is
    // scoped to recovery names on purpose: an unrelated export from another
    // slice's merge is not this behavior's business.
    expect(
      Object.keys(runStateModule)
        .filter((name) => /recovery/i.test(name))
        .sort(),
    ).toEqual([
      "RECOVERY_FINGERPRINT_ABSENT",
      "appendRecoveryLineageEvent",
      "recoveryLineageFor",
    ]);
    // And the one writer still takes a loaded state, not a repo root.
    expect(sourceOf("run-state.ts")).toContain(
      [
        "export function appendRecoveryLineageEvent(",
        "  state: RunState,",
        "  ghIssue: string,",
        "  event: PersistedRecoveryLineageEvent,",
        "): void {",
      ].join("\n"),
    );
    // Three call sites, one per writer: admission's `PENDING`, the rollback's
    // terminal event, and #335's `COMPLETED`. The claim is one append per
    // transaction, not a frozen number.
    expect(occurrences(MODULE_CODE, "appendRecoveryLineageEvent(")).toBe(3);
    expect(occurrences(MODULE_CODE, "transactRunState<")).toBe(3);
  }, 30_000);

  it("[behavior:#333:P-05] keeps the transition map and all five existing seams as they were", () => {
    const expected: Record<RecoveryLineageState, RecoveryLineageState[]> = {
      PENDING: ["COMPLETED", "ROLLED_BACK", "ROLLBACK_FAILED"],
      COMPLETED: [],
      ROLLED_BACK: [],
      ROLLBACK_FAILED: ["ROLLED_BACK"],
    };
    const states = Object.keys(expected) as RecoveryLineageState[];
    for (const from of states) {
      for (const to of states) {
        expect(isLegalRecoveryTransition(from, to)).toBe(
          expected[from].includes(to),
        );
      }
    }

    // The five seams, re-asserted on a seeded fixture at their current results.
    const pair = readLockedAcceptedPair(fixture.sliceDir);
    expect(pair).toMatchObject({
      contract: LOCKED_CONTRACT,
      manifest: ACCEPTED_MANIFEST,
      contractFingerprint: sha256Of(LOCKED_CONTRACT),
      manifestFingerprint: sha256Of(ACCEPTED_MANIFEST),
    });
    const publication = publishAcceptedPairSnapshot({
      repoRoot: fixture.repoRoot,
      sliceDir: fixture.sliceDir,
      attemptId: "attempt-seams",
    });
    expect(publication).toMatchObject({
      ok: true,
      snapshot: {
        locator:
          `.kiro/specs/${PRD_SLUG}/slices/07-fixture/` +
          `${RECOVERY_SNAPSHOT_DIRNAME}/attempt-seams`,
        contractFingerprint: sha256Of(LOCKED_CONTRACT),
      },
    });
    expect(
      hasOpenRecoveryAttempt(loadRunState(fixture.repoRoot, PRD_SLUG), GH_ISSUE),
    ).toBe(false);
    const admission = admit(fixture, { attemptId: "attempt-seams-2" });
    expect(admission).toMatchObject({ admitted: true, attemptId: "attempt-seams-2" });
    expect(
      hasOpenRecoveryAttempt(loadRunState(fixture.repoRoot, PRD_SLUG), GH_ISSUE),
    ).toBe(true);
  }, 30_000);
});

/*
 * ---------------------------------------------------------------------------
 * Launch-time reconciliation of unresolved attempts (#334)
 * ---------------------------------------------------------------------------
 * Every claim below is about what `reconcileRecoveryLineage` reads off one
 * run-state file and writes back, so it is asserted as a unit test on the
 * fixture repository already built for this file. The one claim that cannot be
 * made here — that the call happens *before* run-scope resolution, resume and
 * dispatch — is about ordering at the orchestrator seam, which no written state
 * can show, so it lives on a single `runPipeline` in
 * `src/resume-integration.test.ts` (`AGENTS.md` assertion ladder, ADR 0063).
 *
 * Targets are planted with their own artifact directories rather than reusing
 * the fixture's, because reconciliation's subject is a *set* of targets and the
 * order it reports them in is part of the contract.
 */

/** The artifact directory a planted reconciliation target owns. */
function targetSliceDir(f: Fixture, ghIssue: string): string {
  return join(f.repoRoot, ".kiro", "specs", PRD_SLUG, "slices", `${ghIssue}-target`);
}

/** Overwrite an arbitrary directory's pair the way a reopened negotiation would. */
function reopenPairAt(dir: string): void {
  writeFileSync(join(dir, CONTRACT_FILENAME), REOPENED_CONTRACT);
  writeFileSync(join(dir, ACCEPTANCE_MANIFEST_FILENAME), REOPENED_MANIFEST);
}

/** A complete lineage event, valid enough to survive a run-state round trip. */
function plantedEvent(opts: {
  ghIssue: string;
  attemptId: string;
  snapshotPath: string;
  state: RecoveryLineageState;
}): PersistedRecoveryLineageEvent {
  return {
    attemptId: opts.attemptId,
    state: opts.state,
    target: { number: CANONICAL_SLICE_NUMBER, ghIssue: opts.ghIssue },
    reason: "the accepted pair went stale before the process died",
    extensions: [],
    provider: PROVIDER,
    sliceBranch: SLICE_BRANCH,
    sliceHead: "a".repeat(40),
    featureHead: "b".repeat(40),
    scopeFingerprint: "c".repeat(64),
    snapshotPath: opts.snapshotPath,
    contractFingerprint: sha256Of(LOCKED_CONTRACT),
    manifestFingerprint: sha256Of(ACCEPTED_MANIFEST),
    recordedAt: "2026-09-14T00:00:00.000Z",
    // Required on `ROLLBACK_FAILED` and forbidden everywhere else, so they are
    // added by state rather than always (`sanitizeRecoveryLineage`).
    ...(opts.state === "ROLLBACK_FAILED"
      ? {
          rollbackError: "an earlier rollback could not read the snapshot",
          observedContractFingerprint: sha256Of(REOPENED_CONTRACT),
          observedManifestFingerprint: RECOVERY_FINGERPRINT_ABSENT,
        }
      : {}),
  };
}

interface PlantedTarget {
  ghIssue: string;
  attemptId: string;
  sliceDir: string;
  snapshotDir: string;
  events: PersistedRecoveryLineageEvent[];
}

/**
 * One target with its own artifact directory, a real published snapshot and a
 * lineage ending on `trailing`. `snapshotPath` overrides the recorded locator so
 * a malformed one can be planted without publishing anything malformed.
 */
function plantTarget(
  f: Fixture,
  opts: {
    ghIssue: string;
    attemptId: string;
    trailing?: RecoveryLineageState;
    snapshotPath?: string;
  },
): PlantedTarget {
  const sliceDir = targetSliceDir(f, opts.ghIssue);
  rmSync(sliceDir, { recursive: true, force: true });
  writeAcceptedPair(sliceDir);
  const published = publishAcceptedPairSnapshot({
    repoRoot: f.repoRoot,
    sliceDir,
    attemptId: opts.attemptId,
  });
  expect(published.ok).toBe(true);
  const snapshotPath =
    opts.snapshotPath ?? (published.ok ? published.snapshot.locator : "");
  const events = [
    plantedEvent({
      ghIssue: opts.ghIssue,
      attemptId: opts.attemptId,
      snapshotPath,
      state: "PENDING",
    }),
  ];
  const trailing = opts.trailing ?? "PENDING";
  if (trailing !== "PENDING") {
    events.push(
      plantedEvent({
        ghIssue: opts.ghIssue,
        attemptId: opts.attemptId,
        snapshotPath,
        state: trailing,
      }),
    );
  }
  return {
    ghIssue: opts.ghIssue,
    attemptId: opts.attemptId,
    sliceDir,
    snapshotDir: join(sliceDir, RECOVERY_SNAPSHOT_DIRNAME, opts.attemptId),
    events,
  };
}

/** Replace the run-state file's whole lineage map, in the given key order. */
function writeLineage(f: Fixture, targets: PlantedTarget[]): void {
  const document = stateDocument(f);
  const lineage: Record<string, PersistedRecoveryLineageEvent[]> = {};
  for (const target of targets) lineage[target.ghIssue] = target.events;
  document.recoveryLineage = lineage;
  writeFileSync(f.statePath, `${JSON.stringify(document, null, 2)}\n`);
}

function reconcile(f: Fixture) {
  return reconcileRecoveryLineage({ repoRoot: f.repoRoot, prdSlug: PRD_SLUG });
}

function lineageOfTarget(
  f: Fixture,
  ghIssue: string,
): readonly PersistedRecoveryLineageEvent[] {
  return recoveryLineageFor(loadRunState(f.repoRoot, PRD_SLUG), ghIssue);
}

/** One target's lineage as it sits in the file, so a round trip can be measured. */
function persistedLineageOf(f: Fixture, ghIssue: string): unknown {
  return (
    stateDocument(f).recoveryLineage as Record<string, unknown> | undefined
  )?.[ghIssue];
}

describe("which targets a launch reconciles", () => {
  it("[behavior:#334:B-01] reports only the unresolved targets, ordered by ghIssue", () => {
    const pending = plantTarget(fixture, {
      ghIssue: "9",
      attemptId: "attempt-nine",
    });
    const held = plantTarget(fixture, {
      ghIssue: "88",
      attemptId: "attempt-eighty-eight",
      trailing: "ROLLBACK_FAILED",
    });
    const terminal = plantTarget(fixture, {
      ghIssue: "1001",
      attemptId: "attempt-thousand",
      trailing: "ROLLED_BACK",
    });
    // Written in reverse, though the keys are integer-like so the object
    // enumerates them ascending regardless. That is exactly why the routine
    // sorts explicitly: "1001" < "88" < "9" lexicographically, so a plain
    // `.sort()` over the keys would invert the order the log lines promise.
    writeLineage(fixture, [terminal, held, pending]);
    expect(["1001", "88", "9"].sort()).toEqual(["1001", "88", "9"]);
    for (const target of [pending, held, terminal]) reopenPairAt(target.sliceDir);
    const terminalBefore = [...lineageOfTarget(fixture, "1001")];

    const outcomes = reconcile(fixture);

    expect(outcomes.map((o) => o.ghIssue)).toEqual(["9", "88"]);
    expect(outcomes.map((o) => o.trailingState)).toEqual([
      "PENDING",
      "ROLLBACK_FAILED",
    ]);
    expect(outcomes[0]).toMatchObject({
      ghIssue: "9",
      attemptId: "attempt-nine",
      appended: "ROLLED_BACK",
      snapshotPath: pending.events[0]!.snapshotPath,
      snapshotDir: pending.snapshotDir,
      sliceDir: pending.sliceDir,
      locatorRejected: false,
      runStateFile: fixture.statePath,
    });
    expect(outcomes[1]).toMatchObject({
      ghIssue: "88",
      attemptId: "attempt-eighty-eight",
      appended: "ROLLED_BACK",
    });
    // The terminal target was not touched at all: no event, and its reopened
    // pair is still reopened because no restore ran for it.
    expect(lineageOfTarget(fixture, "1001")).toEqual(terminalBefore);
    expect(readFileSync(join(terminal.sliceDir, CONTRACT_FILENAME), "utf-8")).toBe(
      REOPENED_CONTRACT,
    );
    // A trailing ROLLBACK_FAILED whose snapshot now verifies clears the hold.
    expect(
      recoveryDispatchRefusal(loadRunState(fixture.repoRoot, PRD_SLUG), "88"),
    ).toBeUndefined();
  }, 30_000);
});

describe("what a reconciled target appends", () => {
  it("[behavior:#334:B-02] appends ROLLED_BACK on a verified restore and ROLLBACK_FAILED with both observations otherwise", () => {
    const verified = plantTarget(fixture, {
      ghIssue: "101",
      attemptId: "attempt-verified",
    });
    const failing = plantTarget(fixture, {
      ghIssue: "102",
      attemptId: "attempt-failing",
    });
    const refailing = plantTarget(fixture, {
      ghIssue: "103",
      attemptId: "attempt-refailing",
      trailing: "ROLLBACK_FAILED",
    });
    writeLineage(fixture, [verified, failing, refailing]);
    const snapshot = {
      contract: readFileSync(join(verified.snapshotDir, CONTRACT_FILENAME)),
      manifest: readFileSync(
        join(verified.snapshotDir, ACCEPTANCE_MANIFEST_FILENAME),
      ),
    };
    for (const target of [verified, failing, refailing]) {
      reopenPairAt(target.sliceDir);
    }
    // Two obstacles for #102: an unreadable snapshot half and an absent
    // destination half, which is what the explicit absent marker is for.
    rmSync(join(failing.snapshotDir, CONTRACT_FILENAME));
    rmSync(join(failing.sliceDir, ACCEPTANCE_MANIFEST_FILENAME));
    rmSync(join(refailing.snapshotDir, CONTRACT_FILENAME));
    // The direct restore first: it writes nothing when the snapshot cannot be
    // read, so reconciliation below meets the identical bytes on disk.
    const direct = restoreAcceptedPairFromSnapshot({
      repoRoot: fixture.repoRoot,
      sliceDir: failing.sliceDir,
      attempt: failing.events[0]!,
    });
    expect(direct.ok).toBe(false);

    const outcomes = reconcile(fixture);

    expect(outcomes.map((o) => o.appended)).toEqual([
      "ROLLED_BACK",
      "ROLLBACK_FAILED",
      "none",
    ]);

    // #101 — one ROLLED_BACK for the same attempt, pair byte-restored.
    const restored = lineageOfTarget(fixture, "101");
    expect(restored.map((e) => e.state)).toEqual(["PENDING", "ROLLED_BACK"]);
    expect(restored[1]!.attemptId).toBe("attempt-verified");
    expect(restored[0]).toEqual(verified.events[0]);
    expect(restored[1]!.rollbackError).toBeUndefined();
    expect(
      readFileSync(join(verified.sliceDir, CONTRACT_FILENAME)).equals(
        snapshot.contract,
      ),
    ).toBe(true);
    expect(
      readFileSync(join(verified.sliceDir, ACCEPTANCE_MANIFEST_FILENAME)).equals(
        snapshot.manifest,
      ),
    ).toBe(true);
    expect(persistedLineageOf(fixture, "101")).toEqual([...restored]);

    // #102 — exactly one ROLLBACK_FAILED carrying the failure and both
    // observations, the absent half as the marker rather than as a blank.
    const failed = lineageOfTarget(fixture, "102");
    expect(failed.map((e) => e.state)).toEqual(["PENDING", "ROLLBACK_FAILED"]);
    expect(failed[1]!.attemptId).toBe("attempt-failing");
    expect(failed[1]!.rollbackError).toBe(direct.ok === false ? direct.message : "");
    expect(failed[1]!.observedContractFingerprint).toBe(
      sha256Of(REOPENED_CONTRACT),
    );
    expect(failed[1]!.observedManifestFingerprint).toBe(
      RECOVERY_FINGERPRINT_ABSENT,
    );
    expect(outcomes[1]!.message).toBe(failed[1]!.rollbackError);
    // The destination pair is left as it was: the reopened contract survived and
    // the absent manifest was not invented.
    expect(readFileSync(join(failing.sliceDir, CONTRACT_FILENAME), "utf-8")).toBe(
      REOPENED_CONTRACT,
    );
    expect(
      existsSync(join(failing.sliceDir, ACCEPTANCE_MANIFEST_FILENAME)),
    ).toBe(false);
    expect(persistedLineageOf(fixture, "102")).toEqual([...failed]);

    // #103 — a retry that failed again appends nothing at all.
    expect(lineageOfTarget(fixture, "103")).toEqual(refailing.events);
    expect(outcomes[2]!.message).toContain("not a legal recovery transition");
  }, 30_000);

  it("[behavior:#334:B-02] reuses #333's restore and append rather than adding a second of either", () => {
    // Behavioural evidence that one sequence runs is #333 B-09's; this is the
    // structural half: the module still holds exactly one restore call site
    // inside one rollback writer, and reconciliation calls that writer.
    // Still exactly one restore call site, inside the one rollback writer: #335
    // added a completion path that delegates to that writer rather than a second
    // restore. The append, transaction and transition counters each gained the
    // completion's one call site (#335 B-02) and nothing else.
    expect(occurrences(MODULE_CODE, "restoreAcceptedPairFromSnapshot(")).toBe(2);
    expect(occurrences(MODULE_CODE, "appendRecoveryLineageEvent(")).toBe(3);
    expect(occurrences(MODULE_CODE, "transactRunState<")).toBe(3);
    expect(occurrences(MODULE_CODE, "isLegalRecoveryTransition(")).toBe(3);
    // One rollback writer, called from exactly two places in this module —
    // reconciliation and the completion. Both added a call, not a second writer.
    expect(MODULE_CODE).toContain(
      "export function rollBackRecoveryAttempt<F extends RecoveryFailure>(",
    );
    expect(occurrences(MODULE_CODE, "rollBackRecoveryAttempt(")).toBe(2);
  });
});

describe("the snapshot locator shapes reconciliation accepts", () => {
  it("[behavior:#334:B-03] restores only from <sliceDir>/recovery-snapshots/<attemptId> and never at the repository root", () => {
    const rootContract = "# repository-root contract, planted\n";
    const rootManifest = '{"version":2,"planted":true}\n';
    writeFileSync(join(fixture.repoRoot, CONTRACT_FILENAME), rootContract);
    writeFileSync(
      join(fixture.repoRoot, ACCEPTANCE_MANIFEST_FILENAME),
      rootManifest,
    );
    const wellFormed = plantTarget(fixture, {
      ghIssue: "201",
      attemptId: "attempt-well-formed",
    });
    const twoSegment = plantTarget(fixture, {
      ghIssue: "202",
      attemptId: "attempt-two-segment",
      snapshotPath: `${RECOVERY_SNAPSHOT_DIRNAME}/attempt-two-segment`,
    });
    const wrongDirname = plantTarget(fixture, {
      ghIssue: "203",
      attemptId: "attempt-wrong-dirname",
      snapshotPath: `.kiro/specs/${PRD_SLUG}/slices/203-target/snapshots/attempt-wrong-dirname`,
    });
    const singleSegment = plantTarget(fixture, {
      ghIssue: "204",
      attemptId: "attempt-single-segment",
      snapshotPath: "attempt-single-segment",
    });
    const rejected = [twoSegment, wrongDirname, singleSegment];
    writeLineage(fixture, [wellFormed, ...rejected]);
    for (const target of [wellFormed, ...rejected]) reopenPairAt(target.sliceDir);
    const rootEntriesBefore = readdirSync(fixture.repoRoot).sort();

    const outcomes = reconcile(fixture);

    // The well-formed locator resolved to the grandparent of the snapshot
    // directory, which is the target's artifact directory, and restored there.
    expect(outcomes[0]).toMatchObject({
      ghIssue: "201",
      appended: "ROLLED_BACK",
      locatorRejected: false,
    });
    expect(outcomes[0]!.sliceDir).toBe(
      dirname(
        dirname(
          join(
            fixture.repoRoot,
            ...wellFormed.events[0]!.snapshotPath.split("/"),
          ),
        ),
      ),
    );
    expect(outcomes[0]!.sliceDir).toBe(wellFormed.sliceDir);
    expect(readLockedAcceptedPair(wellFormed.sliceDir)?.contract).toBe(
      LOCKED_CONTRACT,
    );

    // Every other locator: no restore, no append, and a report naming both the
    // locator and the destination it would have derived.
    for (const target of rejected) {
      const outcome = outcomes.find((o) => o.ghIssue === target.ghIssue)!;
      const locator = target.events[0]!.snapshotPath;
      expect(outcome).toMatchObject({
        appended: "none",
        locatorRejected: true,
        snapshotPath: locator,
      });
      expect(outcome.sliceDir).toBe(
        dirname(dirname(join(fixture.repoRoot, ...locator.split("/")))),
      );
      expect(outcome.message).toContain(locator);
      expect(outcome.message).toContain(outcome.sliceDir);
      expect(lineageOfTarget(fixture, target.ghIssue)).toEqual(target.events);
      // Nothing was read or written at the destination either: the reopened pair
      // planted in the target's own directory is untouched.
      expect(readFileSync(join(target.sliceDir, CONTRACT_FILENAME), "utf-8")).toBe(
        REOPENED_CONTRACT,
      );
    }
    // The two-segment case is the one B-07 cannot catch: its derived destination
    // is the repository root, where two accepted-pair files really do live.
    const collapsed = outcomes.find((o) => o.ghIssue === "202")!;
    expect(collapsed.sliceDir).toBe(fixture.repoRoot);
    expect(collapsed.message).toContain("the empty string");
    expect(readFileSync(join(fixture.repoRoot, CONTRACT_FILENAME), "utf-8")).toBe(
      rootContract,
    );
    expect(
      readFileSync(join(fixture.repoRoot, ACCEPTANCE_MANIFEST_FILENAME), "utf-8"),
    ).toBe(rootManifest);
    expect(readdirSync(fixture.repoRoot).sort()).toEqual(rootEntriesBefore);

    rmSync(join(fixture.repoRoot, CONTRACT_FILENAME));
    rmSync(join(fixture.repoRoot, ACCEPTANCE_MANIFEST_FILENAME));
  }, 30_000);
});

describe("the operator line each reconciled outcome needs", () => {
  it("[behavior:#334:B-05] names the target, the outcome and the retry fixed for that outcome", () => {
    const base = {
      ghIssue: "301",
      attemptId: "attempt-line",
      trailingState: "PENDING" as const,
      snapshotPath: `.kiro/specs/${PRD_SLUG}/slices/301-target/${RECOVERY_SNAPSHOT_DIRNAME}/attempt-line`,
      snapshotDir: join(targetSliceDir(fixture, "301"), RECOVERY_SNAPSHOT_DIRNAME, "attempt-line"),
      sliceDir: targetSliceDir(fixture, "301"),
      locatorRejected: false,
      runStateFile: fixture.statePath,
    };

    const rolledBack = describeRecoveryReconciliation({
      ...base,
      appended: "ROLLED_BACK",
    });
    const failed = describeRecoveryReconciliation({
      ...base,
      appended: "ROLLBACK_FAILED",
      message: "the snapshot contract.md could not be read",
    });
    const refailed = describeRecoveryReconciliation({
      ...base,
      trailingState: "ROLLBACK_FAILED",
      appended: "none",
      message: "the retry hit the same unreadable snapshot",
    });
    const unusable = describeRecoveryReconciliation({
      ...base,
      appended: "none",
      locatorRejected: true,
      message: 'the locator "recovery-snapshots/attempt-line" is not of the form',
    });

    // One line each, so one `logger.phase` call is one operator-facing line.
    for (const line of [rolledBack, failed, refailed, unusable]) {
      expect(line).not.toContain("\n");
      expect(line).toContain("attempt-line");
      expect(line).toContain("#301");
    }
    expect(rolledBack).toContain("ROLLED_BACK");
    expect(rolledBack).toContain("relaunch the same command");
    expect(failed).toContain("ROLLBACK_FAILED");
    expect(failed).toContain(`repair the snapshot directory ${base.snapshotDir}`);
    expect(failed).toContain(CONTRACT_FILENAME);
    expect(failed).toContain(ACCEPTANCE_MANIFEST_FILENAME);
    expect(failed).toContain("then relaunch");
    // Both append-nothing families say the hold is terminal until #335 and name
    // the run-state file and the attempt, because no relaunch can move them.
    for (const line of [refailed, unusable]) {
      expect(line).toContain("nothing was appended");
      expect(line).toContain("terminal until #335");
      expect(line).toContain(fixture.statePath);
      expect(line).toContain("report the same target and stop again");
    }
    expect(refailed).toContain("the retry failed again");
    expect(refailed).toContain(`repair the snapshot directory ${base.snapshotDir}`);
    expect(unusable).toContain("unusable");
    expect(unusable).toContain("attempt-state reporting");
  });
});

describe("what reconciliation may not disturb", () => {
  it("[behavior:#334:B-06] appends nothing for a re-failed retry and never writes inside a snapshot", () => {
    const refailing = plantTarget(fixture, {
      ghIssue: "601",
      attemptId: "attempt-refailed-again",
      trailing: "ROLLBACK_FAILED",
    });
    writeLineage(fixture, [refailing]);
    reopenPairAt(refailing.sliceDir);
    rmSync(join(refailing.snapshotDir, CONTRACT_FILENAME));
    const snapshotBefore = digestTree(refailing.snapshotDir);
    const lineageBefore = [...lineageOfTarget(fixture, "601")];

    const outcomes = reconcile(fixture);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      appended: "none",
      trailingState: "ROLLBACK_FAILED",
      attemptId: "attempt-refailed-again",
    });
    // ROLLBACK_FAILED -> ROLLBACK_FAILED is illegal, so the hold already
    // recorded stays the record — event for event, at its original index.
    expect(isLegalRecoveryTransition("ROLLBACK_FAILED", "ROLLBACK_FAILED")).toBe(
      false,
    );
    const after = lineageOfTarget(fixture, "601");
    expect(after).toEqual(lineageBefore);
    expect(after[after.length - 1]!.attemptId).toBe("attempt-refailed-again");
    expect(digestTree(refailing.snapshotDir)).toEqual(snapshotBefore);
    expect(
      recoveryDispatchRefusal(loadRunState(fixture.repoRoot, PRD_SLUG), "601")
        ?.code,
    ).toBe("rollback-failed-hold");
  }, 30_000);

  it("[behavior:#334:B-06] leaves a ROLLED_BACK target free to admit a brand-new attempt", () => {
    const snapshotDir = admitPending(fixture, "attempt-before-reconcile");
    reopenAcceptedPair(fixture);
    const snapshotBefore = digestTree(snapshotDir);

    expect(reconcile(fixture)[0]).toMatchObject({
      ghIssue: GH_ISSUE,
      appended: "ROLLED_BACK",
    });

    expect(eventsOf(fixture).map((e) => e.state)).toEqual([
      "PENDING",
      "ROLLED_BACK",
    ]);
    expect(hasOpenRecoveryAttempt(loadRunState(fixture.repoRoot, PRD_SLUG), GH_ISSUE)).toBe(
      false,
    );

    const admission = admit(fixture);
    expect(admission.admitted).toBe(true);
    const minted = admission.admitted ? admission.attemptId : "";
    expect(minted).not.toBe("attempt-before-reconcile");
    expect(
      existsSync(join(fixture.sliceDir, RECOVERY_SNAPSHOT_DIRNAME, minted)),
    ).toBe(true);
    // The prior attempt's snapshot is still exactly what it was.
    expect(digestTree(snapshotDir)).toEqual(snapshotBefore);
    expect(eventsOf(fixture).map((e) => e.attemptId)).toEqual([
      "attempt-before-reconcile",
      "attempt-before-reconcile",
      minted,
    ]);
  }, 30_000);

  it("[behavior:#334:B-07] runs no git command: every ref, commit and worktree file survives", () => {
    admitPending(fixture, "attempt-no-git");
    reopenAcceptedPair(fixture);
    const before = {
      tips: tips(fixture),
      graph: git(fixture.repoRoot, "log", "--oneline", "--all"),
      status: git(fixture.repoRoot, "status", "--porcelain"),
      branches: git(fixture.repoRoot, "branch", "--list"),
      worktree: digestTree(fixture.worktreeDir),
    };

    expect(reconcile(fixture)[0]!.appended).toBe("ROLLED_BACK");

    expect(tips(fixture)).toEqual(before.tips);
    expect(git(fixture.repoRoot, "log", "--oneline", "--all")).toBe(before.graph);
    expect(git(fixture.repoRoot, "status", "--porcelain")).toBe(before.status);
    expect(git(fixture.repoRoot, "branch", "--list")).toBe(before.branches);
    expect(digestTree(fixture.worktreeDir)).toEqual(before.worktree);
    // The slice branch still carries the preserved work it was admitted with.
    expect(
      git(fixture.repoRoot, "show", `${SLICE_BRANCH}:slice.txt`),
    ).toBe("preserved work");
  }, 30_000);
});

describe("what a launch with nothing to reconcile does", () => {
  it("[behavior:#334:P-01] still refuses --renegotiate-stale on the one shared parse path", () => {
    // Re-pinned from this slice's own file so `src/cli-options.test.ts` and
    // `src/cli-entries.test.ts` stay untouched and out of scope; #277's and
    // #332's pins there are unchanged. This slice removes no refusal, so the
    // flag the completion path (#335) will enable is still refused here.
    expect(() =>
      parsePipelineRuntimeOptions([
        "--renegotiate-stale",
        SLICE_NUMBER,
        "--recovery-reason",
        "the pair went stale",
      ]),
    ).toThrow(/--renegotiate-stale is refused until #335 lands/);
    expect(
      parseStaleRenegotiationRequest([
        "--renegotiate-stale",
        SLICE_NUMBER,
        "--recovery-reason",
        "  stale  ",
      ]),
    ).toEqual({ selector: SLICE_NUMBER, reason: "stale" });
  });

  it("[behavior:#334:P-02] keeps the five reused exports callable at their current signatures", () => {
    const snapshotDir = admitPending(fixture, "attempt-p02");
    const event = trailingEvent(fixture);

    // Same five seams, same shapes, reached the way reconciliation reaches them.
    expect(restoreFrom(fixture, event).ok).toBe(true);
    expect(isLegalRecoveryTransition("PENDING", "ROLLED_BACK")).toBe(true);
    expect(
      recoveryDispatchRefusal(loadRunState(fixture.repoRoot, PRD_SLUG), GH_ISSUE),
    ).toBeUndefined();
    const state = stateWithLineage(fixture, [event]);
    appendRecoveryLineageEvent(state, GH_ISSUE, {
      ...event,
      state: "ROLLED_BACK",
    });
    expect(recoveryLineageFor(state, GH_ISSUE)).toHaveLength(2);
    expect(rollback(fixture).rolledBack).toBe(true);
    expect(existsSync(snapshotDir)).toBe(true);
  }, 30_000);

  it.each([
    ["no recoveryLineage at all", false],
    ["a lineage whose every trailing event is terminal", true],
  ])(
    "[behavior:#334:P-03] reports nothing and leaves the run-state bytes alone given %s",
    (_label, terminal) => {
      if (terminal) {
        writeLineage(fixture, [
          plantTarget(fixture, {
            ghIssue: "701",
            attemptId: "attempt-done",
            trailing: "ROLLED_BACK",
          }),
          plantTarget(fixture, {
            ghIssue: "702",
            attemptId: "attempt-completed",
            trailing: "COMPLETED",
          }),
        ]);
      }
      expect(
        (stateDocument(fixture).recoveryLineage as object | undefined) !==
          undefined,
      ).toBe(terminal);
      const before = readFileSync(fixture.statePath);

      expect(reconcile(fixture)).toEqual([]);

      expect(readFileSync(fixture.statePath).equals(before)).toBe(true);
    },
    30_000,
  );
});
