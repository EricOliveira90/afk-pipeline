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
 * The completion half — the terminal events, verified rollback, launch-time
 * reconciliation — is #332 through #335. This module ships the persisted shape
 * and the transition rule those writers must obey, and none of the writers.
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
import { join, relative } from "node:path";
import { canonicalSliceNumber } from "./afk-manifest.js";
import {
  ACCEPTANCE_MANIFEST_FILENAME,
  parseAcceptanceManifest,
  validateAcceptanceManifestCoverage,
} from "./acceptance-manifest.js";
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
  /** The facts changed between snapshot publication and the locked recheck. */
  | "facts-changed-before-lock";

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
 * A published directory is never overwritten. An attempt id addresses exactly one
 * accepted pair; if a directory for it exists, either this attempt already
 * published or the id was reused, and both are refusals rather than a silent
 * clobber of the only immutable record of what was accepted (ADR 0039's reasoning
 * applied to artifacts instead of commits).
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
      admitted: false;
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

/**
 * Admit one stale-pair renegotiation request, or refuse it (#277 B-08/B-09).
 *
 * The sequence, and why it is this sequence:
 *
 *  1. Load run state and run read-only eligibility. A refusal here has touched
 *     nothing at all.
 *  2. Resolve both branch tips. These are recorded facts, not eligibility
 *     outcomes — an attempt whose tips cannot be named could never be reconciled.
 *  3. Publish the byte-verified snapshot. Outside the lock because it is the slow
 *     part, and safe outside it because an unreferenced snapshot is inert.
 *  4. `beforeLockAcquired` — the interleave seam.
 *  5. Take the run-state lock, reload, and recheck every fact steps 1-3 read.
 *     Any drift is a pre-admission refusal that writes nothing.
 *  6. Append exactly one `PENDING` event. This is the first admitted mutation.
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
