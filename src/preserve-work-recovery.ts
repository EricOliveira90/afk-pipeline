/**
 * The admission half of the preserved-work recovery protocol (#277).
 *
 * One operator judgement — "the accepted contract/manifest pair for this slice
 * is stale, renegotiate it on the worktree that already holds the work" — has to
 * become one durable, verified fact before anything reopens that pair. This
 * module is the whole path from the parsed CLI request to that fact: canonical
 * request identity, the canonical scope fingerprint, read-only eligibility,
 * a byte-verified immutable snapshot of the pair as accepted, and — under the
 * ADR 0056 run-state lock, after rechecking every fact the snapshot was built
 * from — one appended `PENDING` lineage event, which is the first admitted
 * mutation on disk.
 *
 * Three properties are load-bearing and each has a reason:
 *
 *  - **Nothing here moves a ref.** No merge, reset or rebase is invoked on any
 *    path, including every refusal path (ADR 0039, #277 B-06). Recovery exists to
 *    preserve unmerged commits; a protocol that could lose them to a refused
 *    admission would be worse than no protocol.
 *  - **The snapshot is published before the lock, and grants nothing.** Copying
 *    the pair is slow and byte-verified, so it happens outside the lock to keep
 *    the critical section short. A snapshot no `PENDING` event references is
 *    inert: readers resolve authority through lineage, never by finding a
 *    directory (#277 B-07).
 *  - **The recheck is inside the lock or it proves nothing.** Everything
 *    eligibility read can change between the read and the append. The
 *    {@link admitStaleRenegotiation} recheck re-reads it all under the lock and
 *    refuses on any drift (#277 B-08).
 *
 * The completion half arrives in slices. #332 added attempt execution. #333 added
 * the two *unsuccessful* terminal outcomes — one restore-and-verify routine
 * ({@link restoreAcceptedPairFromSnapshot}), one rollback writer that appends
 * `ROLLED_BACK` or `ROLLBACK_FAILED` ({@link rollBackRecoveryAttempt}), and one
 * fail-closed dispatch hold ({@link recoveryDispatchRefusal}). #334 wires the
 * first two into a launch through {@link reconcileRecoveryLineage}, which every
 * run calls before it dispatches anything.
 *
 * #335 closes the lineage. {@link completeRecoveryAttempt} is the only writer of
 * the `COMPLETED` event, and it writes one only after three preconditions hold —
 * a replacement pair that validates through {@link readLockedAcceptedPair}, a
 * mechanical lock gate that returns `null`, and a non-blank provenance stamp — and
 * only inside one {@link transactRunState} body that rechecks the trailing event
 * and the scope fingerprint under the lock. Every other ending delegates to #333's
 * writer or writes nothing at all; this slice adds no restore, no rollback and no
 * terminal-event append of its own. {@link recoveryPreDispatchRefusal} then holds
 * dispatch fail-closed if the completed replacement pair drifts afterwards, and
 * {@link admitStaleRenegotiation} answers a repeat against a completed
 * renegotiation as an idempotent no-op rather than a second attempt. Reporting and
 * dispatch wiring are #336's.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { canonicalSliceNumber } from "./afk-manifest.js";
import {
  ACCEPTANCE_MANIFEST_FILENAME,
  parseAcceptanceManifest,
  validateAcceptanceManifestCoverage,
} from "./acceptance-manifest.js";
import {
  emptyContractFindingLineage,
  saveContractFindingLineage,
} from "./contract-convergence.js";
import { clearExactStageCheckpoint } from "./exact-stage-resume.js";
import {
  countCommitsAhead,
  hasUncommittedChanges,
  isAncestor,
  resolveCommit,
} from "./git.js";
import {
  featureBranchForProviderName,
  sliceWorktreeDirForProviderName,
} from "./run-identity.js";
import {
  RECOVERY_FINGERPRINT_ABSENT,
  appendRecoveryLineageEvent,
  loadRunState,
  recoveryLineageFor,
  transactRunState,
  type PersistedRecoveryLineageEvent,
  type RecoveryLineageState,
  type RunState,
} from "./run-state.js";
import type { PersistedRunScope } from "./slice-scope.js";

/** The contract half of an accepted pair, beside the manifest in a slice dir. */
export const CONTRACT_FILENAME = "contract.md";

/** Directory beneath a slice's artifact directory that holds pair snapshots. */
export const RECOVERY_SNAPSHOT_DIRNAME = "recovery-snapshots";

/**
 * Every reason admission can refuse, as a stable code.
 *
 * Codes rather than prose because a refusal is read by three audiences with
 * different needs — the operator (message), a later reconciliation (behavior),
 * and a test (identity) — and only a code serves the third without pinning the
 * first. One code per distinguishable cause is the #277 AC8 requirement.
 */
export type RecoveryRefusalCode =
  /** The run has no persisted scope at all: nothing to corroborate against. */
  | "scope-absent"
  /** The selector matched no persisted scope entry. */
  | "target-out-of-scope"
  /** The selector matched more than one persisted scope entry. */
  | "selector-ambiguous"
  /** Run state records no branch for the target slice. */
  | "slice-branch-unrecorded"
  /** No worktree is registered at the target's expected directory. */
  | "worktree-unregistered"
  /** The target worktree has uncommitted changes. */
  | "worktree-dirty"
  /** The slice branch is not ahead of the feature branch: no work to preserve. */
  | "no-commits-ahead"
  /** The slice branch does not contain the exact current feature-branch head. */
  | "feature-head-not-contained"
  /** The accepted pair is missing, unparseable, or not `LOCKED`. */
  | "accepted-pair-invalid"
  /** A branch tip could not be resolved, so no admission fact can be recorded. */
  | "branch-head-unresolvable"
  /** A snapshot directory for this attempt id is already published. */
  | "snapshot-already-published"
  /** Publication failed; the temporary sibling was removed and nothing published. */
  | "snapshot-publication-failed"
  /** The target's last lineage event is `PENDING`: an attempt is already open. */
  | "attempt-already-pending"
  /**
   * No unresolved attempt for this target: nothing to execute (#332) and nothing
   * to roll back (#333). Execution wants a trailing `PENDING`; rollback also
   * accepts a trailing `ROLLBACK_FAILED`, which is a retryable failed rollback.
   */
  | "no-pending-attempt"
  /** Restore-and-verify did not prove the accepted pair back onto disk (#333). */
  | "rollback-verification-failed"
  /** An attempt's last event is `ROLLBACK_FAILED`: dispatch is held (#333 B-07). */
  | "rollback-failed-hold"
  /** The facts changed between snapshot publication and the locked recheck. */
  | "facts-changed-before-lock"
  /**
   * The mechanical lock gate refused the replacement pair, or the caller supplied
   * no provenance stamp for the lock exit (#335 B-01).
   *
   * One code for both, because they are the same fact from the completion's point
   * of view: the lock the replacement pair would be accepted under was not
   * granted. A missing gate or a blank stamp is a refusal, never a skip — the
   * alternative is a `COMPLETED` event nobody checked and nobody signed.
   */
  | "lock-gate-refused"
  /**
   * A target's renegotiation completed, but the pair now in the slice directory is
   * no longer the replacement that `COMPLETED` event recorded (#335 B-04).
   */
  | "completed-pair-drifted"
  /** An exact repeat against a completed renegotiation: nothing to do (#335 B-05). */
  | "replay-completed-no-op"
  /**
   * A repeat against a completed renegotiation that names a different target or a
   * different reason than the completed attempt did (#335 B-10).
   */
  | "replay-conflict";

/** A resolved recovery target: the canonical pair, never a bare selector. */
export interface RecoveryTargetIdentity {
  /** `canonicalSliceNumber` of the persisted scope entry's number. */
  number: string;
  ghIssue: string;
}

/** One recovery request after canonicalization (#277 B-03). */
export interface CanonicalRecoveryRequest {
  target: RecoveryTargetIdentity;
  /** The CLI reason after `String.prototype.trim()` and nothing else. */
  reason: string;
}

export type CanonicalizeRecoveryRequestResult =
  | { ok: true; request: CanonicalRecoveryRequest }
  | {
      ok: false;
      code: Extract<
        RecoveryRefusalCode,
        "scope-absent" | "target-out-of-scope" | "selector-ambiguous"
      >;
    };

/**
 * Resolve a parsed request to canonical identity (#277 B-03/AC4-AC5).
 *
 * The reason is trimmed and otherwise left alone: no case folding, no whitespace
 * collapse, no Unicode normalization. An operator's reason is evidence a human
 * will read next to the diff, and every normalization beyond stripping the shell's
 * accidental padding destroys something they wrote on purpose.
 *
 * The selector resolves against the *persisted scope entries* and their canonical
 * numbers, not against a manifest re-read. That is the corroboration ADR 0065
 * requires before an ID match resolves identity, and it is why
 * `matchesSliceSelector` is deliberately not reused: its inline `Number(...)`
 * comparison is a second, differently-shaped normalization of the same fact, and
 * two normalizations of one identity is how two callers come to disagree about
 * which slice was named.
 */
export function canonicalizeRecoveryRequest(
  request: { selector: string; reason: string },
  scope: PersistedRunScope | undefined,
): CanonicalizeRecoveryRequestResult {
  if (!scope || !Array.isArray(scope.slices) || scope.slices.length === 0) {
    return { ok: false, code: "scope-absent" };
  }
  const wanted = canonicalSliceNumber(request.selector);
  const matches = scope.slices.filter(
    (entry) =>
      canonicalSliceNumber(entry.number) === wanted ||
      entry.ghIssue === request.selector,
  );
  if (matches.length === 0) return { ok: false, code: "target-out-of-scope" };
  // A selector that names one entry by number and another by issue id names no
  // single slice. Refusing is the only answer that cannot silently recover the
  // wrong worktree.
  const distinct = new Set(matches.map((entry) => entry.ghIssue));
  if (distinct.size > 1) return { ok: false, code: "selector-ambiguous" };
  const entry = matches[0]!;
  return {
    ok: true,
    request: {
      target: {
        number: canonicalSliceNumber(entry.number),
        ghIssue: entry.ghIssue,
      },
      reason: request.reason.trim(),
    },
  };
}

/**
 * The canonical byte string a scope fingerprint is taken over (#277 B-04).
 *
 * Key order is emitted explicitly rather than inherited from an object literal
 * the way `decisionSetFingerprint` does it: a literal's key order is a property
 * of the source file, so a later reorder of the fields would silently change
 * every fingerprint ever computed. Slice order is the *persisted* order, because
 * that order is itself part of the scope's identity.
 */
export function encodeRunScopeFingerprintPayload(
  scope: PersistedRunScope,
): string {
  const slices = scope.slices
    .map(
      (entry) =>
        `{"number":${JSON.stringify(canonicalSliceNumber(entry.number))},` +
        `"ghIssue":${JSON.stringify(entry.ghIssue)}}`,
    )
    .join(",");
  return `{"mode":${JSON.stringify(scope.mode)},"slices":[${slices}]}`;
}

/**
 * SHA-256 of {@link encodeRunScopeFingerprintPayload} over UTF-8.
 *
 * Exported because the completion slice (#335) compares against the fingerprint
 * this slice recorded; two encoders would be two answers to one question.
 */
export function runScopeFingerprint(scope: PersistedRunScope): string {
  return createHash("sha256")
    .update(encodeRunScopeFingerprintPayload(scope), "utf-8")
    .digest("hex");
}

