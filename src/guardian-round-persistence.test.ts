/**
 * Unit tests for the guardian round persistence module: what a loaded round
 * ledger is allowed to claim, and what a write to it does (#221).
 *
 * These assertions came from `run-state.test.ts` with the logic they cover. They
 * exercise the normalizer through `sanitizeReviewPhase` where the point is the
 * loader's composition — the guardian fields beside the sanity cache on disk —
 * and through the module's own operations where the point is a write.
 *
 * A real temp repo, no spawned pipeline: every rule here is reachable from a
 * state file and a writer, which is the top of the placement ladder.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adaptLoadedState,
  isSliceComplete,
  loadRunState,
  sanitizeReviewPhase,
  saveSliceState,
} from "./run-state.js";
import {
  appendCompletedGuardianRound,
  loadGuardianRoundLedger,
  recordFiledGuardianFindings,
  recordGuardianFindingReconciliations,
} from "./guardian-round-persistence.js";
import type {
  PersistedFiledFinding,
  PersistedGuardianReviewRound,
} from "./guardian-round-records.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-guardian-rounds-"));
  tempDirs.push(dir);
  return dir;
}

/** ADR 0015: cheap re-entry cache for the post-merge review phase. */
describe("review-phase persistence", () => {
  const finding = {
    stableId: "A-01",
    currentId: "A-01",
    title: "Durable evidence is missing",
    class: "INTEGRITY",
    clearCondition: "Persist the evidence.",
    disposition: "OPEN" as const,
    reachableTrigger: "A retry consumes an incomplete durable record.",
    introducedByReviewedDiff: true,
  };
  const invokedRound = (
    round: number,
    architectOutcome:
      | "SHIP"
      | "ACCEPT-WITH-NOTES"
      | "FIX-BEFORE-SHIP"
      | "UNPARSEABLE"
      | "NEVER_RAN"
      | "DIED_MID_RUN" = "SHIP",
    pmOutcome:
      | "SHIP"
      | "ACCEPT-WITH-NOTES"
      | "FIX-BEFORE-SHIP"
      | "UNPARSEABLE"
      | "NEVER_RAN"
      | "DIED_MID_RUN" = "SHIP",
  ): PersistedGuardianReviewRound => ({
    round,
    reviewedHeadSha: `reviewed-${round}`,
    headSha: `head-${round}`,
    architect: {
      source: "INVOKED",
      outcome: architectOutcome,
      findings:
        architectOutcome === "ACCEPT-WITH-NOTES" ||
        architectOutcome === "FIX-BEFORE-SHIP"
          ? [{ ...finding }]
          : [],
      findingsOriginRound: round,
    },
    pm: {
      source: "INVOKED",
      outcome: pmOutcome,
      findings:
        pmOutcome === "ACCEPT-WITH-NOTES" ||
        pmOutcome === "FIX-BEFORE-SHIP"
          ? [
              {
                ...finding,
                stableId: "P-01",
                currentId: "P-01",
                reachableTrigger: null,
                introducedByReviewedDiff: null,
              },
            ]
          : [],
      findingsOriginRound: round,
    },
  });

  it("loads the ledger a round decision reads, absences included", () => {
    const repo = makeRepo();
    // A run that has recorded nothing and a run whose review phase carries only
    // caches answer the same way: no round, nothing filed. The adapter, not
    // every caller, is what spells that.
    expect(loadGuardianRoundLedger(undefined)).toEqual({
      rounds: [],
      filedFindings: [],
    });
    expect(
      loadGuardianRoundLedger({ sanity: { treeSha: "abc", ok: true } }),
    ).toEqual({ rounds: [], filedFindings: [] });

    appendCompletedGuardianRound(repo, "demo", { rounds: [invokedRound(1)] });
    recordFiledGuardianFindings(repo, "demo", [
      {
        guardian: "architect",
        stableId: "A-01",
        fingerprint: "fp-a1",
        kind: "BLOCKER",
        round: 1,
        issue: "https://github.com/acme/repo/issues/1",
      },
    ]);

    const ledger = loadGuardianRoundLedger(
      loadRunState(repo, "demo").reviewPhase,
    );
    expect(ledger.rounds).toEqual([invokedRound(1)]);
    expect(ledger.filedFindings).toEqual([
      expect.objectContaining({ stableId: "A-01" }),
    ]);
    // Reading is a projection, so reading twice says the same thing.
    expect(
      loadGuardianRoundLedger(loadRunState(repo, "demo").reviewPhase),
    ).toEqual(ledger);
  });

  it("B-02 round-trips the canonical review round shape", () => {
    const repo = makeRepo();
    saveSliceState(repo, "demo", "70", {
      phase: "PASS",
      branch: "afk/demo-slice-01",
      mergedToFeature: true,
    });
    appendCompletedGuardianRound(repo, "demo", {
      sanity: { treeSha: "t".repeat(40), ok: true },
      architect: { headSha: "h".repeat(40), verdict: "SHIP" },
      rounds: [invokedRound(1, "FIX-BEFORE-SHIP", "DIED_MID_RUN")],
    });

    const loaded = loadRunState(repo, "demo");
    // Slice state written earlier is preserved (atomic re-read pattern).
    expect(isSliceComplete(loaded, "70")).toBe(true);
    expect(loaded.reviewPhase).toEqual({
      sanity: { treeSha: "t".repeat(40), ok: true },
      architect: { headSha: "h".repeat(40), verdict: "SHIP" },
      rounds: [invokedRound(1, "FIX-BEFORE-SHIP", "DIED_MID_RUN")],
    });

    // Clearing removes the key entirely.
    appendCompletedGuardianRound(repo, "demo", undefined);
    expect(loadRunState(repo, "demo").reviewPhase).toBeUndefined();
  });

  it("B-01 appends one completed round without replacing unfavorable history", () => {
    const repo = makeRepo();
    appendCompletedGuardianRound(repo, "demo", {
      architect: { headSha: "head-1", verdict: "SHIP" },
      rounds: [invokedRound(1)],
    });
    appendCompletedGuardianRound(repo, "demo", {
      pm: { headSha: "head-2", verdict: "ACCEPT-WITH-NOTES" },
      rounds: [invokedRound(2, "FIX-BEFORE-SHIP", "NEVER_RAN")],
    });

    expect(loadRunState(repo, "demo").reviewPhase).toEqual({
      pm: { headSha: "head-2", verdict: "ACCEPT-WITH-NOTES" },
      rounds: [
        invokedRound(1),
        invokedRound(2, "FIX-BEFORE-SHIP", "NEVER_RAN"),
      ],
    });
  });

  it("P-04 saveSliceState preserves the cache, ledger, and sibling optional fields", () => {
    const repo = makeRepo();
    appendCompletedGuardianRound(repo, "demo", {
      pm: { headSha: "abc123", verdict: "ACCEPT-WITH-NOTES" },
      rounds: [invokedRound(1)],
    });
    const statePath = join(repo, ".afk", "state", "demo.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    state.qaConvergence = { retained: true };
    writeFileSync(statePath, JSON.stringify(state), "utf-8");
    saveSliceState(repo, "demo", "71", {
      phase: "PASS",
      mergedToFeature: true,
    });
    expect(loadRunState(repo, "demo").reviewPhase).toEqual({
      pm: { headSha: "abc123", verdict: "ACCEPT-WITH-NOTES" },
      rounds: [invokedRound(1)],
    });
    expect(loadRunState(repo, "demo").qaConvergence).toEqual({
      retained: true,
    });
  });

  it("appends filed findings, ignores a re-filed identity, and survives the next round write", () => {
    const repo = makeRepo();
    const blocker = {
      guardian: "architect" as const,
      stableId: "A-01",
      fingerprint: "fp-a1",
      kind: "BLOCKER" as const,
      round: 3,
      issue: "https://github.com/acme/repo/issues/1",
    };
    appendCompletedGuardianRound(repo, "demo", { rounds: [invokedRound(1)] });
    recordFiledGuardianFindings(repo, "demo", [blocker]);
    // Same identity, different issue: the record already exists, so the second
    // write is a no-op rather than a duplicate.
    recordFiledGuardianFindings(repo, "demo", [
      { ...blocker, round: 4, issue: "https://github.com/acme/repo/issues/9" },
      {
        guardian: "pm",
        stableId: "P-01",
        fingerprint: "fp-p1",
        kind: "NOTE",
        round: 4,
        issue: "https://github.com/acme/repo/issues/2",
      },
    ]);
    recordFiledGuardianFindings(repo, "demo", []);

    expect(loadRunState(repo, "demo").reviewPhase?.filedFindings).toEqual([
      blocker,
      expect.objectContaining({ stableId: "P-01" }),
    ]);

    // The next round's cache write replaces the cache fields wholesale; the
    // filed-issue memory must not go with them, or every note would be filed
    // again next round.
    appendCompletedGuardianRound(repo, "demo", {
      pm: { headSha: "head-2", verdict: "SHIP" },
      rounds: [invokedRound(2, "FIX-BEFORE-SHIP", "SHIP")],
    });

    const reloaded = loadRunState(repo, "demo").reviewPhase;
    expect(reloaded?.filedFindings).toHaveLength(2);
    expect(reloaded?.rounds).toHaveLength(2);
  });

  /**
   * #320: the reconciliation memory. Filing says "this issue exists" and the
   * first record wins; reconciliation says "this is the latest thing done to
   * it" and therefore overwrites — but only onto an identity this run actually
   * filed, because inventing a row would be a filing nobody performed.
   */
  it("stamps the reconciliation memory onto filed records and carries it forward", () => {
    const repo = makeRepo();
    const note: PersistedFiledFinding = {
      guardian: "architect",
      stableId: "A-01",
      fingerprint: "fp-a1",
      kind: "NOTE",
      round: 2,
      issue: "https://github.com/acme/repo/issues/290",
      prdSlug: "demo",
      runId: "run-20260914-101500",
    };
    appendCompletedGuardianRound(repo, "demo", { rounds: [invokedRound(1)] });
    recordFiledGuardianFindings(repo, "demo", [
      note,
      { ...note, guardian: "pm", stableId: "P-01", issue: "291" },
    ]);

    recordGuardianFindingReconciliations(repo, "demo", [
      {
        guardian: "architect",
        stableId: "A-01",
        reconciled: { round: 3, action: "UPDATED" },
      },
      // Never filed by this run: there is no row to stamp, and none is created.
      {
        guardian: "pm",
        stableId: "P-99",
        reconciled: { round: 3, action: "CLOSED" },
      },
    ]);
    // A later round overwrites the memory rather than appending a second one.
    recordGuardianFindingReconciliations(repo, "demo", [
      {
        guardian: "architect",
        stableId: "A-01",
        reconciled: { round: 4, action: "CLOSED" },
      },
    ]);
    recordGuardianFindingReconciliations(repo, "demo", []);

    expect(loadRunState(repo, "demo").reviewPhase?.filedFindings).toEqual([
      { ...note, reconciled: { round: 4, action: "CLOSED" } },
      { ...note, guardian: "pm", stableId: "P-01", issue: "291" },
    ]);

    // The next round's write replaces the caches wholesale; the memory must ride
    // along with the records, or the next pass comments on the issue again.
    appendCompletedGuardianRound(repo, "demo", {
      pm: { headSha: "head-2", verdict: "SHIP" },
      rounds: [invokedRound(2, "FIX-BEFORE-SHIP", "SHIP")],
    });
    const ledger = loadGuardianRoundLedger(
      loadRunState(repo, "demo").reviewPhase,
    );
    expect(ledger.filedFindings[0]?.reconciled).toEqual({
      round: 4,
      action: "CLOSED",
    });
  });

  it("writes no reconciliation memory when nothing was ever filed", () => {
    const repo = makeRepo();
    appendCompletedGuardianRound(repo, "demo", { rounds: [invokedRound(1)] });
    recordGuardianFindingReconciliations(repo, "demo", [
      {
        guardian: "architect",
        stableId: "A-01",
        reconciled: { round: 2, action: "CLOSED" },
      },
    ]);
    expect(
      loadRunState(repo, "demo").reviewPhase?.filedFindings,
    ).toBeUndefined();
  });
});

describe("sanitizeReviewPhase", () => {
  it("keeps well-formed favorable entries", () => {
    expect(
      sanitizeReviewPhase({
        sanity: { treeSha: "abc", ok: true },
        architect: { headSha: "def", verdict: "SHIP" },
        pm: { headSha: "def", verdict: "ACCEPT-WITH-NOTES" },
      }),
    ).toEqual({
      sanity: { treeSha: "abc", ok: true },
      architect: { headSha: "def", verdict: "SHIP" },
      pm: { headSha: "def", verdict: "ACCEPT-WITH-NOTES" },
    });
  });

  it("drops failed sanity results, unfavorable verdicts, and malformed entries", () => {
    expect(
      sanitizeReviewPhase({
        sanity: { treeSha: "abc", ok: false },
        architect: { headSha: "def", verdict: "FIX-BEFORE-SHIP" },
        pm: { headSha: 42, verdict: "SHIP" },
      }),
    ).toBeUndefined();
    expect(sanitizeReviewPhase("garbage")).toBeUndefined();
    expect(sanitizeReviewPhase(null)).toBeUndefined();
    expect(sanitizeReviewPhase({})).toBeUndefined();
  });

  it("keeps valid entries while dropping invalid siblings", () => {
    expect(
      sanitizeReviewPhase({
        sanity: { treeSha: "abc", ok: true },
        pm: { headSha: "", verdict: "SHIP" },
      }),
    ).toEqual({ sanity: { treeSha: "abc", ok: true } });
  });

  /**
   * The filed-issue record is validated entry by entry, not all-or-nothing like
   * the ledger: every record dropped is one finding the next round may file a
   * second issue for, so keeping the valid majority minimizes duplicates
   * (ADR 0057 decision 4, last sentence).
   */
  it("keeps each well-formed filed finding and drops only the malformed rows", () => {
    expect(
      sanitizeReviewPhase({
        filedFindings: [
          {
            guardian: "architect",
            stableId: " A-01 ",
            fingerprint: "fp-a1",
            kind: "BLOCKER",
            round: 3,
            issue: " https://github.com/acme/repo/issues/1 ",
          },
          // Every one of these is dropped, and none of them takes the row
          // above with it.
          { guardian: "designer", stableId: "X", fingerprint: "f", kind: "NOTE", round: 1, issue: "u" },
          { guardian: "pm", stableId: "  ", fingerprint: "f", kind: "NOTE", round: 1, issue: "u" },
          { guardian: "pm", stableId: "P-01", fingerprint: "", kind: "NOTE", round: 1, issue: "u" },
          { guardian: "pm", stableId: "P-01", fingerprint: "f", kind: "MAYBE", round: 1, issue: "u" },
          { guardian: "pm", stableId: "P-01", fingerprint: "f", kind: "NOTE", round: 0, issue: "u" },
          { guardian: "pm", stableId: "P-01", fingerprint: "f", kind: "NOTE", round: 1.5, issue: "u" },
          { guardian: "pm", stableId: "P-01", fingerprint: "f", kind: "NOTE", round: 1, issue: "" },
          "not an object",
          null,
          {
            guardian: "pm",
            stableId: "P-02",
            fingerprint: "fp-p2",
            kind: "NOTE",
            round: 2,
            issue: "https://github.com/acme/repo/issues/2",
          },
          // A duplicate identity collapses to the first record.
          {
            guardian: "pm",
            stableId: "P-02",
            fingerprint: "fp-p2",
            kind: "NOTE",
            round: 3,
            issue: "https://github.com/acme/repo/issues/3",
          },
        ],
      }),
    ).toEqual({
      filedFindings: [
        {
          guardian: "architect",
          stableId: "A-01",
          fingerprint: "fp-a1",
          kind: "BLOCKER",
          round: 3,
          issue: "https://github.com/acme/repo/issues/1",
        },
        {
          guardian: "pm",
          stableId: "P-02",
          fingerprint: "fp-p2",
          kind: "NOTE",
          round: 2,
          issue: "https://github.com/acme/repo/issues/2",
        },
      ],
    });
  });

  /**
   * #320's three fields. A row that names them keeps them; a row that does not
   * is a pre-#320 record and stays exactly as it is, because it is still a true
   * statement about an issue that exists — dropping it would file that issue a
   * second time. A row whose claim about them is malformed goes, because those
   * are the fields a later close acts on.
   */
  it("keeps the filed-finding run context and reconciliation memory", () => {
    expect(
      sanitizeReviewPhase({
        filedFindings: [
          {
            guardian: "architect",
            stableId: "A-01",
            fingerprint: "fp-a1",
            kind: "BLOCKER",
            round: 3,
            issue: "https://github.com/acme/repo/issues/290",
            prdSlug: " demo ",
            runId: " run-20260914-101500 ",
            reconciled: { round: 4, action: "CLOSED" },
          },
          // Pre-#320: no run context, no memory, and no invented keys.
          {
            guardian: "pm",
            stableId: "P-01",
            fingerprint: "fp-p1",
            kind: "NOTE",
            round: 1,
            issue: "https://github.com/acme/repo/issues/291",
          },
        ],
      }),
    ).toEqual({
      filedFindings: [
        {
          guardian: "architect",
          stableId: "A-01",
          fingerprint: "fp-a1",
          kind: "BLOCKER",
          round: 3,
          issue: "https://github.com/acme/repo/issues/290",
          prdSlug: "demo",
          runId: "run-20260914-101500",
          reconciled: { round: 4, action: "CLOSED" },
        },
        {
          guardian: "pm",
          stableId: "P-01",
          fingerprint: "fp-p1",
          kind: "NOTE",
          round: 1,
          issue: "https://github.com/acme/repo/issues/291",
        },
      ],
    });
  });

  it("drops a filed-finding row whose run context or memory is malformed", () => {
    const row = {
      guardian: "pm" as const,
      stableId: "P-01",
      fingerprint: "fp-p1",
      kind: "NOTE" as const,
      round: 1,
      issue: "https://github.com/acme/repo/issues/291",
    };
    for (const malformed of [
      { prdSlug: 42 },
      { prdSlug: "  " },
      { runId: null },
      { reconciled: "closed" },
      { reconciled: { round: 0, action: "CLOSED" } },
      { reconciled: { round: 2, action: "REOPENED" } },
      { reconciled: { action: "CLOSED" } },
    ]) {
      expect(
        sanitizeReviewPhase({ filedFindings: [{ ...row, ...malformed }] }),
      ).toBeUndefined();
    }
  });

  it("reads an unusable filed-finding record as nothing filed rather than refusing the phase", () => {
    expect(
      sanitizeReviewPhase({
        sanity: { treeSha: "abc", ok: true },
        filedFindings: "not an array",
      }),
    ).toEqual({ sanity: { treeSha: "abc", ok: true } });
    expect(sanitizeReviewPhase({ filedFindings: [] })).toBeUndefined();
  });

  it("B-04 drops an impossible architect blocking ledger but keeps favorable cache data", () => {
    expect(
      sanitizeReviewPhase({
        architect: { headSha: "cached-head", verdict: "SHIP" },
        rounds: [
          {
            round: 1,
            reviewedHeadSha: "reviewed-head",
            headSha: "review-commit",
            architect: {
              source: "INVOKED",
              outcome: "FIX-BEFORE-SHIP",
              findings: [
                {
                  stableId: "A-01",
                  currentId: "A-01",
                  title: "Pre-existing behavior",
                  class: "INTEGRITY",
                  clearCondition: "Change main's existing behavior.",
                  disposition: "OPEN",
                  reachableTrigger: "A normal run reaches the behavior.",
                  introducedByReviewedDiff: false,
                },
              ],
              findingsOriginRound: 1,
            },
            pm: {
              source: "INVOKED",
              outcome: "SHIP",
              findings: [],
              findingsOriginRound: 1,
            },
          },
        ],
      }),
    ).toEqual({
      architect: { headSha: "cached-head", verdict: "SHIP" },
    });
  });

  it("P-02 loads legacy PM v1 findings with null authority evidence", () => {
    const sanitized = sanitizeReviewPhase({
      rounds: [
        {
          round: 1,
          reviewedHeadSha: "reviewed-head",
          headSha: "review-commit",
          architect: {
            source: "INVOKED",
            outcome: "SHIP",
            findings: [],
            findingsOriginRound: 1,
          },
          pm: {
            source: "INVOKED",
            outcome: "ACCEPT-WITH-NOTES",
            findings: [
              {
                stableId: "P-01",
                currentId: "P-01",
                title: "Product note",
                class: "PRODUCT",
                clearCondition: "Clarify the product behavior.",
                disposition: "OPEN",
              },
            ],
            findingsOriginRound: 1,
          },
        },
      ],
    });
    expect(sanitized?.rounds?.[0]?.pm.findings).toEqual([
      {
        stableId: "P-01",
        currentId: "P-01",
        title: "Product note",
        class: "PRODUCT",
        clearCondition: "Clarify the product behavior.",
        disposition: "OPEN",
        reachableTrigger: null,
        introducedByReviewedDiff: null,
      },
    ]);
  });

  it("is applied when loading a v1 state file", () => {
    const state = adaptLoadedState(
      {
        version: 1,
        featureBranch: "feat/demo",
        slices: {},
        reviewPhase: {
          architect: { headSha: "abc", verdict: "SHIP" },
          pm: { headSha: "abc", verdict: "FIX-BEFORE-SHIP" },
        },
      },
      "demo",
    );
    expect(state.reviewPhase).toEqual({
      architect: { headSha: "abc", verdict: "SHIP" },
    });
  });

  it("B-05 validates cache and ledger independently and drops an invalid ledger whole", () => {
    const validFinding = {
      stableId: "A-01",
      currentId: "A-01",
      title: "Finding",
      class: "INTEGRITY",
      clearCondition: "Clear it",
      disposition: "OPEN",
      reachableTrigger: null,
      introducedByReviewedDiff: null,
    };
    const round1 = {
      round: 1,
      reviewedHeadSha: "base",
      headSha: "review-commit",
      architect: {
        source: "INVOKED",
        outcome: "ACCEPT-WITH-NOTES",
        findings: [validFinding],
        findingsOriginRound: 1,
      },
      pm: {
        source: "INVOKED",
        outcome: "SHIP",
        findings: [],
        findingsOriginRound: 1,
      },
    };
    const valid = sanitizeReviewPhase({
      architect: { headSha: "cache", verdict: "SHIP" },
      rounds: [
        round1,
        {
          round: 2,
          reviewedHeadSha: "review-commit",
          headSha: "review-commit",
          architect: {
            source: "CACHE",
            outcome: "ACCEPT-WITH-NOTES",
            findings: [validFinding],
            findingsOriginRound: 1,
          },
          pm: {
            source: "CACHE",
            outcome: "SHIP",
            findings: [],
            findingsOriginRound: 1,
          },
        },
        {
          round: 3,
          reviewedHeadSha: "unbacked-cache-head",
          headSha: "unbacked-cache-head",
          architect: {
            source: "CACHE",
            outcome: "SHIP",
            findings: [],
            findingsOriginRound: null,
          },
          pm: {
            source: "CACHE",
            outcome: "SHIP",
            findings: [],
            findingsOriginRound: null,
          },
        },
      ],
    });
    expect(valid?.rounds).toHaveLength(3);
    expect(valid?.rounds?.[2]?.architect).toMatchObject({
      findings: [],
      findingsOriginRound: null,
    });

    const malformed = structuredClone(valid!);
    malformed.rounds![1]!.architect.findings[0]!.title = "not an exact copy";
    expect(
      sanitizeReviewPhase({
        sanity: { treeSha: "tree", ok: true },
        architect: { headSha: "cache", verdict: "SHIP" },
        rounds: malformed.rounds,
      }),
    ).toEqual({
      sanity: { treeSha: "tree", ok: true },
      architect: { headSha: "cache", verdict: "SHIP" },
    });

    const invalidOrigin = structuredClone(valid!);
    invalidOrigin.rounds![1]!.architect.findingsOriginRound = 2;
    expect(
      sanitizeReviewPhase({
        architect: { headSha: "cache", verdict: "SHIP" },
        rounds: invalidOrigin.rounds,
      }),
    ).toEqual({
      architect: { headSha: "cache", verdict: "SHIP" },
    });
  });

  it("B-05 QA-01 drops a ledger whose stable IDs repeat within a guardian record", () => {
    const roundsWith = (findings: unknown[]) => [
      {
        round: 1,
        reviewedHeadSha: "base",
        headSha: "review-commit",
        architect: {
          source: "INVOKED",
          outcome: "ACCEPT-WITH-NOTES",
          findings,
          findingsOriginRound: 1,
        },
        pm: {
          source: "INVOKED",
          outcome: "SHIP",
          findings: [],
          findingsOriginRound: 1,
        },
      },
    ];
    const currentAliasClaimant = {
      stableId: "A-01",
      currentId: "A-05",
      title: "Current-alias claimant",
      class: "PRODUCT",
      clearCondition: "Clear the current alias.",
      disposition: "REPEATED",
      reachableTrigger: null,
      introducedByReviewedDiff: null,
    };
    const stableAliasClaimant = {
      currentId: "A-01",
      title: "Stable-alias claimant",
      class: "INTEGRITY",
      clearCondition: "Clear the stable alias.",
      disposition: "OPEN",
      reachableTrigger: null,
      introducedByReviewedDiff: null,
    };

    // Identity resolution is one-to-one within a round (ADR 0057 decision 1,
    // amendment 2026-09-06): two findings sharing one stable identity are
    // unrepresentable, so the ledger degrades to a full round-1 review.
    expect(
      sanitizeReviewPhase({
        rounds: roundsWith([
          currentAliasClaimant,
          { ...stableAliasClaimant, stableId: "A-01" },
        ]),
      }),
    ).toBeUndefined();

    // The decided shape — the losing claimant carries a new stable identity
    // and keeps its guardian-provided ID as currentId — stays durable.
    const distinct = roundsWith([
      currentAliasClaimant,
      { ...stableAliasClaimant, stableId: "A-09" },
    ]);
    expect(sanitizeReviewPhase({ rounds: distinct })?.rounds).toEqual(distinct);
  });

  it("B-06 keeps the cache favorable-only while the ledger accepts all six terminal outcomes", () => {
    const outcomes = [
      "SHIP",
      "ACCEPT-WITH-NOTES",
      "FIX-BEFORE-SHIP",
      "UNPARSEABLE",
      "NEVER_RAN",
      "DIED_MID_RUN",
    ] as const;
    const rounds = outcomes.map((outcome, index) => ({
      round: index + 1,
      reviewedHeadSha: `reviewed-${index + 1}`,
      headSha: `head-${index + 1}`,
      architect: {
        source: "INVOKED" as const,
        outcome,
        findings:
          outcome === "ACCEPT-WITH-NOTES" ||
          outcome === "FIX-BEFORE-SHIP"
            ? [
                {
                  stableId: `A-${index + 1}`,
                  currentId: `A-${index + 1}`,
                  title: "Finding",
                  class: "INTEGRITY",
                  clearCondition: "Clear it",
                  disposition: "OPEN" as const,
                  reachableTrigger: "A retry consumes invalid state.",
                  introducedByReviewedDiff: true,
                },
              ]
            : [],
        findingsOriginRound: index + 1,
      },
      pm: {
        source: "INVOKED" as const,
        outcome: "SHIP" as const,
        findings: [],
        findingsOriginRound: index + 1,
      },
    }));
    const sanitized = sanitizeReviewPhase({
      architect: { headSha: "bad", verdict: "FIX-BEFORE-SHIP" },
      pm: { headSha: "good", verdict: "ACCEPT-WITH-NOTES" },
      rounds,
    });
    expect(sanitized?.architect).toBeUndefined();
    expect(sanitized?.pm).toEqual({
      headSha: "good",
      verdict: "ACCEPT-WITH-NOTES",
    });
    expect(sanitized?.rounds?.map((round) => round.architect.outcome)).toEqual(
      outcomes,
    );
  });
});
