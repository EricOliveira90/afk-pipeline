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
import {
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
  encodeRunScopeFingerprintPayload,
  evaluateRecoveryEligibility,
  executeRecoveryAttempt,
  hasOpenRecoveryAttempt,
  isLegalRecoveryTransition,
  listLiveNegotiationFiles,
  listPublishedPairSnapshots,
  publishAcceptedPairSnapshot,
  readLockedAcceptedPair,
  runScopeFingerprint,
  type ExecuteRecoveryAttemptArgs,
  type RecoveryGitProbes,
  type RecoveryRefusalCode,
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

    // Resolve the first attempt so a retry is admissible at all. This slice
    // ships the transition validator but none of the terminal writers (#335),
    // so the fixture records the legal `PENDING -> COMPLETED` itself.
    expect(isLegalRecoveryTransition("PENDING", "COMPLETED")).toBe(true);
    const document = stateDocument(fixture);
    const events = (document.recoveryLineage as Record<
      string,
      PersistedRecoveryLineageEvent[]
    >)[GH_ISSUE]!;
    events.push({ ...events[0]!, state: "COMPLETED" });
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