/**
 * The only legal recovery-lineage transitions (#277 B-11).
 *
 * `ROLLBACK_FAILED` is not terminal: a failed rollback can be retried and
 * succeed, so it reaches `ROLLED_BACK`. Nothing returns to `PENDING` — an attempt
 * that needs another try is a new attempt with a new id, because the events are
 * appended and never edited, and a second `PENDING` on one id would make "is an
 * attempt open" unanswerable.
 */
const LEGAL_RECOVERY_TRANSITIONS: ReadonlyMap<
  RecoveryLineageState,
  ReadonlySet<RecoveryLineageState>
> = new Map([
  [
    "PENDING" as RecoveryLineageState,
    new Set<RecoveryLineageState>([
      "COMPLETED",
      "ROLLED_BACK",
      "ROLLBACK_FAILED",
    ]),
  ],
  ["COMPLETED" as RecoveryLineageState, new Set<RecoveryLineageState>()],
  ["ROLLED_BACK" as RecoveryLineageState, new Set<RecoveryLineageState>()],
  [
    "ROLLBACK_FAILED" as RecoveryLineageState,
    new Set<RecoveryLineageState>(["ROLLED_BACK"]),
  ],
]);

/** Whether one recovery-lineage transition is legal (#277 B-11). */
export function isLegalRecoveryTransition(
  from: RecoveryLineageState,
  to: RecoveryLineageState,
): boolean {
  return LEGAL_RECOVERY_TRANSITIONS.get(from)?.has(to) ?? false;
}

/**
 * The three git predicates eligibility is allowed to reach (#277 P-05).
 *
 * A structural type at the existing `src/git.ts` signatures, injected rather than
 * imported directly inside the predicates, for two reasons: it makes the
 * "no other git export is reachable from eligibility" claim a *type-level* fact
 * instead of a convention, and it gives the tests a stub seam that needs no
 * module mocking. `src/git.ts` and `src/worktree-processes.ts` are unmodified.
 */
export interface RecoveryGitProbes {
  hasUncommittedChanges: (cwd: string) => boolean;
  countCommitsAhead: (repoRoot: string, source: string, target: string) => number;
  isAncestor: (repoRoot: string, ancestor: string, descendant: string) => boolean;
}

export const DEFAULT_RECOVERY_GIT_PROBES: RecoveryGitProbes = {
  hasUncommittedChanges,
  countCommitsAhead,
  isAncestor,
};

/** The facts a clean eligibility pass resolved, for the caller's next step. */
export interface RecoveryEligibilityFacts {
  target: RecoveryTargetIdentity;
  /** The trimmed reason, carried forward so nothing re-trims it. */
  reason: string;
  sliceBranch: string;
  featureBranch: string;
  worktreeDir: string;
  scopeFingerprint: string;
}

export type RecoveryEligibility =
  | { ok: true; facts: RecoveryEligibilityFacts }
  | { ok: false; code: RecoveryRefusalCode; message: string };

/** The accepted pair's bytes and their fingerprints, as read from a slice dir. */
export interface AcceptedPairBytes {
  contract: string;
  manifest: string;
  contractFingerprint: string;
  manifestFingerprint: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Read and validate a locked accepted pair, or `undefined` if it is not one.
 *
 * The `**Status:**` line is matched here rather than through
 * `readContractStatus`, because `src/artifacts.ts` is a Review-rails internal
 * this module may not import (ARCHITECTURE.md "Internals (do not import)"). The
 * pattern is deliberately the same one, so the two readers cannot disagree about
 * what a locked contract looks like.
 */
export function readLockedAcceptedPair(
  sliceDir: string,
): AcceptedPairBytes | undefined {
  const contractPath = join(sliceDir, CONTRACT_FILENAME);
  const manifestPath = join(sliceDir, ACCEPTANCE_MANIFEST_FILENAME);
  if (!existsSync(contractPath) || !existsSync(manifestPath)) return undefined;
  const contract = readFileSync(contractPath, "utf-8");
  const manifest = readFileSync(manifestPath, "utf-8");
  const status = contract.match(/\*\*Status:\*\*\s*(\S+)/i)?.[1]?.trim();
  if (status?.toUpperCase() !== "LOCKED") return undefined;
  try {
    const parsed = parseAcceptanceManifest(manifest, manifestPath);
    validateAcceptanceManifestCoverage(contract, parsed, contractPath);
  } catch {
    // A pair that does not validate is not an authority to reopen. The refusal
    // reason is the same either way, so the parse error adds nothing a reader of
    // the pair's own gate output does not already have.
    return undefined;
  }
  return {
    contract,
    manifest,
    contractFingerprint: sha256(contract),
    manifestFingerprint: sha256(manifest),
  };
}

/**
 * Read-only eligibility for one recovery request (#277 B-05).
 *
 * Every check is a read. The order is cheapest-and-most-fundamental first:
 * identity before persisted records, persisted records before the filesystem,
 * the filesystem before git. A caller that gets `ok: false` has changed nothing.
 */
export function evaluateRecoveryEligibility(args: {
  repoRoot: string;
  /** PRD slug — what branch and worktree names are derived from. */
  prdSlug: string;
  providerName: string;
  state: RunState;
  request: { selector: string; reason: string };
  /** The target's artifact directory, holding the accepted pair. */
  sliceDir: string;
  probes?: RecoveryGitProbes;
}): RecoveryEligibility {
  const probes = args.probes ?? DEFAULT_RECOVERY_GIT_PROBES;
  const canonical = canonicalizeRecoveryRequest(args.request, args.state.scope);
  if (!canonical.ok) {
    const message =
      canonical.code === "scope-absent"
        ? "This run has no persisted slice scope, so no recovery target can be corroborated; run the pipeline once before renegotiating a stale pair"
        : canonical.code === "selector-ambiguous"
          ? `--renegotiate-stale ${args.request.selector} matches more than one persisted scope entry`
          : `--renegotiate-stale ${args.request.selector} is not in this run's persisted scope`;
    return { ok: false, code: canonical.code, message };
  }
  const { target, reason } = canonical.request;
  const scopeFingerprint = runScopeFingerprint(args.state.scope!);

  const sliceBranch = args.state.slices[target.ghIssue]?.branch;
  if (sliceBranch === undefined || sliceBranch.trim() === "") {
    return {
      ok: false,
      code: "slice-branch-unrecorded",
      message: `Run state records no slice branch for #${target.ghIssue}, so there is no preserved work to renegotiate against`,
    };
  }
  const featureBranch = featureBranchForProviderName(
    args.prdSlug,
    args.providerName,
  );
  const worktreeDir = sliceWorktreeDirForProviderName(
    args.repoRoot,
    args.prdSlug,
    target.number,
    args.providerName,
  );
  // Registration is read off the filesystem rather than `git worktree list`,
  // because P-05 pins eligibility's git surface to exactly three predicates. A
  // linked worktree always carries a `.git` file pointing at its admin dir, so
  // its absence is the same "not a worktree" answer git would give.
  if (!existsSync(worktreeDir) || !existsSync(join(worktreeDir, ".git"))) {
    return {
      ok: false,
      code: "worktree-unregistered",
      message: `No worktree is registered at ${worktreeDir} for slice ${target.number} (#${target.ghIssue})`,
    };
  }

  const pair = readLockedAcceptedPair(args.sliceDir);
  if (pair === undefined) {
    return {
      ok: false,
      code: "accepted-pair-invalid",
      message: `${args.sliceDir} does not hold a valid LOCKED contract.md / ${ACCEPTANCE_MANIFEST_FILENAME} pair`,
    };
  }

  if (probes.hasUncommittedChanges(worktreeDir)) {
    return {
      ok: false,
      code: "worktree-dirty",
      message: `${worktreeDir} has uncommitted changes; commit or discard them before renegotiating the pair`,
    };
  }
  if (probes.countCommitsAhead(args.repoRoot, sliceBranch, featureBranch) < 1) {
    return {
      ok: false,
      code: "no-commits-ahead",
      message: `${sliceBranch} has no commits ahead of ${featureBranch}; there is no preserved work to recover`,
    };
  }
  if (!probes.isAncestor(args.repoRoot, featureBranch, sliceBranch)) {
    return {
      ok: false,
      code: "feature-head-not-contained",
      message: `${sliceBranch} does not contain the current ${featureBranch} head; rebuild the slice branch on the feature head before renegotiating`,
    };
  }

  return {
    ok: true,
    facts: {
      target,
      reason,
      sliceBranch,
      featureBranch,
      worktreeDir,
      scopeFingerprint,
    },
  };
}

/** Where one attempt's snapshot lives, and what it is a snapshot of. */
export interface PublishedPairSnapshot {
  /** Absolute path of the published directory. */
  dir: string;
  /** `dir` relative to the repo root, with `/` separators — the stored locator. */
  locator: string;
  contractFingerprint: string;
  manifestFingerprint: string;
}

export type PairSnapshotResult =
  | { ok: true; snapshot: PublishedPairSnapshot }
  | { ok: false; code: RecoveryRefusalCode; message: string };

/**
 * Copy the accepted pair into an immutable published snapshot (#277 B-07).
 *
 * Written through a temporary sibling and moved into place with a single
 * `renameSync`, so a reader never sees a half-copied snapshot: the directory
 * either does not exist or holds both verified files. Verification happens on the
 * bytes *in the temporary sibling* — the bytes that will be published — because
 * verifying the source and publishing a copy proves nothing about the copy.
 *
 * A published pair file is never overwritten. An attempt id addresses exactly one
 * accepted pair; if a directory for it exists, either this attempt already
 * published or the id was reused, and both are refusals rather than a silent
 * clobber of the only immutable record of what was accepted (ADR 0039's reasoning
 * applied to artifacts instead of commits).
 *
 * The invariant is stated over the two pair files rather than over the directory
 * because attempt execution publishes a `negotiation/` child *inside* an
 * already-published attempt directory (#332 B-02): the directory gains children,
 * while the pair bytes and their fingerprints never change. The refusal below is
 * unchanged — an `attemptId` directory still admits exactly one pair publication.
 */
export function publishAcceptedPairSnapshot(args: {
  repoRoot: string;
  sliceDir: string;
  attemptId: string;
  /** Test seam: fires after the temporary sibling is written, before publication. */
  afterTemporaryWritten?: () => void;
}): PairSnapshotResult {
  const source = readLockedAcceptedPair(args.sliceDir);
  if (source === undefined) {
    return {
      ok: false,
      code: "accepted-pair-invalid",
      message: `${args.sliceDir} does not hold a valid LOCKED contract.md / ${ACCEPTANCE_MANIFEST_FILENAME} pair`,
    };
  }
  const root = join(args.sliceDir, RECOVERY_SNAPSHOT_DIRNAME);
  const published = join(root, args.attemptId);
  if (existsSync(published)) {
    return {
      ok: false,
      code: "snapshot-already-published",
      message: `A recovery snapshot is already published at ${published}; a published snapshot is never overwritten`,
    };
  }
  const temporary = join(root, `.${args.attemptId}.partial`);
  try {
    mkdirSync(root, { recursive: true });
    rmSync(temporary, { recursive: true, force: true });
    mkdirSync(temporary, { recursive: true });
    writeFileSync(join(temporary, CONTRACT_FILENAME), source.contract);
    writeFileSync(
      join(temporary, ACCEPTANCE_MANIFEST_FILENAME),
      source.manifest,
    );
    args.afterTemporaryWritten?.();

    const copied = readLockedAcceptedPair(temporary);
    if (
      copied === undefined ||
      copied.contract !== source.contract ||
      copied.manifest !== source.manifest ||
      copied.contractFingerprint !== source.contractFingerprint ||
      copied.manifestFingerprint !== source.manifestFingerprint
    ) {
      rmSync(temporary, { recursive: true, force: true });
      return {
        ok: false,
        code: "snapshot-publication-failed",
        message: `The recovery snapshot copy under ${root} did not match the accepted pair byte for byte; nothing was published`,
      };
    }
    renameSync(temporary, published);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: "snapshot-publication-failed",
      message: `Publishing the recovery snapshot under ${root} failed before admission (${detail}); nothing was published`,
    };
  }
  return {
    ok: true,
    snapshot: {
      dir: published,
      locator: relative(args.repoRoot, published).split("\\").join("/"),
      contractFingerprint: source.contractFingerprint,
      manifestFingerprint: source.manifestFingerprint,
    },
  };
}

/** Whether a target's lineage ends on an unresolved `PENDING` attempt. */
export function hasOpenRecoveryAttempt(
  state: RunState,
  ghIssue: string,
): boolean {
  const events = recoveryLineageFor(state, ghIssue);
  return events[events.length - 1]?.state === "PENDING";
}

export type AdmissionOutcome =
  | {
      admitted: true;
      attemptId: string;
      event: PersistedRecoveryLineageEvent;
      snapshot: PublishedPairSnapshot;
    }
  | {
      /**
       * An exact repeat against an already-completed renegotiation (#335 B-05).
       *
       * `admitted: false` because nothing was admitted, but a member of its own
       * rather than an ordinary refusal: a refusal says "this request was not
       * allowed", while this says "this request was already satisfied, and
       * satisfying it again would publish a snapshot of a replacement pair and
       * open a second attempt to renegotiate what was already renegotiated". The
       * two need different operator lines, so they need different outcomes.
       */
      admitted: false;
      /** Discriminates this member from an ordinary refusal at a glance. */
      replayed: true;
      code: Extract<RecoveryRefusalCode, "replay-completed-no-op">;
      message: string;
      /** The `COMPLETED` attempt the repeat resolved to. */
      attemptId: string;
      /** Never published on this path; declared so the union stays uniform. */
      snapshot?: undefined;
    }
  | {
      admitted: false;
      /** Absent here: only the replay no-op above sets it. */
      replayed?: undefined;
      code: RecoveryRefusalCode;
      message: string;
      /** Present when a snapshot was published before the refusal; it is inert. */
      snapshot?: PublishedPairSnapshot;
    };

export interface AdmitStaleRenegotiationArgs {
  repoRoot: string;
  /** PRD slug: branch, worktree and artifact identity. */
  prdSlug: string;
  /** Run slug: which run-state file this attempt is recorded in (ADR 0002). */
  runSlug?: string;
  providerName: string;
  sliceDir: string;
  request: { selector: string; reason: string };
  /** Supplied by tests; a real run mints a fresh id per attempt. */
  attemptId?: string;
  probes?: RecoveryGitProbes;
  /**
   * Test seam: fires after the snapshot is published and before
   * `transactRunState` takes the ADR 0056 lock (#277 B-08).
   *
   * The seam is here rather than threaded through `withRunStateLock` or
   * `withFileLock`'s `afterLockPublished`, because the interleave being proven is
   * "the facts changed after the snapshot and before this process held the lock" —
   * which is a property of *this* module's sequencing, not of the shared lock.
   * Widening a primitive every run-state writer calls to prove one caller's
   * ordering would be the more expensive and less faithful test.
   */
  beforeLockAcquired?: () => void;
  /** Test seam forwarded to {@link publishAcceptedPairSnapshot}. */
  afterTemporaryWritten?: () => void;
}

/** A completed renegotiation whose replacement pair is the one now on disk. */
interface CompletedReplacement {
  ghIssue: string;
  event: PersistedRecoveryLineageEvent;
}

/**
 * The trailing `COMPLETED` event the pair now in a slice directory belongs to
 * (#335 B-05/B-10/B-11), or `undefined` if no completed attempt claims it.
 *
 * Keyed on the *pair* rather than on the requested target, because the pair is
 * what replay idempotence is about: a request repeated after a completion finds a
 * slice directory holding the replacement, not the pair that was accepted, and
 * re-admitting it would snapshot the replacement as if it were the original. A
 * pair whose fingerprints match no completed replacement — the ordinary case, and
 * the different-valid-pair case of B-11 — is not a replay at all and admits
 * normally.
 *
 * Searched across every target in the lineage, sorted for determinism, because
 * "which completed attempt does this pair belong to" is a question the pair
 * answers on its own; comparing that attempt's recorded target against the
 * request's is then what tells an exact repeat from a conflicting one.
 */
function completedReplacementFor(
  state: RunState,
  pair: AcceptedPairBytes | undefined,
): CompletedReplacement | undefined {
  if (pair === undefined) return undefined;
  for (const ghIssue of Object.keys(state.recoveryLineage ?? {}).sort(
    compareGhIssue,
  )) {
    const events = recoveryLineageFor(state, ghIssue);
    const last = events[events.length - 1];
    if (
      last?.state === "COMPLETED" &&
      last.replacementContractFingerprint === pair.contractFingerprint &&
      last.replacementManifestFingerprint === pair.manifestFingerprint
    ) {
      return { ghIssue, event: last };
    }
  }
  return undefined;
}

/**
 * Answer a repeat against a completed renegotiation (#335 B-05/B-10).
 *
 * Identity is the whole {@link CanonicalRecoveryRequest} plus the extension set,
 * compared as *values* against what the completed event recorded. An exact repeat
 * is the idempotent no-op; anything else is a conflict, because a completed
 * replacement pair can only have been accepted for the one request that produced
 * it, and admitting a different request against it would renegotiate a
 * replacement under a reason nobody accepted it for.
 *
 * The extension set is compared as "the completed attempt admitted none", which is
 * all it can be until `--extend-scope` ships (#278) and all this slice's requests
 * can ask for. It is compared rather than assumed so the check does not silently
 * become vacuous when extensions arrive.
 */
function replayOutcome(
  replay: CompletedReplacement,
  facts: RecoveryEligibilityFacts,
  sliceDir: string,
): AdmissionOutcome {
  const completed = replay.event;
  const held =
    `Recovery attempt ${completed.attemptId} completed a renegotiation of slice ` +
    `${completed.target.number} (#${completed.target.ghIssue}) and the pair in ` +
    `${sliceDir} is still the replacement it accepted`;
  if (
    completed.target.number === facts.target.number &&
    completed.target.ghIssue === facts.target.ghIssue &&
    completed.reason === facts.reason &&
    completed.extensions.length === 0
  ) {
    return {
      admitted: false,
      replayed: true,
      code: "replay-completed-no-op",
      message:
        `${held}, and this request repeats it exactly; no snapshot was published, ` +
        `no lineage event was appended and neither accepted-pair file was rewritten`,
      attemptId: completed.attemptId,
    };
  }
  return {
    admitted: false,
    code: "replay-conflict",
    message:
      `${held} for reason "${completed.reason}"; this request names slice ` +
      `${facts.target.number} (#${facts.target.ghIssue}) for reason "${facts.reason}", ` +
      `which is not the request that completion accepted. Nothing was published or appended`,
  };
}

/**
 * Admit one stale-pair renegotiation request, or refuse it (#277 B-08/B-09).
 *
 * The sequence, and why it is this sequence:
 *
 *  1. Load run state and run read-only eligibility. A refusal here has touched
 *     nothing at all.
 *  2. Answer a repeat against an already-completed renegotiation, before anything
 *     is published (#335 B-05/B-10/B-11). Deciding it here is what makes the
 *     no-op a no-op: one step later a snapshot of the replacement pair would
 *     already be on disk.
 *  3. Resolve both branch tips. These are recorded facts, not eligibility
 *     outcomes — an attempt whose tips cannot be named could never be reconciled.
 *  4. Publish the byte-verified snapshot. Outside the lock because it is the slow
 *     part, and safe outside it because an unreferenced snapshot is inert.
 *  5. `beforeLockAcquired` — the interleave seam.
 *  6. Take the run-state lock, reload, and recheck every fact steps 1-4 read.
 *     Any drift is a pre-admission refusal that writes nothing.
 *  7. Append exactly one `PENDING` event. This is the first admitted mutation.
 */
export function admitStaleRenegotiation(
  args: AdmitStaleRenegotiationArgs,
): AdmissionOutcome {
  const runSlug = args.runSlug ?? args.prdSlug;
  const state = loadRunState(args.repoRoot, runSlug);
  const eligibility = evaluateRecoveryEligibility({
    repoRoot: args.repoRoot,
    prdSlug: args.prdSlug,
    providerName: args.providerName,
    state,
    request: args.request,
    sliceDir: args.sliceDir,
    probes: args.probes,
  });
  if (!eligibility.ok) {
    return {
      admitted: false,
      code: eligibility.code,
      message: eligibility.message,
    };
  }
  const facts = eligibility.facts;

  if (hasOpenRecoveryAttempt(state, facts.target.ghIssue)) {
    return {
      admitted: false,
      code: "attempt-already-pending",
      message: `A recovery attempt for slice ${facts.target.number} (#${facts.target.ghIssue}) is already PENDING; resolve it before admitting another`,
    };
  }

  const replay = completedReplacementFor(
    state,
    // Eligibility already read and validated this pair, so the read cannot fail
    // here; the guard is what makes that a fact of the code and not a comment.
    readLockedAcceptedPair(args.sliceDir),
  );
  if (replay !== undefined) {
    return replayOutcome(replay, facts, args.sliceDir);
  }

  const sliceHead = resolveCommit(args.repoRoot, facts.sliceBranch);
  const featureHead = resolveCommit(args.repoRoot, facts.featureBranch);
  if (sliceHead === null || featureHead === null) {
    return {
      admitted: false,
      code: "branch-head-unresolvable",
      message: `Could not resolve both ${facts.sliceBranch} and ${facts.featureBranch} to commits; refusing to record an attempt whose tips cannot be named`,
    };
  }

  const attemptId = args.attemptId ?? randomUUID();
  const publication = publishAcceptedPairSnapshot({
    repoRoot: args.repoRoot,
    sliceDir: args.sliceDir,
    attemptId,
    afterTemporaryWritten: args.afterTemporaryWritten,
  });
  if (!publication.ok) {
    return {
      admitted: false,
      code: publication.code,
      message: publication.message,
    };
  }
  const snapshot = publication.snapshot;

  args.beforeLockAcquired?.();

  return transactRunState<AdmissionOutcome>(
    args.repoRoot,
    runSlug,
    (locked) => {
      const drift = (message: string): {
        changed: false;
        result: AdmissionOutcome;
      } => ({
        changed: false,
        result: {
          admitted: false,
          code: "facts-changed-before-lock",
          message: `${message}; the published snapshot at ${snapshot.locator} references no lineage event and grants no recovery authority`,
          snapshot,
        },
      });

      const recheck = evaluateRecoveryEligibility({
        repoRoot: args.repoRoot,
        prdSlug: args.prdSlug,
        providerName: args.providerName,
        state: locked,
        request: args.request,
        sliceDir: args.sliceDir,
        probes: args.probes,
      });
      if (!recheck.ok) {
        return drift(
          `The recovery target stopped being eligible before the run-state lock was held (${recheck.code})`,
        );
      }
      // Request identity and scope fingerprint are rechecked as *values*, not
      // re-derived and trusted: a scope edited between the snapshot and the lock
      // would silently retarget the attempt at a different slice.
      if (
        recheck.facts.target.number !== facts.target.number ||
        recheck.facts.target.ghIssue !== facts.target.ghIssue
      ) {
        return drift(
          "The request resolved to a different slice identity under the run-state lock",
        );
      }
      if (recheck.facts.scopeFingerprint !== facts.scopeFingerprint) {
        return drift(
          "The run's persisted scope changed between snapshot publication and the run-state lock",
        );
      }
      if (recheck.facts.sliceBranch !== facts.sliceBranch) {
        return drift(
          `The recorded slice branch changed from ${facts.sliceBranch} to ${recheck.facts.sliceBranch} before the run-state lock`,
        );
      }
      const pair = readLockedAcceptedPair(args.sliceDir);
      if (
        pair === undefined ||
        pair.contractFingerprint !== snapshot.contractFingerprint ||
        pair.manifestFingerprint !== snapshot.manifestFingerprint
      ) {
        return drift(
          "The accepted pair changed between snapshot publication and the run-state lock",
        );
      }
      if (
        resolveCommit(args.repoRoot, facts.sliceBranch) !== sliceHead ||
        resolveCommit(args.repoRoot, facts.featureBranch) !== featureHead
      ) {
        return drift(
          "A branch tip moved between snapshot publication and the run-state lock",
        );
      }
      if (hasOpenRecoveryAttempt(locked, facts.target.ghIssue)) {
        return {
          changed: false,
          result: {
            admitted: false,
            code: "attempt-already-pending",
            message: `A recovery attempt for slice ${facts.target.number} (#${facts.target.ghIssue}) became PENDING before this one took the run-state lock`,
            snapshot,
          },
        };
      }

      const event: PersistedRecoveryLineageEvent = {
        attemptId,
        state: "PENDING",
        target: { ...facts.target },
        reason: facts.reason,
        // Always empty: `--extend-scope` is #278, so this slice admits no
        // extension. Recorded rather than omitted so a reader never has to tell
        // "none" from "not yet a field".
        extensions: [],
        provider: args.providerName,
        sliceBranch: facts.sliceBranch,
        sliceHead,
        featureHead,
        scopeFingerprint: facts.scopeFingerprint,
        snapshotPath: snapshot.locator,
        contractFingerprint: snapshot.contractFingerprint,
        manifestFingerprint: snapshot.manifestFingerprint,
        recordedAt: new Date().toISOString(),
      };
      appendRecoveryLineageEvent(locked, facts.target.ghIssue, event);
      return {
        changed: true,
        result: { admitted: true, attemptId, event, snapshot },
      };
    },
  );
}

/** Published snapshot directory names beneath a slice dir, sorted. */
export function listPublishedPairSnapshots(sliceDir: string): string[] {
  const root = join(sliceDir, RECOVERY_SNAPSHOT_DIRNAME);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => !name.startsWith("."))
    .sort();
}

/**
 * Child of an attempt's snapshot directory holding its negotiation history.
 *
 * Inside the attempt directory rather than beside it, because `prd.md` Admission
 * step 3 gives an attempt exactly one immutable directory identity keyed by
 * `attemptId`; a second locator would be a second answer to "where is this
 * attempt's record" (#332 B-02).
 */
export const RECOVERY_NEGOTIATION_DIRNAME = "negotiation";

/**
 * The fixed live negotiation artifacts an attempt preserves, then clears.
 *
 * A closed list, in the order `prd.md` "Attempt Execution" names them: the
 * explorer's context, the contract review, the planner's response, the recorded
 * negotiation outcome, and the planner's escalation. Every `feedback-r<N>.md`
 * round joins them at execution time, because the number of rounds is a property
 * of the negotiation that happened, not of this list (#332 B-02/B-03).
 */
export const RECOVERY_NEGOTIATION_FILENAMES: readonly string[] = [
  "context.md",
  "contract-review.json",
  "contract-response.json",
  "contract-negotiation-outcome.json",
  "planner-escalation.md",
];

const FEEDBACK_ROUND_FILENAME = /^feedback-r(\d+)\.md$/;

/**
 * The negotiation files present live in a slice directory, in a stable order.
 *
 * Named kinds first in their declared order, then the feedback rounds by round
 * *number* rather than by name, so `feedback-r10.md` sorts after `feedback-r9.md`
 * instead of between `r1` and `r2`. An absent kind is simply not in the list:
 * "skipped without error" is the absence of an entry, not a special case
 * downstream (#332 B-03).
 */
export function listLiveNegotiationFiles(sliceDir: string): string[] {
  if (!existsSync(sliceDir)) return [];
  const named = RECOVERY_NEGOTIATION_FILENAMES.filter((name) =>
    existsSync(join(sliceDir, name)),
  );
  const rounds = readdirSync(sliceDir)
    .filter((name) => FEEDBACK_ROUND_FILENAME.test(name))
    .sort(
      (a, b) =>
        Number(FEEDBACK_ROUND_FILENAME.exec(a)![1]) -
        Number(FEEDBACK_ROUND_FILENAME.exec(b)![1]),
    );
  return [...named, ...rounds];
}

/**
 * Clear the target's exact-stage checkpoint (#332 B-05).
 *
 * A wrapper and nothing else. `clearExactStageCheckpoint` owns the checkpoint
 * map's shape, its collapse-to-absent rule and its lock, and it stays unmodified;
 * what this module owns is the *decision* that a recovery attempt clears exactly
 * this one slice's entry. `clearSliceStateForDispatch` is deliberately not used:
 * it is the coarser dispatch clear, and a per-attempt reopening that reached for
 * it would drop facts (`prd.md:166-175`) recovery exists to preserve.
 *
 * The `prdSlug` field of the owning API's location is fed the *run* slug, which
 * is what keys the state file every other recovery writer reads (ADR 0002).
 */
export function clearRecoveryStageCheckpoint(args: {
  repoRoot: string;
  runSlug: string;
  ghIssue: string;
}): void {
  clearExactStageCheckpoint({
    repoRoot: args.repoRoot,
    prdSlug: args.runSlug,
    ghIssue: args.ghIssue,
  });
}

/**
 * Clear the target's durable contract-finding lineage (#332 B-05).
 *
 * The owning API has no delete, and it does not need one: an *empty* lineage is
 * the value a slice that never negotiated carries, so writing it is exactly
 * "this negotiation starts from nothing". A key deleted instead would make the
 * same claim in a second shape, and `loadContractFindingLineage` already answers
 * both with `emptyContractFindingLineage()`.
 */
export function clearRecoveryContractConvergence(args: {
  repoRoot: string;
  runSlug: string;
  ghIssue: string;
}): void {
  saveContractFindingLineage(
    {
      repoRoot: args.repoRoot,
      runSlug: args.runSlug,
      ghIssue: args.ghIssue,
    },
    emptyContractFindingLineage(),
  );
}

export interface ExecuteRecoveryAttemptArgs {
  repoRoot: string;
  /** PRD slug — artifact identity. */
  prdSlug: string;
  /** Run slug: which run-state file this attempt was admitted in (ADR 0002). */
  runSlug?: string;
  /** The target's artifact directory, holding the live negotiation state. */
  sliceDir: string;
  /** The recovery target, as its admitted `PENDING` event recorded it. */
  ghIssue: string;
  /**
   * Test seam: fires after the history's temporary sibling is written and before
   * its bytes are verified.
   *
   * A parameter on this entry point rather than a widening of any shared
   * primitive, for the reason {@link AdmitStaleRenegotiationArgs.beforeLockAcquired}
   * records: the ordering being proven — "nothing live is cleared until a verified
   * history is published" — belongs to this module's sequencing.
   */
  afterHistoryWritten?: (temporaryDir: string) => void;
}

export type ExecuteRecoveryAttemptResult =
  | {
      ok: true;
      attemptId: string;
      /** Absolute path of the published history directory. */
      historyDir: string;
      /** `historyDir` relative to the repo root, with `/` separators. */
      historyLocator: string;
      /** The negotiation file names copied then cleared, in copy order. */
      movedFiles: string[];
    }
  | { ok: false; code: RecoveryRefusalCode; message: string };

/**
 * Run the two artifact-and-state steps of one admitted recovery attempt (#332).
 *
 * The sequence, and why it is this sequence:
 *
 *  1. Read run state and refuse unless the target's lineage ends on a committed
 *     `PENDING` event. A refusal here has written nothing at all — not a byte
 *     under the slice directory, not a run-state field.
 *  2. Byte-copy every present live negotiation file into the attempt's immutable
 *     history, verify the copy by re-reading it, and publish it with one
 *     `renameSync`. Publication precedes every deletion, so the failure mode of
 *     a half-copied history is a refusal with the live state intact rather than
 *     negotiation state that exists nowhere.
 *  3. Delete exactly the files that were copied.
 *  4. Clear the two live negotiation controls — the exact-stage checkpoint and
 *     the contract-finding lineage — through the wrappers above.
 *
 * What it deliberately does not do: append a lineage event (the terminal events
 * are #333/#335), touch a ref or the preserved worktree (ADR 0039), or write any
 * byte of the accepted pair, live or published. It leaves the state a fresh
 * explorer plus planner/evaluator negotiation would find, and dispatches neither.
 */
export function executeRecoveryAttempt(
  args: ExecuteRecoveryAttemptArgs,
): ExecuteRecoveryAttemptResult {
  const runSlug = args.runSlug ?? args.prdSlug;
  const state = loadRunState(args.repoRoot, runSlug);
  const events = recoveryLineageFor(state, args.ghIssue);
  const admitted = events[events.length - 1];
  if (admitted === undefined || !hasOpenRecoveryAttempt(state, args.ghIssue)) {
    return {
      ok: false,
      code: "no-pending-attempt",
      message: `No committed PENDING recovery attempt exists for #${args.ghIssue}, so there is no admitted attempt to execute; admit one with --renegotiate-stale first`,
    };
  }

  // Located from the `snapshotPath` the admission recorded, not re-derived: the
  // attempt already has one immutable locator, and a second derivation is how two
  // readers come to disagree about which directory is the attempt's.
  const attemptDir = join(args.repoRoot, ...admitted.snapshotPath.split("/"));
  const published = join(attemptDir, RECOVERY_NEGOTIATION_DIRNAME);
  if (existsSync(published)) {
    return {
      ok: false,
      code: "snapshot-already-published",
      message: `A negotiation history is already published at ${published}; a published history is never overwritten`,
    };
  }

  const names = listLiveNegotiationFiles(args.sliceDir);
  const live = new Map<string, Buffer>(
    names.map((name) => [name, readFileSync(join(args.sliceDir, name))]),
  );
  const temporary = join(
    attemptDir,
    `.${RECOVERY_NEGOTIATION_DIRNAME}.partial`,
  );
  try {
    rmSync(temporary, { recursive: true, force: true });
    mkdirSync(temporary, { recursive: true });
    for (const name of names) {
      writeFileSync(join(temporary, name), live.get(name)!);
    }
    args.afterHistoryWritten?.(temporary);

    // Verified on the bytes in the temporary sibling — the bytes that will be
    // published — because verifying the source and publishing a copy proves
    // nothing about the copy.
    for (const name of names) {
      if (!readFileSync(join(temporary, name)).equals(live.get(name)!)) {
        rmSync(temporary, { recursive: true, force: true });
        return {
          ok: false,
          code: "snapshot-publication-failed",
          message: `The negotiation history copy of ${name} under ${attemptDir} did not match the live bytes; nothing was published and no live file was cleared`,
        };
      }
    }
    renameSync(temporary, published);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: "snapshot-publication-failed",
      message: `Publishing the negotiation history under ${attemptDir} failed (${detail}); nothing was published and no live file was cleared`,
    };
  }

  // Exactly the copied paths, and no other: the `reviews/` subdirectory, every
  // implementation and QA artifact and the accepted pair are all left alone.
  for (const name of names) {
    rmSync(join(args.sliceDir, name), { force: true });
  }

  clearRecoveryStageCheckpoint({
    repoRoot: args.repoRoot,
    runSlug,
    ghIssue: args.ghIssue,
  });
  clearRecoveryContractConvergence({
    repoRoot: args.repoRoot,
    runSlug,
    ghIssue: args.ghIssue,
  });

  return {
    ok: true,
    attemptId: admitted.attemptId,
    historyDir: published,
    historyLocator: relative(args.repoRoot, published).split("\\").join("/"),
    movedFiles: names,
  };
}

/**
 * What an attempt's own `PENDING` event says about where its snapshot is and what
 * the pair was when it was taken (#333 B-01).
 *
 * A `Pick` rather than the whole event, so the restore routine's inputs are the
 * four recorded facts it is allowed to use and no fifth: the locator is resolved
 * from `snapshotPath` and never re-derived from a slice directory, matching
 * {@link executeRecoveryAttempt}'s locator rule.
 */
export type RecoveryAttemptLocator = Pick<
  PersistedRecoveryLineageEvent,
  "attemptId" | "snapshotPath" | "contractFingerprint" | "manifestFingerprint"
>;

/** The two fingerprints a verification pass actually read off the slice directory. */
export interface ObservedPairFingerprints {
  /** {@link RECOVERY_FINGERPRINT_ABSENT} when the file could not be read. */
  observedContractFingerprint: string;
  observedManifestFingerprint: string;
}

export type RestoreAcceptedPairResult =
  | ({
      ok: true;
      /** The directory `snapshotPath` resolved to, for the caller to report. */
      snapshotDir: string;
    } & ObservedPairFingerprints)
  | ({
      ok: false;
      /** Why verification did not prove out; carried verbatim into `rollbackError`. */
      message: string;
      snapshotDir: string;
    } & ObservedPairFingerprints);

/**
 * The fingerprint of the bytes at `path`, or the explicit absent marker.
 *
 * Unreadable is recorded the same way as missing, and deliberately: a destination
 * that is a directory, or a file the process may not open, is a pair whose bytes
 * *could not be observed*, which is the fact a human resolving the hold needs. A
 * thrown error there would replace that fact with a stack trace.
 */
function observedFingerprintOf(path: string): string {
  try {
    return sha256(readFileSync(path, "utf-8"));
  } catch {
    return RECOVERY_FINGERPRINT_ABSENT;
  }
}

function observedPairFingerprints(sliceDir: string): ObservedPairFingerprints {
  return {
    observedContractFingerprint: observedFingerprintOf(
      join(sliceDir, CONTRACT_FILENAME),
    ),
    observedManifestFingerprint: observedFingerprintOf(
      join(sliceDir, ACCEPTANCE_MANIFEST_FILENAME),
    ),
  };
}

/**
 * Restore the accepted pair from an attempt's snapshot and verify it (#333 B-01/B-02).
 *
 * The single exported implementation of restore-and-verify (#333 B-09): the
 * rollback writer below calls this rather than duplicating the compare, and #334's
 * launch-time reconciliation will call the same one, so "was the pair put back"
 * has exactly one answer in the codebase.
 *
 * The order of the three checks is load-bearing:
 *
 *  1. **Byte-equality against the snapshot copies.** The destination is reread
 *     from disk, not assumed from what was written, for the reason
 *     {@link publishAcceptedPairSnapshot} verifies its temporary sibling:
 *     verifying the bytes in hand proves nothing about the bytes on disk.
 *  2. **A valid `LOCKED` pair through {@link readLockedAcceptedPair}.** Restoring
 *     something that is not an authority to negotiate against is a failed restore
 *     even when the copy was faithful.
 *  3. **Fingerprint equality with the `PENDING` event.** Last because it is the
 *     check that catches a snapshot tampered with *after* publication: the copy
 *     matches and validates, and still is not what was accepted.
 *
 * Snapshot bytes are read before anything is written, so a missing snapshot file
 * leaves the destination exactly as it was. Every failure reports the fingerprints
 * observed on the destination, which is what the `ROLLBACK_FAILED` event records.
 */
export function restoreAcceptedPairFromSnapshot(args: {
  repoRoot: string;
  /** The target's artifact directory — where the pair is restored to. */
  sliceDir: string;
  /** The attempt's recorded locator and original fingerprints. */
  attempt: RecoveryAttemptLocator;
}): RestoreAcceptedPairResult {
  const snapshotDir = join(
    args.repoRoot,
    ...args.attempt.snapshotPath.split("/"),
  );
  const failure = (message: string): RestoreAcceptedPairResult => ({
    ok: false,
    message,
    snapshotDir,
    ...observedPairFingerprints(args.sliceDir),
  });

  let snapshot: { contract: string; manifest: string };
  try {
    snapshot = {
      contract: readFileSync(join(snapshotDir, CONTRACT_FILENAME), "utf-8"),
      manifest: readFileSync(
        join(snapshotDir, ACCEPTANCE_MANIFEST_FILENAME),
        "utf-8",
      ),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failure(
      `The accepted-pair snapshot for attempt ${args.attempt.attemptId} at ${snapshotDir} could not be read (${detail}); nothing was restored`,
    );
  }

  try {
    mkdirSync(args.sliceDir, { recursive: true });
    writeFileSync(join(args.sliceDir, CONTRACT_FILENAME), snapshot.contract);
    writeFileSync(
      join(args.sliceDir, ACCEPTANCE_MANIFEST_FILENAME),
      snapshot.manifest,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failure(
      `Writing the accepted pair for attempt ${args.attempt.attemptId} into ${args.sliceDir} failed (${detail})`,
    );
  }

  const observed = observedPairFingerprints(args.sliceDir);
  let restored: { contract: string; manifest: string };
  try {
    restored = {
      contract: readFileSync(join(args.sliceDir, CONTRACT_FILENAME), "utf-8"),
      manifest: readFileSync(
        join(args.sliceDir, ACCEPTANCE_MANIFEST_FILENAME),
        "utf-8",
      ),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failure(
      `The restored accepted pair in ${args.sliceDir} could not be reread (${detail})`,
    );
  }
  for (const [name, expected, actual] of [
    [CONTRACT_FILENAME, snapshot.contract, restored.contract],
    [ACCEPTANCE_MANIFEST_FILENAME, snapshot.manifest, restored.manifest],
  ] as const) {
    if (expected !== actual) {
      return failure(
        `The restored ${name} in ${args.sliceDir} is not byte-identical to the snapshot copy under ${snapshotDir}`,
      );
    }
  }

  const pair = readLockedAcceptedPair(args.sliceDir);
  if (pair === undefined) {
    return failure(
      `The pair restored into ${args.sliceDir} is not a valid LOCKED contract.md / ${ACCEPTANCE_MANIFEST_FILENAME} pair`,
    );
  }
  if (
    pair.contractFingerprint !== args.attempt.contractFingerprint ||
    pair.manifestFingerprint !== args.attempt.manifestFingerprint
  ) {
    return failure(
      `The pair restored into ${args.sliceDir} does not match the fingerprints attempt ${args.attempt.attemptId} recorded when it was admitted; the snapshot under ${snapshotDir} is not the pair that was accepted`,
    );
  }

  return { ok: true, snapshotDir, ...observed };
}

/** Every admitted reason an attempt can end unsuccessfully (#333 B-03). */
export type RecoveryFailureTrigger =
  | "provider-failure"
  | "evaluator-non-acceptance"
  | "deterministic-validation-refusal"
  | "lock-gate-refusal"
  | "cancellation"
  /**
   * A completion's locked recheck found the scope fingerprint no longer equal to
   * the one the `PENDING` event recorded (#335 B-03).
   *
   * Its own trigger rather than a reuse of `deterministic-validation-refusal`,
   * because nothing about the replacement pair was wrong: the run the attempt was
   * admitted against changed underneath it, which is a different thing for an
   * operator to read and a different thing to act on.
   */
  | "completion-cas-lost";

/**
 * The caller's original failure, carried through the rollback untouched.
 *
 * Opaque on purpose: {@link rollBackRecoveryAttempt} never branches on `trigger`,
 * because the rollback a provider crash needs and the rollback a cancellation
 * needs are the same rollback. The value is returned unchanged so the caller's own
 * error path stays the one that decides what the run does next.
 */
export interface RecoveryFailure {
  trigger: RecoveryFailureTrigger;
  message: string;
}

export type RollBackRecoveryAttemptResult<F extends RecoveryFailure> =
  | {
      /** The pair was restored, verified, and `ROLLED_BACK` was appended. */
      rolledBack: true;
      /** The caller's original failure value, returned unchanged. */
      failure: F;
      event: PersistedRecoveryLineageEvent;
    }
  | {
      rolledBack: false;
      failure: F;
      code: RecoveryRefusalCode;
      message: string;
      /** The appended `ROLLBACK_FAILED` event, absent when nothing was appended. */
      event?: PersistedRecoveryLineageEvent;
    };

/** The trailing event a rollback is allowed to append after. */
function rollbackableEvent(
  state: RunState,
  ghIssue: string,
): PersistedRecoveryLineageEvent | undefined {
  const events = recoveryLineageFor(state, ghIssue);
  const last = events[events.length - 1];
  return last?.state === "PENDING" || last?.state === "ROLLBACK_FAILED"
    ? last
    : undefined;
}

/** The three members a `COMPLETED` event carries and no other state may (#335 B-12). */
export interface RecoveryCompletionRecord {
  /** SHA-256 of the replacement `contract.md` the attempt accepted. */
  replacementContractFingerprint: string;
  /** SHA-256 of the replacement `acceptance-manifest.json`. */
  replacementManifestFingerprint: string;
  /** The lock exit's provenance stamp, opaque to this module (ADR 0055 §4). */
  lockProvenance: string;
}

/**
 * The next event, built from the trailing one so `attemptId` is copied verbatim.
 *
 * The three rollback-failure members are stripped before the spread rather than
 * left to be overwritten: a `ROLLED_BACK` event appended after a failed rollback
 * would otherwise inherit that failure's observations, and run state rejects a
 * `ROLLED_BACK` event carrying them (#333 B-06). The same strip is what lets a
 * `COMPLETED` event be built here too, since run state rejects one carrying them
 * as well (#335 B-12) — one builder for every terminal event, so no two of them
 * can disagree about which members are copied forward.
 */
function nextRecoveryEvent(
  trailing: PersistedRecoveryLineageEvent,
  next:
    | { state: "ROLLED_BACK" }
    | ({ state: "ROLLBACK_FAILED"; rollbackError: string } & ObservedPairFingerprints)
    | ({ state: "COMPLETED" } & RecoveryCompletionRecord),
): PersistedRecoveryLineageEvent {
  const {
    rollbackError: _error,
    observedContractFingerprint: _contract,
    observedManifestFingerprint: _manifest,
    ...base
  } = trailing;
  return {
    ...base,
    ...next,
    target: { ...trailing.target },
    extensions: [...trailing.extensions],
    recordedAt: new Date().toISOString(),
  };
}

export interface RollBackRecoveryAttemptArgs<F extends RecoveryFailure> {
  repoRoot: string;
  /** PRD slug — artifact identity. */
  prdSlug: string;
  /** Run slug: which run-state file this attempt was admitted in (ADR 0002). */
  runSlug?: string;
  /** The target's artifact directory, where the accepted pair is restored. */
  sliceDir: string;
  ghIssue: string;
  /** The failure that ended the attempt, returned unchanged either way. */
  failure: F;
}

/**
 * Roll one admitted recovery attempt back, verified (#333 B-03/B-04/B-06).
 *
 * The sequence, and why it is this sequence:
 *
 *  1. Read run state and refuse unless the target's lineage ends on an
 *     unresolved attempt — a `PENDING` one, or a `ROLLBACK_FAILED` one whose
 *     obstacle has since been cleared (#333 B-08). A refusal here writes nothing.
 *  2. Restore and verify through {@link restoreAcceptedPairFromSnapshot}, outside
 *     the lock: it is the slow part, it touches only this attempt's own slice
 *     directory, and the event that records its outcome is appended after it.
 *  3. Under the ADR 0056 lock, reload, recheck that the trailing event is still
 *     the same attempt in the same state, admit the transition through
 *     {@link isLegalRecoveryTransition}, and append exactly one event.
 *
 * Nothing here touches a ref, a commit or the preserved worktree (ADR 0039): a
 * rollback restores two artifact files and appends one record, and the unmerged
 * work the attempt exists to preserve is never the thing being rolled back.
 *
 * A retry that fails again appends nothing: `ROLLBACK_FAILED -> ROLLBACK_FAILED`
 * is not a legal transition, so the hold the first failure recorded simply stays
 * in force rather than accumulating one record per attempt to clear it.
 */
export function rollBackRecoveryAttempt<F extends RecoveryFailure>(
  args: RollBackRecoveryAttemptArgs<F>,
): RollBackRecoveryAttemptResult<F> {
  const runSlug = args.runSlug ?? args.prdSlug;
  const trailing = rollbackableEvent(
    loadRunState(args.repoRoot, runSlug),
    args.ghIssue,
  );
  if (trailing === undefined) {
    return {
      rolledBack: false,
      failure: args.failure,
      code: "no-pending-attempt",
      message: `No unresolved recovery attempt exists for #${args.ghIssue}, so there is nothing to roll back`,
    };
  }

  const restored = restoreAcceptedPairFromSnapshot({
    repoRoot: args.repoRoot,
    sliceDir: args.sliceDir,
    attempt: trailing,
  });
  const next: Parameters<typeof nextRecoveryEvent>[1] = restored.ok
    ? { state: "ROLLED_BACK" }
    : {
        state: "ROLLBACK_FAILED",
        rollbackError: restored.message,
        observedContractFingerprint: restored.observedContractFingerprint,
        observedManifestFingerprint: restored.observedManifestFingerprint,
      };

  return transactRunState<RollBackRecoveryAttemptResult<F>>(
    args.repoRoot,
    runSlug,
    (locked) => {
      const refuse = (
        code: RecoveryRefusalCode,
        message: string,
      ): { changed: false; result: RollBackRecoveryAttemptResult<F> } => ({
        changed: false,
        result: { rolledBack: false, failure: args.failure, code, message },
      });

      const current = rollbackableEvent(locked, args.ghIssue);
      if (
        current === undefined ||
        current.attemptId !== trailing.attemptId ||
        current.state !== trailing.state
      ) {
        return refuse(
          "facts-changed-before-lock",
          `The recovery lineage for #${args.ghIssue} changed between the restore and the run-state lock; no ${next.state} event was appended for attempt ${trailing.attemptId}`,
        );
      }
      if (!isLegalRecoveryTransition(current.state, next.state)) {
        return refuse(
          "rollback-verification-failed",
          `${restored.ok ? "The rollback verified" : restored.message}; ${current.state} -> ${next.state} is not a legal recovery transition, so nothing was appended for attempt ${trailing.attemptId}`,
        );
      }

      const event = nextRecoveryEvent(current, next);
      appendRecoveryLineageEvent(locked, args.ghIssue, event);
      return {
        changed: true,
        result: restored.ok
          ? { rolledBack: true, failure: args.failure, event }
          : {
              rolledBack: false,
              failure: args.failure,
              code: "rollback-verification-failed",
              message: restored.message,
              event,
            },
      };
    },
  );
}

/** Every reason a completion ends without a `COMPLETED` event (#335 B-01/B-03). */
export type CompleteRecoveryAttemptRefusalCode = Extract<
  RecoveryRefusalCode,
  | "no-pending-attempt"
  | "accepted-pair-invalid"
  | "lock-gate-refused"
  | "facts-changed-before-lock"
>;

export interface CompleteRecoveryAttemptArgs {
  repoRoot: string;
  /** PRD slug — artifact identity. */
  prdSlug: string;
  /** Run slug: which run-state file this attempt was admitted in (ADR 0002). */
  runSlug?: string;
  /** The target's artifact directory, holding the replacement pair. */
  sliceDir: string;
  ghIssue: string;
  /**
   * The mechanical lock gate: migration-prefix and run-specific checks. Returns
   * `null` to admit, or a reason string to refuse.
   *
   * Required and *injected*, structurally the same shape as
   * `ContractTransactionContext.onContractLocked`, rather than imported: the gate's
   * owner sits outside this slice's file scope, and the module it lives beside is a
   * Review-rails internal this module may not import (ARCHITECTURE.md "Internals
   * (do not import)"). Injection also makes "the completion reaches exactly one
   * gate" a type-level fact instead of a convention.
   */
  lockGate: (contractPath: string) => string | null;
  /**
   * The provenance stamp for this lock exit, opaque and non-blank (ADR 0055 §4).
   *
   * Supplied by the caller rather than formatted here for the same reason the gate
   * is injected: the wording belongs to the stamp's owner, and a completion that
   * formatted its own would be a second source of truth for it. Blank or missing is
   * refused exactly as a refusing gate is — "every lock exit stamps, no special
   * cases" is not satisfied by a stamp nobody supplied.
   */
  provenance: string;
  /**
   * Test seam: fires after the preconditions are evaluated and before the
   * completion takes the ADR 0056 lock, mirroring
   * {@link AdmitStaleRenegotiationArgs.beforeLockAcquired} and for the same
   * reason — the interleave being proven is this module's sequencing.
   */
  beforeLockAcquired?: () => void;
}

export type CompleteRecoveryAttemptResult =
  | {
      /** One `COMPLETED` event was appended, and nothing else was written. */
      completed: true;
      attemptId: string;
      event: PersistedRecoveryLineageEvent;
    }
  | {
      completed: false;
      code: CompleteRecoveryAttemptRefusalCode;
      message: string;
      /** The attempt the refusal is about, when one was trailing to name. */
      attemptId?: string;
      /**
       * The failure the attempt was ended with and #333's outcome for it. Both
       * absent on the one ending that writes nothing anywhere — the trailing event
       * is no longer this attempt's, so there is no attempt here left to end.
       */
      failure?: RecoveryFailure;
      rollback?: RollBackRecoveryAttemptResult<RecoveryFailure>;
    };

/** How a trailing event reads in a refusal message, or that there is none. */
function describeTrailingRecoveryEvent(
  trailing: PersistedRecoveryLineageEvent | undefined,
): string {
  return trailing === undefined
    ? "the lineage is empty"
    : `attempt ${trailing.attemptId} trails in state ${trailing.state}`;
}

/**
 * End a completion the way every unsuccessful ending ends — through #333's writer.
 *
 * The read here is what authorizes the delegation, and it is not optional.
 * {@link rollBackRecoveryAttempt} takes no `attemptId`: it reloads run state and
 * acts on whatever unresolved event trails. Handing it a lineage that has moved on
 * would restore *another* attempt's snapshot over this slice's pair, and after a
 * `ROLLED_BACK` event {@link hasOpenRecoveryAttempt} is false, so a freshly
 * admitted `PENDING` attempt really can be the thing trailing. Teaching the writer
 * an `attemptId` is what P-02 forbids, so the caller checks instead — and when the
 * check fails, nothing is restored, nothing is appended and no rollback is called.
 */
function endCompletionThroughRollback(args: {
  repoRoot: string;
  prdSlug: string;
  runSlug: string;
  sliceDir: string;
  ghIssue: string;
  attemptId: string;
  code: CompleteRecoveryAttemptRefusalCode;
  trigger: RecoveryFailureTrigger;
  message: string;
}): CompleteRecoveryAttemptResult {
  const events = recoveryLineageFor(
    loadRunState(args.repoRoot, args.runSlug),
    args.ghIssue,
  );
  const trailing = events[events.length - 1];
  if (
    trailing === undefined ||
    trailing.attemptId !== args.attemptId ||
    trailing.state !== "PENDING"
  ) {
    return {
      completed: false,
      code: "facts-changed-before-lock",
      message:
        `${args.message}. The recovery lineage for #${args.ghIssue} no longer ends on ` +
        `attempt ${args.attemptId} in state PENDING (${describeTrailingRecoveryEvent(trailing)}), ` +
        `so no COMPLETED event was appended, nothing was restored and no rollback was called`,
      attemptId: args.attemptId,
    };
  }

  const failure: RecoveryFailure = {
    trigger: args.trigger,
    message: args.message,
  };
  const rollback = rollBackRecoveryAttempt({
    repoRoot: args.repoRoot,
    prdSlug: args.prdSlug,
    runSlug: args.runSlug,
    sliceDir: args.sliceDir,
    ghIssue: args.ghIssue,
    failure,
  });
  return {
    completed: false,
    code: args.code,
    message: args.message,
    attemptId: args.attemptId,
    failure,
    rollback,
  };
}

/**
 * Complete one admitted recovery attempt, or end it (#335 B-01/B-02/B-03).
 *
 * The sequence, and why it is this sequence:
 *
 *  1. Read run state once and refuse unless the target's lineage ends on a
 *     `PENDING` event. That event names the attempt everything below is about; the
 *     completion never mints or is told an id.
 *  2. Evaluate the three preconditions, in this order and with no second path:
 *     the replacement pair through {@link readLockedAcceptedPair}, then the
 *     injected {@link CompleteRecoveryAttemptArgs.lockGate}, then a non-blank
 *     {@link CompleteRecoveryAttemptArgs.provenance}. The gate runs only once the
 *     pair validated, so a gate can never be what admits a pair the module's only
 *     pair reader rejected.
 *  3. `beforeLockAcquired` — the interleave seam.
 *  4. On a precondition refusal, end the attempt through #333's writer. A refusal
 *     is *terminal* for the attempt, not a lingering `PENDING`: leaving it open
 *     would hold the target's dispatch on an attempt nobody is still working.
 *  5. Otherwise take the ADR 0056 lock exactly once, reload, recheck the trailing
 *     event and the scope fingerprint, and append exactly one `COMPLETED` event.
 *  6. A recheck that lost the scope fingerprint while this attempt was still
 *     trailing ends through the same writer, called *after* the transaction
 *     returned and released the lock — the way {@link reconcileRecoveryLineage}
 *     already calls it, and the only way that does not take the lock twice over.
 *
 * Nothing here moves a ref, and nothing here restores, rolls back or appends a
 * `ROLLED_BACK`/`ROLLBACK_FAILED` event of its own (ADR 0039, #335 B-03).
 */
export function completeRecoveryAttempt(
  args: CompleteRecoveryAttemptArgs,
): CompleteRecoveryAttemptResult {
  const runSlug = args.runSlug ?? args.prdSlug;
  const admitted = recoveryLineageFor(
    loadRunState(args.repoRoot, runSlug),
    args.ghIssue,
  );
  const opened = admitted[admitted.length - 1];
  if (opened === undefined || opened.state !== "PENDING") {
    return {
      completed: false,
      code: "no-pending-attempt",
      message:
        `The recovery lineage for #${args.ghIssue} does not end on a PENDING attempt ` +
        `(${describeTrailingRecoveryEvent(opened)}), so there is nothing to complete`,
    };
  }
  const attemptId = opened.attemptId;

  const replacement = readLockedAcceptedPair(args.sliceDir);
  // The gate is reached only when the pair validated, and then exactly once, with
  // the replacement contract's own path. A gate that is not a function is a
  // refusal and not a call: a missing gate is never a skip (#335 B-01).
  const gate =
    replacement === undefined
      ? undefined
      : typeof args.lockGate === "function"
        ? args.lockGate(join(args.sliceDir, CONTRACT_FILENAME))
        : `no lock gate was supplied to the completion of attempt ${attemptId}`;
  const provenance =
    typeof args.provenance === "string" ? args.provenance.trim() : "";

  /** All three preconditions, decided together so none can be reached alone. */
  type Preconditions =
    | { held: true; replacement: AcceptedPairBytes; provenance: string }
    | {
        held: false;
        code: CompleteRecoveryAttemptRefusalCode;
        trigger: RecoveryFailureTrigger;
        message: string;
      };
  const preconditions: Preconditions =
    replacement === undefined
      ? {
          held: false,
          code: "accepted-pair-invalid",
          trigger: "deterministic-validation-refusal",
          message:
            `${args.sliceDir} does not hold a valid LOCKED ${CONTRACT_FILENAME} / ` +
            `${ACCEPTANCE_MANIFEST_FILENAME} pair, so recovery attempt ${attemptId} ` +
            `has no replacement pair to complete on`,
        }
      : gate !== null && gate !== undefined
        ? {
            held: false,
            code: "lock-gate-refused",
            trigger: "lock-gate-refusal",
            message:
              `The mechanical lock gate refused the replacement pair in ${args.sliceDir} ` +
              `for recovery attempt ${attemptId} (${gate})`,
          }
        : provenance === ""
          ? {
              held: false,
              code: "lock-gate-refused",
              trigger: "lock-gate-refusal",
              message:
                `No lock provenance was supplied for the completion of recovery attempt ` +
                `${attemptId}; a lock exit that cannot say what stamped it is refused ` +
                `exactly as a refusing gate is`,
            }
          : { held: true, replacement, provenance };

  args.beforeLockAcquired?.();

  const end = (
    code: CompleteRecoveryAttemptRefusalCode,
    trigger: RecoveryFailureTrigger,
    message: string,
  ): CompleteRecoveryAttemptResult =>
    endCompletionThroughRollback({
      repoRoot: args.repoRoot,
      prdSlug: args.prdSlug,
      runSlug,
      sliceDir: args.sliceDir,
      ghIssue: args.ghIssue,
      attemptId,
      code,
      trigger,
      message,
    });

  if (!preconditions.held) {
    return end(
      preconditions.code,
      preconditions.trigger,
      preconditions.message,
    );
  }

  /** What the one locked body decided, so the caller can act after the lock. */
  type LockedCompletion =
    | { appended: true; event: PersistedRecoveryLineageEvent }
    /** The recheck lost the scope fingerprint with this attempt still trailing. */
    | { appended: false; casLost: true; message: string }
    /** The trailing event is not this attempt's `PENDING` one: write nothing. */
    | { appended: false; casLost: false; message: string };

  const decided = transactRunState<LockedCompletion>(
    args.repoRoot,
    runSlug,
    (locked) => {
      const events = recoveryLineageFor(locked, args.ghIssue);
      const current = events[events.length - 1];
      if (
        current === undefined ||
        current.attemptId !== attemptId ||
        current.state !== "PENDING" ||
        // Checked rather than assumed even though `PENDING -> COMPLETED` is legal
        // by construction: the transition table is the one authority on what may
        // be appended, and a completion that skipped it would be a second one.
        !isLegalRecoveryTransition(current.state, "COMPLETED")
      ) {
        return {
          changed: false,
          result: {
            appended: false,
            casLost: false,
            message:
              `The recovery lineage for #${args.ghIssue} no longer ends on attempt ` +
              `${attemptId} in state PENDING (${describeTrailingRecoveryEvent(current)}); ` +
              `no COMPLETED event was appended, nothing was restored and no rollback was called`,
          },
        };
      }
      const observed =
        locked.scope === undefined
          ? RECOVERY_FINGERPRINT_ABSENT
          : runScopeFingerprint(locked.scope);
      if (observed !== current.scopeFingerprint) {
        return {
          changed: false,
          result: {
            appended: false,
            casLost: true,
            message:
              `The run's persisted scope changed before the completion of recovery attempt ` +
              `${attemptId} held the run-state lock: the attempt was admitted against ` +
              `${current.scopeFingerprint} and the lock observed ${observed}`,
          },
        };
      }

      const event = nextRecoveryEvent(current, {
        state: "COMPLETED",
        replacementContractFingerprint:
          preconditions.replacement.contractFingerprint,
        replacementManifestFingerprint:
          preconditions.replacement.manifestFingerprint,
        lockProvenance: preconditions.provenance,
      });
      appendRecoveryLineageEvent(locked, args.ghIssue, event);
      return { changed: true, result: { appended: true, event } };
    },
  );

  if (decided.appended) {
    return { completed: true, attemptId, event: decided.event };
  }
  if (!decided.casLost) {
    return {
      completed: false,
      code: "facts-changed-before-lock",
      message: decided.message,
      attemptId,
    };
  }
  return end(
    "facts-changed-before-lock",
    "completion-cas-lost",
    decided.message,
  );
}

/** A held dispatch, naming the attempt a human has to resolve first (#333 B-07). */
export interface RecoveryDispatchRefusal {
  code: Extract<RecoveryRefusalCode, "rollback-failed-hold">;
  message: string;
  /** Read off the trailing event, not derived. */
  attemptId: string;
  snapshotPath: string;
}

/**
 * Refuse agent dispatch while a target's rollback is unresolved (#333 B-07).
 *
 * Fail-closed on the *last* event rather than on "any `ROLLBACK_FAILED` in the
 * list", because a later `ROLLED_BACK` for the same attempt is exactly the record
 * that says the obstacle was cleared, and holding forever on a repaired attempt
 * would make the retry #333 B-08 admits pointless.
 *
 * The message names the `attemptId` and the `snapshotPath` because those are the
 * two things a human needs to fix it by hand: which attempt, and where the bytes
 * that were accepted still are. Exported for #334's launch-time reconciliation to
 * call; this slice wires it into no dispatch site.
 */
export function recoveryDispatchRefusal(
  state: RunState,
  ghIssue: string,
): RecoveryDispatchRefusal | undefined {
  const events = recoveryLineageFor(state, ghIssue);
  const last = events[events.length - 1];
  if (last?.state !== "ROLLBACK_FAILED") return undefined;
  return {
    code: "rollback-failed-hold",
    message:
      `Recovery attempt ${last.attemptId} for #${ghIssue} failed to roll back` +
      ` (${last.rollbackError ?? "no reason recorded"}), so no agent is dispatched` +
      ` for this slice; the accepted pair as admitted is still at ${last.snapshotPath}`,
    attemptId: last.attemptId,
    snapshotPath: last.snapshotPath,
  };
}

/** A dispatch held because a completed replacement pair drifted (#335 B-04). */
export interface RecoveryPreDispatchRefusal {
  code: Extract<RecoveryRefusalCode, "completed-pair-drifted">;
  message: string;
  /** Read off the trailing `COMPLETED` event, not derived. */
  attemptId: string;
  /**
   * The fingerprints actually found in the slice directory —
   * {@link RECOVERY_FINGERPRINT_ABSENT} when it holds no valid `LOCKED` pair at
   * all, for the reason a failed rollback records the same marker.
   */
  observedContractFingerprint: string;
  observedManifestFingerprint: string;
}

/**
 * Refuse agent dispatch when a completed replacement pair no longer matches (#335 B-04).
 *
 * The sibling of {@link recoveryDispatchRefusal}, and deliberately a separate
 * predicate over a separate trailing state: that one holds an unresolved
 * `ROLLBACK_FAILED`, this one holds a resolved `COMPLETED` whose replacement pair
 * has since changed. A target whose lineage does not end on `COMPLETED` is not this
 * predicate's business and gets `undefined` — merging the two into one "is dispatch
 * allowed" answer would make either hold's reason unreadable.
 *
 * Within its own domain it fails closed: the pair has to be a valid `LOCKED` pair
 * *and* fingerprint-identical to what the `COMPLETED` event recorded. A reopened,
 * unparseable, mutated or missing pair all refuse, because a generator dispatched
 * against a pair nobody accepted is exactly the outcome the completion event exists
 * to make checkable. The message names the attempt and both observed fingerprints,
 * because "which attempt" and "what is there instead" are what a human needs.
 *
 * The pair is re-read here rather than passed in, so the answer is about the bytes
 * on disk at dispatch time and not about a read that happened earlier. Exported for
 * #336's dispatch reporting to call; this slice wires it into no dispatch site.
 */
export function recoveryPreDispatchRefusal(
  state: RunState,
  ghIssue: string,
  sliceDir: string,
): RecoveryPreDispatchRefusal | undefined {
  const events = recoveryLineageFor(state, ghIssue);
  const last = events[events.length - 1];
  if (last?.state !== "COMPLETED") return undefined;
  const pair = readLockedAcceptedPair(sliceDir);
  const observedContractFingerprint =
    pair?.contractFingerprint ?? RECOVERY_FINGERPRINT_ABSENT;
  const observedManifestFingerprint =
    pair?.manifestFingerprint ?? RECOVERY_FINGERPRINT_ABSENT;
  if (
    observedContractFingerprint === last.replacementContractFingerprint &&
    observedManifestFingerprint === last.replacementManifestFingerprint
  ) {
    return undefined;
  }
  return {
    code: "completed-pair-drifted",
    message:
      `Recovery attempt ${last.attemptId} for #${ghIssue} completed on a replacement pair ` +
      `fingerprinted ${last.replacementContractFingerprint} / ` +
      `${last.replacementManifestFingerprint}, but ${sliceDir} now holds ` +
      `${observedContractFingerprint} / ${observedManifestFingerprint}, so no agent is ` +
      `dispatched for this slice until the accepted pair is the one that was completed`,
    attemptId: last.attemptId,
    observedContractFingerprint,
    observedManifestFingerprint,
  };
}

/** What launch-time reconciliation did to one target (#334 B-01). */
export interface RecoveryReconciliationOutcome {
  ghIssue: string;
  /** Copied from the trailing event; reconciliation never mints an id. */
  attemptId: string;
  /** The unresolved state reconciliation found the lineage on. */
  trailingState: Extract<RecoveryLineageState, "PENDING" | "ROLLBACK_FAILED">;
  /**
   * The state of the event appended, or `"none"` when nothing was appended —
   * a retry that failed again, or a locator that never resolved.
   */
  appended:
    | Extract<RecoveryLineageState, "ROLLED_BACK" | "ROLLBACK_FAILED">
    | "none";
  /** The locator as recorded, verbatim. */
  snapshotPath: string;
  /** `snapshotPath` resolved against the repo root, accepted or not. */
  snapshotDir: string;
  /** The artifact directory the restore wrote to, or would have. */
  sliceDir: string;
  /** Whether the locator was refused before any file was read or written. */
  locatorRejected: boolean;
  /** The run-state file this reconciliation read and appended to. */
  runStateFile: string;
  /** Why the attempt is not resolved; absent only on a verified `ROLLED_BACK`. */
  message?: string;
}

/** The restore destination a locator resolves to, or why it does not. */
interface DerivedRestoreDestination {
  snapshotDir: string;
  /** The grandparent of {@link snapshotDir} — reported even when rejected. */
  sliceDir: string;
  /** Present when the locator is not of the accepted form. */
  rejection?: string;
}

/**
 * Resolve `<sliceDir>/recovery-snapshots/<attemptId>` and nothing else (#334 B-03).
 *
 * The destination is the *grandparent* of the resolved snapshot directory,
 * because that is what {@link publishAcceptedPairSnapshot} built the locator
 * from — `relative(repoRoot, join(sliceDir, RECOVERY_SNAPSHOT_DIRNAME,
 * attemptId))`. Deriving it back out is only sound if the locator really has
 * that shape, so the shape is checked rather than assumed.
 *
 * The check that earns its keep is the segment count. A two-segment
 * `recovery-snapshots/<attemptId>` has the empty string for a grandparent, so
 * its derived destination collapses onto `repoRoot` and a restore would rewrite
 * `contract.md` and `acceptance-manifest.json` at the repository root — which no
 * "only the two accepted-pair files changed" assertion can catch, because those
 * *are* two accepted-pair files.
 *
 * Purely computational: nothing here touches the filesystem, so a rejected
 * locator has read and written nothing by the time it is reported.
 */
function deriveRestoreDestination(
  repoRoot: string,
  snapshotPath: string,
): DerivedRestoreDestination {
  const segments = snapshotPath.split("/");
  const snapshotDir = join(repoRoot, ...segments);
  const sliceDir = dirname(dirname(snapshotDir));
  const reject = (rejection: string): DerivedRestoreDestination => ({
    snapshotDir,
    sliceDir,
    rejection,
  });

  const unusable = segments.find(
    (segment) => segment === "" || segment === "." || segment === "..",
  );
  if (unusable !== undefined) {
    return reject(`the segment "${unusable}" is empty, "." or ".."`);
  }
  if (segments.length < 3) {
    const derived = segments.slice(0, -2).join("/");
    return reject(
      `it has ${segments.length} "/"-separated segment(s), so the <sliceDir> it ` +
        `derives is ${derived === "" ? "the empty string" : `"${derived}"`} rather ` +
        `than the target's artifact directory`,
    );
  }
  if (segments[segments.length - 2] !== RECOVERY_SNAPSHOT_DIRNAME) {
    return reject(
      `its penultimate segment is "${segments[segments.length - 2]}" rather than ` +
        `"${RECOVERY_SNAPSHOT_DIRNAME}"`,
    );
  }
  return { snapshotDir, sliceDir };
}

/**
 * GitHub issue ids ascending, numerically where both are numbers.
 *
 * Numeric first because these are issue numbers: `#9` sorts before `#10` for a
 * human reading the log lines, and a lexicographic sort would put it after.
 */
function compareGhIssue(a: string, b: string): number {
  const left = Number(a);
  const right = Number(b);
  if (Number.isInteger(left) && Number.isInteger(right) && left !== right) {
    return left - right;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Resolve every unresolved recovery attempt in one run's lineage (#334 B-01/B-02).
 *
 * The routine a launch calls before it does anything else. A process that
 * admitted a `PENDING` attempt and then died left the accepted pair reopened
 * with no process intending to finish the renegotiation; until that is put back,
 * every later reader of the pair is reading something no one accepted. So the
 * first thing a launch establishes is that no target is in that state.
 *
 * Unresolved is the same predicate a rollback already applies — a trailing
 * `PENDING`, or a trailing `ROLLBACK_FAILED` whose obstacle may since have been
 * cleared ({@link rollbackableEvent}). Every other target is left alone, and a
 * target with a terminal trailing event is reported not at all: a launch that
 * reconciles nothing must be indistinguishable from a launch before this
 * existed (#334 P-03).
 *
 * Each target is handed to {@link rollBackRecoveryAttempt} rather than restored
 * and appended here. That is the deliberate reading of "adds no second restore
 * implementation and no second verification rule": the two-phase sequence
 * — restore outside the ADR 0056 lock, then reread, recheck the trailing
 * `attemptId` and state, admit the transition and append exactly one event
 * inside it — already exists there, and a copy of it here would be a second
 * answer to "was the pair put back" the moment either drifted. The `trigger` is
 * `cancellation` because that is what an abrupt process death is from the
 * attempt's point of view; the rollback writer never branches on it, and the
 * value is returned to this caller rather than persisted.
 *
 * Ordered by `ghIssue` so the caller's operator lines are deterministic, which
 * is the only reason the order is specified at all.
 */
export function reconcileRecoveryLineage(args: {
  repoRoot: string;
  prdSlug: string;
  /** Which run-state file to reconcile; the bare PRD slug by default (ADR 0002). */
  runSlug?: string;
}): RecoveryReconciliationOutcome[] {
  const runSlug = args.runSlug ?? args.prdSlug;
  // Named rather than derived from run-state, which keeps its path private. The
  // operator line has to say which file holds the hold, so the path is a fact
  // this module reports; it is the one place here that knows the layout.
  const runStateFile = join(
    args.repoRoot,
    ".afk",
    "state",
    `${runSlug}.json`,
  );
  const state = loadRunState(args.repoRoot, runSlug);
  const outcomes: RecoveryReconciliationOutcome[] = [];

  for (const ghIssue of Object.keys(state.recoveryLineage ?? {}).sort(
    compareGhIssue,
  )) {
    const trailing = rollbackableEvent(state, ghIssue);
    if (trailing === undefined) continue;
    const trailingState = trailing.state as Extract<
      RecoveryLineageState,
      "PENDING" | "ROLLBACK_FAILED"
    >;
    const derived = deriveRestoreDestination(
      args.repoRoot,
      trailing.snapshotPath,
    );
    const record = (
      fields: Pick<
        RecoveryReconciliationOutcome,
        "appended" | "locatorRejected" | "message"
      >,
    ): void => {
      outcomes.push({
        ghIssue,
        attemptId: trailing.attemptId,
        trailingState,
        snapshotPath: trailing.snapshotPath,
        snapshotDir: derived.snapshotDir,
        sliceDir: derived.sliceDir,
        runStateFile,
        ...fields,
      });
    };

    if (derived.rejection !== undefined) {
      record({
        appended: "none",
        locatorRejected: true,
        message:
          `The recovery snapshot locator "${trailing.snapshotPath}" recorded for ` +
          `attempt ${trailing.attemptId} is not of the form ` +
          `<sliceDir>/${RECOVERY_SNAPSHOT_DIRNAME}/<attemptId> (${derived.rejection}); ` +
          `it would have restored the accepted pair into ${derived.sliceDir}, so ` +
          `nothing was read, written or appended`,
      });
      continue;
    }

    const result = rollBackRecoveryAttempt({
      repoRoot: args.repoRoot,
      prdSlug: args.prdSlug,
      runSlug,
      sliceDir: derived.sliceDir,
      ghIssue,
      failure: {
        trigger: "cancellation",
        message:
          `The process that admitted recovery attempt ${trailing.attemptId} for ` +
          `#${ghIssue} exited without resolving it`,
      },
    });
    if (result.rolledBack) {
      record({ appended: "ROLLED_BACK", locatorRejected: false });
      continue;
    }
    record({
      appended: result.event?.state === "ROLLBACK_FAILED" ? "ROLLBACK_FAILED" : "none",
      locatorRejected: false,
      message: result.message,
    });
  }

  return outcomes;
}

/**
 * The operator line one reconciled target needs, retry included (#334 B-05).
 *
 * Lives beside the outcome shape rather than in the orchestrator, which is a hub
 * (ARCHITECTURE.md "Hubs"): the retry a given outcome needs is a fact about the
 * recovery protocol, not about the run loop that prints it.
 *
 * The retry is fixed per outcome rather than left to the reader, because the
 * three cases need three different human actions and the line is the only place
 * the operator learns which one applies. A `ROLLED_BACK` target is done: the
 * lineage is terminal and the next launch runs normally. A `ROLLBACK_FAILED`
 * appended now names the snapshot directory to repair, because the next launch
 * retries the same locator under `ROLLBACK_FAILED -> ROLLED_BACK`. An
 * append-nothing outcome names the run-state file and the `attemptId` and says
 * so plainly: no relaunch can move that lineage on its own, so the hold is
 * terminal until #335 supplies the completion path.
 */
export function describeRecoveryReconciliation(
  outcome: RecoveryReconciliationOutcome,
): string {
  const pair = `${CONTRACT_FILENAME} and ${ACCEPTANCE_MANIFEST_FILENAME}`;
  const repair =
    `repair the snapshot directory ${outcome.snapshotDir} — its ${pair} must again ` +
    `read as a valid LOCKED pair matching the fingerprints attempt ` +
    `${outcome.attemptId} recorded`;
  const head =
    `Recovery attempt ${outcome.attemptId} for #${outcome.ghIssue} was left ` +
    `unresolved on ${outcome.trailingState}`;

  if (outcome.appended === "ROLLED_BACK") {
    return (
      `${head}; this launch restored the accepted pair from ${outcome.snapshotDir} ` +
      `and appended ROLLED_BACK. Retry: relaunch the same command — the lineage is ` +
      `now terminal, so the next launch runs this slice normally.`
    );
  }
  if (outcome.appended === "ROLLBACK_FAILED") {
    return (
      `${head}; the rollback did not verify (${outcome.message}) and ` +
      `ROLLBACK_FAILED was appended. Retry: ${repair}, then relaunch — the next ` +
      `launch retries from the same snapshotPath "${outcome.snapshotPath}".`
    );
  }
  const cause = outcome.locatorRejected
    ? `the recorded snapshotPath "${outcome.snapshotPath}" is unusable ` +
      `(${outcome.message}), so the target stays held until #335's attempt-state ` +
      `reporting can resolve it`
    : `the retry failed again (${outcome.message}), so the existing hold stays in ` +
      `force. A human must ${repair}`;
  return (
    `${head}; nothing was appended: ${cause}. This hold is intentionally terminal ` +
    `until #335 supplies the completion path: attempt ${outcome.attemptId} in ` +
    `${outcome.runStateFile} stays as it is, and a relaunch alone will report the ` +
    `same target and stop again.`
  );
}
