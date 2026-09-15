import { describe, expect, it, vi } from "vitest";
import {
  applyFindingIssueReconciliation,
  buildFindingIssueDrafts,
  fileFindingIssues,
  reconcileFindingIssues,
  unresolvedGuardianIssueDecisions,
  type FindingIssueDecision,
  type FindingIssueDraft,
  type FindingIssueEvidence,
} from "./finding-filing.js";
import {
  guardianFindingFingerprint,
  type LedgerFinding,
} from "./guardian-finding-ledger.js";
import type {
  PersistedFiledFinding,
  PersistedGuardianFinding,
} from "./guardian-round-records.js";

function finding(
  overrides: Partial<PersistedGuardianFinding> & { stableId: string },
): PersistedGuardianFinding {
  return {
    currentId: overrides.stableId,
    title: `${overrides.stableId} title`,
    class: "INTEGRITY",
    clearCondition: `Clear ${overrides.stableId}.`,
    disposition: "OPEN",
    reachableTrigger: "A normal retry reads the invalid durable state.",
    introducedByReviewedDiff: true,
    ...overrides,
  };
}

function ledgerFinding(
  overrides: Partial<LedgerFinding> & {
    finding: PersistedGuardianFinding;
  },
): LedgerFinding {
  return {
    guardian: "architect",
    round: 1,
    blocking: false,
    fingerprint: guardianFindingFingerprint(overrides.finding),
    ...overrides,
  };
}

function draft(overrides: Partial<FindingIssueDraft> = {}): FindingIssueDraft {
  return {
    guardian: "architect",
    stableId: "A-01",
    fingerprint: guardianFindingFingerprint({
      class: "INTEGRITY",
      clearCondition: "Clear A-01.",
    }),
    kind: "NOTE",
    round: 1,
    title: "[afk][demo] A-01 title",
    body: "body",
    prdSlug: "demo",
    runId: "run-20260914-101500",
    ...overrides,
  };
}

/** The fingerprint `finding(stableId)` above produces, for a filing record. */
function fingerprintFor(stableId: string, findingClass = "INTEGRITY"): string {
  return guardianFindingFingerprint({
    class: findingClass,
    clearCondition: `Clear ${stableId}.`,
  });
}

function filed(
  overrides: Partial<PersistedFiledFinding> & { stableId: string },
): PersistedFiledFinding {
  return {
    guardian: "architect",
    fingerprint: fingerprintFor(overrides.stableId),
    kind: "NOTE",
    round: 2,
    issue: "https://github.com/acme/repo/issues/290",
    prdSlug: "demo",
    runId: "run-20260914-101500",
    ...overrides,
  };
}

const evidence: FindingIssueEvidence = {
  prdSlug: "demo",
  runId: "run-20260914-101500",
  featureBranch: "feat/demo",
  specsDir: ".kiro\\specs\\demo",
  reviewedHeadSha: "abc1234",
};

describe("buildFindingIssueDrafts", () => {
  it("carries the ledger identity, the clear condition, and where to read the review", () => {
    const [blocker] = buildFindingIssueDrafts({
      prdSlug: "demo",
      runId: "run-20260914-101500",
      specsDir: ".kiro\\specs\\demo",
      featureBranch: "feat/demo",
      kind: "BLOCKER",
      findings: [
        ledgerFinding({
          guardian: "architect",
          round: 3,
          blocking: true,
          finding: finding({
            stableId: "A-01",
            currentId: "A-04",
            title: "Round persistence skips the early return",
            clearCondition: "The round persists on every exit path.",
            disposition: "REPEATED",
          }),
        }),
      ],
    });

    expect(blocker!.title).toBe(
      "[afk][demo] Round persistence skips the early return",
    );
    expect(blocker!.kind).toBe("BLOCKER");
    expect(blocker!.stableId).toBe("A-01");
    expect(blocker!.round).toBe(3);
    expect(blocker!.body).toContain("unresolved at the guardian round cap");
    expect(blocker!.body).toContain("`A-01` (reported as `A-04`)");
    expect(blocker!.body).toContain("The round persists on every exit path.");
    expect(blocker!.body).toContain("review round 3, disposition `REPEATED`");
    // Windows separators never reach an issue body.
    expect(blocker!.body).toContain(".kiro/specs/demo/review-architect.md");
    expect(blocker!.body).not.toContain("\\");
  });

  it("labels a note as shipped unfixed and points at the PM review for a PM finding", () => {
    const [note] = buildFindingIssueDrafts({
      prdSlug: "demo",
      runId: "run-20260914-101500",
      specsDir: ".kiro/specs/demo",
      featureBranch: "feat/demo",
      kind: "NOTE",
      findings: [
        ledgerFinding({
          guardian: "pm",
          finding: finding({ stableId: "P-01", class: "PRODUCT" }),
        }),
      ],
    });

    expect(note!.kind).toBe("NOTE");
    expect(note!.body).toContain("note shipped unfixed");
    expect(note!.body).toContain("PM guardian finding");
    expect(note!.body).toContain(".kiro/specs/demo/review-pm.md");
  });
});

describe("fileFindingIssues", () => {
  it("opens one issue per draft and returns the records to persist", () => {
    const create = vi.fn(
      (d: FindingIssueDraft) => `https://github.com/acme/repo/issues/${d.stableId}\n`,
    );

    const outcome = fileFindingIssues({
      drafts: [draft(), draft({ stableId: "A-02", fingerprint: "fp-2" })],
      alreadyFiled: [],
      create,
      retries: 1,
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(outcome.failed).toEqual([]);
    expect(outcome.skipped).toEqual([]);
    // The record carries the PRD and run that filed it: a later round's
    // reconciliation has to know whose issue this is (#320).
    expect(outcome.filed).toEqual([
      {
        guardian: "architect",
        stableId: "A-01",
        fingerprint: expect.any(String),
        kind: "NOTE",
        round: 1,
        issue: "https://github.com/acme/repo/issues/A-01",
        prdSlug: "demo",
        runId: "run-20260914-101500",
      },
      {
        guardian: "architect",
        stableId: "A-02",
        fingerprint: "fp-2",
        kind: "NOTE",
        round: 1,
        issue: "https://github.com/acme/repo/issues/A-02",
        prdSlug: "demo",
        runId: "run-20260914-101500",
      },
    ]);
  });

  it("files a note exactly once across rounds, not once per round", () => {
    // The regression to guard: the same note rides two consecutive rounds. It
    // was filed in round 1, so round 2 must open nothing.
    const first = fileFindingIssues({
      drafts: [draft({ round: 1 })],
      alreadyFiled: [],
      create: () => "https://github.com/acme/repo/issues/7",
      retries: 0,
    });
    expect(first.filed).toHaveLength(1);

    const create = vi.fn(() => "https://github.com/acme/repo/issues/8");
    const second = fileFindingIssues({
      // Round 2 reports the same identity again, with a fresh disposition.
      drafts: [draft({ round: 2 })],
      alreadyFiled: first.filed,
      create,
      retries: 0,
    });

    expect(create).not.toHaveBeenCalled();
    expect(second.filed).toEqual([]);
    expect(second.skipped).toEqual([
      expect.objectContaining({
        stableId: "A-01",
        issue: "https://github.com/acme/repo/issues/7",
      }),
    ]);
  });

  it("files a fresh obligation that reuses a filed stable ID", () => {
    // #247, recorded: round 3 filed PM `P-01` as issue 216 — "a production call
    // site grades a writing role through the role comparison source". Round 4's
    // guardian numbered from P-01 again on a diff where that note was fixed, so
    // its own first note ("advisory test:budgets gate is implemented but no
    // shipped config declares it") arrived as P-01 too. The ID match reported it
    // already filed and it shipped unfixed and unfiled, against #174.
    const alreadyFiled: PersistedFiledFinding[] = [
      {
        guardian: "pm",
        stableId: "P-01",
        fingerprint: guardianFindingFingerprint({
          class: "PRODUCT",
          clearCondition:
            "A production call site grades a writing role through the `role` comparison source.",
        }),
        kind: "NOTE",
        round: 3,
        issue: "https://github.com/EricOliveira90/afk-pipeline/issues/216",
      },
    ];
    const create = vi.fn(
      () => "https://github.com/EricOliveira90/afk-pipeline/issues/242",
    );

    const outcome = fileFindingIssues({
      drafts: [
        draft({
          guardian: "pm",
          stableId: "P-01",
          round: 4,
          fingerprint: guardianFindingFingerprint({
            class: "PRODUCT",
            clearCondition:
              "This repo's afk.config.json declares gatePolicy.cost.environmentSensitive.",
          }),
        }),
      ],
      alreadyFiled,
      create,
      retries: 0,
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.filed).toEqual([
      expect.objectContaining({
        stableId: "P-01",
        round: 4,
        issue: "https://github.com/EricOliveira90/afk-pipeline/issues/242",
      }),
    ]);
  });

  it("skips a renamed identity whose fingerprint was already filed", () => {
    const alreadyFiled: PersistedFiledFinding[] = [
      {
        guardian: "architect",
        stableId: "A-01",
        fingerprint: "shared-fingerprint",
        kind: "NOTE",
        round: 1,
        issue: "https://github.com/acme/repo/issues/7",
      },
    ];
    const create = vi.fn(() => "https://github.com/acme/repo/issues/8");

    const outcome = fileFindingIssues({
      // A-01 is gone; the lineage minted A-01-2 for the same obligation.
      drafts: [draft({ stableId: "A-01-2", fingerprint: "shared-fingerprint" })],
      alreadyFiled,
      create,
      retries: 0,
    });

    expect(create).not.toHaveBeenCalled();
    expect(outcome.filed).toEqual([]);
    expect(outcome.skipped).toHaveLength(1);
  });

  it("files a second live identity that merely shares a fingerprint", () => {
    // The tiebreak kept A-01 and A-01-2 apart deliberately, and both are still
    // reported, so collapsing them by fingerprint would drop one.
    const alreadyFiled: PersistedFiledFinding[] = [
      {
        guardian: "architect",
        stableId: "A-01",
        fingerprint: "shared-fingerprint",
        kind: "NOTE",
        round: 1,
        issue: "https://github.com/acme/repo/issues/7",
      },
    ];
    const create = vi.fn(() => "https://github.com/acme/repo/issues/8");

    const outcome = fileFindingIssues({
      drafts: [
        draft({ stableId: "A-01", fingerprint: "shared-fingerprint" }),
        draft({ stableId: "A-01-2", fingerprint: "shared-fingerprint" }),
      ],
      alreadyFiled,
      create,
      retries: 0,
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(outcome.filed.map((r) => r.stableId)).toEqual(["A-01-2"]);
    expect(outcome.skipped.map((r) => r.stableId)).toEqual(["A-01"]);
  });

  it("never opens two issues for one identity inside a single pass", () => {
    const create = vi.fn(() => "https://github.com/acme/repo/issues/9");

    const outcome = fileFindingIssues({
      drafts: [draft(), draft()],
      alreadyFiled: [],
      create,
      retries: 0,
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(outcome.filed).toHaveLength(1);
    expect(outcome.skipped).toHaveLength(1);
  });

  it("keeps the guardians' identities apart", () => {
    const create = vi.fn(() => "https://github.com/acme/repo/issues/10");

    const outcome = fileFindingIssues({
      drafts: [
        draft({ guardian: "architect", stableId: "01", fingerprint: "fp" }),
        draft({ guardian: "pm", stableId: "01", fingerprint: "fp" }),
      ],
      alreadyFiled: [],
      create,
      retries: 0,
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(outcome.filed.map((r) => r.guardian)).toEqual(["architect", "pm"]);
  });

  it("retries a failing create and reports the retry", () => {
    let attempts = 0;
    const onRetry = vi.fn();
    const outcome = fileFindingIssues({
      drafts: [draft()],
      alreadyFiled: [],
      create: () => {
        attempts++;
        if (attempts < 3) throw new Error(`gh exited 1 (attempt ${attempts})`);
        return "https://github.com/acme/repo/issues/11";
      },
      retries: 2,
      onRetry,
    });

    expect(attempts).toBe(3);
    expect(outcome.filed).toHaveLength(1);
    expect(outcome.failed).toEqual([]);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenLastCalledWith(
      expect.objectContaining({ stableId: "A-01" }),
      2,
      "gh exited 1 (attempt 2)",
    );
  });

  it("reports an exhausted draft as data rather than throwing", () => {
    const outcome = fileFindingIssues({
      drafts: [draft(), draft({ stableId: "A-02", fingerprint: "fp-2" })],
      alreadyFiled: [],
      create: (d) => {
        if (d.stableId === "A-01") throw new Error("gh: not authenticated");
        return "https://github.com/acme/repo/issues/12";
      },
      retries: 1,
    });

    expect(outcome.filed.map((r) => r.stableId)).toEqual(["A-02"]);
    expect(outcome.failed).toEqual([
      {
        draft: expect.objectContaining({ stableId: "A-01" }),
        error: "gh: not authenticated",
      },
    ]);
  });

  it("treats an empty issue reference as a failure", () => {
    const outcome = fileFindingIssues({
      drafts: [draft()],
      alreadyFiled: [],
      create: () => "  \n",
      retries: 0,
    });

    expect(outcome.filed).toEqual([]);
    expect(outcome.failed[0]!.error).toContain("no issue reference");
  });
});

/**
 * #320: the second half of the issue lifecycle. Filing opens a ticket for a
 * finding; these decide what a *later* round made of it. The rule under every
 * case is one-directional — filing may err toward a duplicate ticket, and
 * reconciliation may only ever err toward leaving a ticket alone.
 */
describe("reconcileFindingIssues", () => {
  it("closes an issue whose finding a later round recorded RESOLVED", () => {
    const reconciliation = reconcileFindingIssues({
      ledger: [
        ledgerFinding({
          round: 4,
          finding: finding({ stableId: "A-01", disposition: "RESOLVED" }),
        }),
      ],
      alreadyFiled: [filed({ stableId: "A-01", round: 2 })],
      evidence,
    });

    expect(reconciliation.update).toEqual([]);
    expect(reconciliation.refuse).toEqual([]);
    expect(reconciliation.close).toHaveLength(1);
    const [decision] = reconciliation.close;
    expect(decision!.record.issue).toBe(
      "https://github.com/acme/repo/issues/290",
    );
    // The comment carries the evidence a human needs to audit the close: which
    // round said so, on which commit, in which artifact.
    expect(decision!.comment).toContain("round 4 recorded");
    expect(decision!.comment).toContain("disposition `RESOLVED`");
    expect(decision!.comment).toContain("`abc1234`");
    expect(decision!.comment).toContain("Filed from review round 2");
    expect(decision!.comment).toContain(
      ".kiro/specs/demo/review-architect.md",
    );
    expect(decision!.comment).toContain("Clear A-01.");
    // Windows separators never reach a comment body, exactly as they never
    // reach an issue body.
    expect(decision!.comment).not.toContain("\\s");
  });

  it("comments the latest evidence onto a REPEATED finding and leaves it open", () => {
    const reconciliation = reconcileFindingIssues({
      ledger: [
        ledgerFinding({
          round: 3,
          finding: finding({
            stableId: "A-01",
            currentId: "A-04",
            disposition: "REPEATED",
          }),
        }),
      ],
      alreadyFiled: [filed({ stableId: "A-01", round: 2 })],
      evidence,
    });

    expect(reconciliation.close).toEqual([]);
    expect(reconciliation.update).toHaveLength(1);
    const [decision] = reconciliation.update;
    expect(decision!.comment).toContain("Still open after AFK guardian round 3");
    expect(decision!.comment).toContain("`REPEATED`");
    expect(decision!.comment).toContain("`A-01` (reported as `A-04`)");
    expect(unresolvedGuardianIssueDecisions(reconciliation)).toEqual([decision]);
  });

  it("reopens an issue an earlier pass closed when the finding comes back", () => {
    // The guardian resolved it in round 3 and the reconciliation closed the
    // issue; round 5 reports it again. Leaving the issue closed would understate
    // the remaining defects, which is the whole complaint in #320.
    const reconciliation = reconcileFindingIssues({
      ledger: [
        ledgerFinding({
          round: 5,
          finding: finding({ stableId: "A-01", disposition: "REOPENED" }),
        }),
      ],
      alreadyFiled: [
        filed({
          stableId: "A-01",
          round: 2,
          reconciled: { round: 3, action: "CLOSED" },
        }),
      ],
      evidence,
    });

    expect(reconciliation.close).toEqual([]);
    expect(reconciliation.update).toEqual([]);
    expect(reconciliation.reopen).toHaveLength(1);
    expect(reconciliation.reopen[0]!.comment).toContain("Live again");
    expect(reconciliation.reopen[0]!.comment).toContain("`REOPENED`");
  });

  it("refuses a stable-ID match whose fingerprint disagrees rather than closing it", () => {
    // #247's failure, read from the other side. The ledger was rebuilt and its
    // fresh round numbered a *different* obligation `A-01`, and that obligation
    // is RESOLVED. An ID alone is not identity, so the issue filed for the old
    // A-01 must survive untouched — closing it is closing somebody else's
    // ticket. Live proof this happens: #311 and #314 carry byte-identical
    // titles, and #314 was closed on 2026-09-14 while #311 is still open.
    const reconciliation = reconcileFindingIssues({
      ledger: [
        ledgerFinding({
          round: 1,
          finding: finding({
            stableId: "A-01",
            clearCondition: "Something else entirely is true.",
            disposition: "RESOLVED",
          }),
        }),
      ],
      alreadyFiled: [filed({ stableId: "A-01", round: 1 })],
      evidence,
    });

    expect(reconciliation.close).toEqual([]);
    expect(reconciliation.update).toEqual([]);
    expect(reconciliation.refuse).toHaveLength(1);
    expect(reconciliation.refuse[0]!.refusal).toBe("stable-id-collision");
    // The refusal is visible, not silent: it carries the sentence an operator
    // reads in the run summary.
    expect(reconciliation.refuse[0]!.reason).toContain("an ID alone is not identity");
    expect(unresolvedGuardianIssueDecisions(reconciliation)).toHaveLength(1);
  });

  it("still reconciles a renamed identity through its fingerprint", () => {
    // The lineage minted `A-01-2` for the same obligation, which is the case
    // `alreadyFiledRecord` accepts when it skips a re-file. The two sides must
    // agree about what "the same finding, renamed" means, or filing skips an
    // issue reconciliation then refuses to touch.
    const reconciliation = reconcileFindingIssues({
      ledger: [
        ledgerFinding({
          round: 4,
          finding: finding({ stableId: "A-01-2", disposition: "RESOLVED" }),
        }),
      ],
      alreadyFiled: [
        filed({
          stableId: "A-01",
          round: 2,
          fingerprint: fingerprintFor("A-01-2"),
        }),
      ],
      evidence,
    });

    expect(reconciliation.close).toHaveLength(1);
    expect(reconciliation.close[0]!.matched!.finding.stableId).toBe("A-01-2");
  });

  it("refuses when two live findings share the issue's fingerprint", () => {
    const reconciliation = reconcileFindingIssues({
      ledger: [
        ledgerFinding({
          round: 4,
          finding: finding({ stableId: "A-07", disposition: "RESOLVED" }),
        }),
        ledgerFinding({
          round: 4,
          finding: finding({
            stableId: "A-08",
            clearCondition: "Clear A-07.",
            disposition: "RESOLVED",
          }),
        }),
      ],
      alreadyFiled: [
        filed({ stableId: "A-99", round: 2, fingerprint: fingerprintFor("A-07") }),
      ],
      evidence,
    });

    expect(reconciliation.close).toEqual([]);
    expect(reconciliation.refuse[0]!.refusal).toBe("ambiguous-identity");
  });

  it("refuses a record that names no addressable issue", () => {
    const reconciliation = reconcileFindingIssues({
      ledger: [
        ledgerFinding({
          round: 4,
          finding: finding({ stableId: "A-01", disposition: "RESOLVED" }),
        }),
      ],
      alreadyFiled: [
        filed({ stableId: "A-01", round: 2, issue: "(issue url not captured)" }),
      ],
      evidence,
    });

    expect(reconciliation.close).toEqual([]);
    expect(reconciliation.refuse).toHaveLength(1);
    expect(reconciliation.refuse[0]!.refusal).toBe("unusable-issue-reference");
  });

  it("accepts a bare issue number as addressable", () => {
    const reconciliation = reconcileFindingIssues({
      ledger: [
        ledgerFinding({
          round: 4,
          finding: finding({ stableId: "A-01", disposition: "RESOLVED" }),
        }),
      ],
      alreadyFiled: [filed({ stableId: "A-01", round: 2, issue: "290" })],
      evidence,
    });

    expect(reconciliation.close).toHaveLength(1);
  });

  it("keeps the two guardians' identically numbered findings apart", () => {
    // A mixed round: both guardians numbered a finding `01`, and only the
    // architect's is resolved. Collapsing them would close the PM's live ticket.
    const reconciliation = reconcileFindingIssues({
      ledger: [
        ledgerFinding({
          guardian: "architect",
          round: 4,
          finding: finding({ stableId: "01", disposition: "RESOLVED" }),
        }),
        ledgerFinding({
          guardian: "pm",
          round: 4,
          finding: finding({
            stableId: "01",
            class: "PRODUCT",
            disposition: "OPEN",
          }),
        }),
      ],
      alreadyFiled: [
        filed({
          guardian: "architect",
          stableId: "01",
          round: 2,
          issue: "https://github.com/acme/repo/issues/290",
        }),
        filed({
          guardian: "pm",
          stableId: "01",
          round: 2,
          fingerprint: fingerprintFor("01", "PRODUCT"),
          issue: "https://github.com/acme/repo/issues/291",
        }),
      ],
      evidence,
    });

    expect(reconciliation.close.map((d) => d.record.issue)).toEqual([
      "https://github.com/acme/repo/issues/290",
    ]);
    expect(reconciliation.update.map((d) => d.record.issue)).toEqual([
      "https://github.com/acme/repo/issues/291",
    ]);
    expect(reconciliation.refuse).toEqual([]);
  });

  it("refuses an issue filed under another PRD and reconciles a pre-#320 record", () => {
    const reconciliation = reconcileFindingIssues({
      ledger: [
        ledgerFinding({
          round: 4,
          finding: finding({ stableId: "A-01", disposition: "RESOLVED" }),
        }),
        ledgerFinding({
          round: 4,
          finding: finding({ stableId: "A-02", disposition: "RESOLVED" }),
        }),
      ],
      alreadyFiled: [
        filed({ stableId: "A-01", round: 2, prdSlug: "another-prd" }),
        // A record written before #320 names no PRD. It came out of this run's
        // own state file, so it is this run's — the alternative strands exactly
        // the issues #320 was filed about.
        {
          guardian: "architect",
          stableId: "A-02",
          fingerprint: fingerprintFor("A-02"),
          kind: "NOTE",
          round: 2,
          issue: "https://github.com/acme/repo/issues/292",
        },
      ],
      evidence,
    });

    expect(reconciliation.refuse).toHaveLength(1);
    expect(reconciliation.refuse[0]!.refusal).toBe("prd-mismatch");
    expect(reconciliation.close.map((d) => d.record.stableId)).toEqual(["A-02"]);
  });

  it("refuses to read a RESOLVED older than the round that filed the issue", () => {
    // The ledger was discarded and rebuilt to a single round, so its latest word
    // predates the filing. The two are not describing one history, and a
    // RESOLVED from before the issue existed is not later evidence.
    const reconciliation = reconcileFindingIssues({
      ledger: [
        ledgerFinding({
          round: 1,
          finding: finding({ stableId: "A-01", disposition: "RESOLVED" }),
        }),
      ],
      alreadyFiled: [filed({ stableId: "A-01", round: 4 })],
      evidence,
    });

    expect(reconciliation.close).toEqual([]);
    expect(reconciliation.refuse[0]!.refusal).toBe("stale-evidence");
  });

  it("says nothing about an identity no ledger finding carries", () => {
    const reconciliation = reconcileFindingIssues({
      ledger: [],
      alreadyFiled: [filed({ stableId: "A-01", round: 2 })],
      evidence,
    });

    expect(reconciliation.refuse[0]!.refusal).toBe("no-ledger-entry");
  });

  it("applies one round's evidence once, however often the pass replays", () => {
    const ledger = [
      ledgerFinding({
        round: 3,
        finding: finding({ stableId: "A-01", disposition: "OPEN" }),
      }),
    ];
    const first = reconcileFindingIssues({
      ledger,
      alreadyFiled: [filed({ stableId: "A-01", round: 2 })],
      evidence,
    });
    expect(first.update).toHaveLength(1);

    // The memory the first pass persisted, replayed against the same ledger.
    const replayed = reconcileFindingIssues({
      ledger,
      alreadyFiled: [
        filed({
          stableId: "A-01",
          round: 2,
          reconciled: { round: 3, action: "UPDATED" },
        }),
      ],
      evidence,
    });
    expect(replayed.update).toEqual([]);
    expect(replayed.unchanged).toHaveLength(1);
    // Unchanged is still unresolved: the issue is open and an operator counts it.
    expect(unresolvedGuardianIssueDecisions(replayed)).toHaveLength(1);

    // A later round carries fresh evidence, so it speaks again.
    const nextRound = reconcileFindingIssues({
      ledger: [
        ledgerFinding({
          round: 4,
          finding: finding({ stableId: "A-01", disposition: "REPEATED" }),
        }),
      ],
      alreadyFiled: [
        filed({
          stableId: "A-01",
          round: 2,
          reconciled: { round: 3, action: "UPDATED" },
        }),
      ],
      evidence,
    });
    expect(nextRound.update).toHaveLength(1);
  });
});

describe("applyFindingIssueReconciliation", () => {
  function decisionsFor(
    disposition: "RESOLVED" | "OPEN",
    overrides: Partial<PersistedFiledFinding> = {},
  ) {
    return reconcileFindingIssues({
      ledger: [
        ledgerFinding({
          round: 4,
          finding: finding({ stableId: "A-01", disposition }),
        }),
      ],
      alreadyFiled: [filed({ stableId: "A-01", round: 2, ...overrides })],
      evidence,
    });
  }

  it("comments then closes, and returns the memory to persist", () => {
    const calls: string[] = [];
    const outcome = applyFindingIssueReconciliation({
      reconciliation: decisionsFor("RESOLVED"),
      comment: (decision, body) => {
        calls.push(`comment ${decision.record.issue}`);
        expect(body).toContain("`RESOLVED`");
      },
      close: (decision) => calls.push(`close ${decision.record.issue}`),
      reopen: () => {
        throw new Error("nothing was reopened");
      },
      retries: 0,
    });

    // Order matters: the resolution comment is the record of *why* the issue
    // closed, so it lands before the close.
    expect(calls).toEqual([
      "comment https://github.com/acme/repo/issues/290",
      "close https://github.com/acme/repo/issues/290",
    ]);
    expect(outcome.failed).toEqual([]);
    expect(outcome.applied).toEqual([
      {
        decision: expect.objectContaining({ action: "CLOSE" }),
        reconciled: { round: 4, action: "CLOSED" },
      },
    ]);
  });

  it("comments without closing a still-open finding", () => {
    const close = vi.fn();
    const outcome = applyFindingIssueReconciliation({
      reconciliation: decisionsFor("OPEN"),
      comment: () => {},
      close,
      reopen: () => {},
      retries: 0,
    });

    expect(close).not.toHaveBeenCalled();
    expect(outcome.applied[0]!.reconciled).toEqual({
      round: 4,
      action: "UPDATED",
    });
  });

  it("records nothing when the comment landed but the close failed", () => {
    // The partial GitHub failure. Writing `CLOSED` here would leave the issue
    // open with nobody left to retry it — the exact miscount #320 is about — so
    // the pass records nothing, reports the failure, and pays one duplicate
    // comment next round.
    const outcome = applyFindingIssueReconciliation({
      reconciliation: decisionsFor("RESOLVED"),
      comment: () => {},
      close: () => {
        throw new Error("gh: could not close issue 290 (HTTP 503)");
      },
      reopen: () => {},
      retries: 0,
    });

    expect(outcome.applied).toEqual([]);
    expect(outcome.failed).toEqual([
      {
        decision: expect.objectContaining({ action: "CLOSE" }),
        error: "gh: could not close issue 290 (HTTP 503)",
      },
    ]);
  });

  it("retries each decision independently and never throws", () => {
    let attempts = 0;
    const onRetry = vi.fn();
    const reconciliation = reconcileFindingIssues({
      ledger: [
        ledgerFinding({
          round: 4,
          finding: finding({ stableId: "A-01", disposition: "RESOLVED" }),
        }),
        ledgerFinding({
          round: 4,
          finding: finding({ stableId: "A-02", disposition: "OPEN" }),
        }),
      ],
      alreadyFiled: [
        filed({ stableId: "A-01", round: 2 }),
        filed({
          stableId: "A-02",
          round: 2,
          issue: "https://github.com/acme/repo/issues/291",
        }),
      ],
      evidence,
    });

    const outcome = applyFindingIssueReconciliation({
      reconciliation,
      comment: (decision) => {
        if (decision.record.stableId !== "A-01") return;
        attempts++;
        if (attempts < 2) throw new Error(`gh exited 1 (attempt ${attempts})`);
      },
      close: () => {},
      reopen: () => {},
      retries: 1,
      onRetry,
    });

    expect(outcome.failed).toEqual([]);
    expect(outcome.applied).toHaveLength(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenLastCalledWith(
      expect.objectContaining({
        record: expect.objectContaining({ stableId: "A-01" }),
      }),
      1,
      "gh exited 1 (attempt 1)",
    );
  });

  it("performs nothing for refusals or for evidence already applied", () => {
    const comment = vi.fn();
    const close = vi.fn();
    const reopen = vi.fn();
    const refused = reconcileFindingIssues({
      ledger: [],
      alreadyFiled: [filed({ stableId: "A-01", round: 2 })],
      evidence,
    });
    const unchanged = decisionsFor("OPEN", {
      reconciled: { round: 4, action: "UPDATED" },
    });

    for (const reconciliation of [refused, unchanged]) {
      const outcome = applyFindingIssueReconciliation({
        reconciliation,
        comment,
        close,
        reopen,
        retries: 2,
      });
      expect(outcome).toEqual({ applied: [], failed: [] });
    }
    expect(comment).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(reopen).not.toHaveBeenCalled();
  });

  it("comments then reopens a finding that came back", () => {
    const calls: string[] = [];
    const outcome = applyFindingIssueReconciliation({
      reconciliation: reconcileFindingIssues({
        ledger: [
          ledgerFinding({
            round: 5,
            finding: finding({ stableId: "A-01", disposition: "REGRESSED" }),
          }),
        ],
        alreadyFiled: [
          filed({
            stableId: "A-01",
            round: 2,
            reconciled: { round: 3, action: "CLOSED" },
          }),
        ],
        evidence,
      }),
      comment: () => calls.push("comment"),
      close: () => calls.push("close"),
      reopen: () => calls.push("reopen"),
      retries: 0,
    });

    expect(calls).toEqual(["comment", "reopen"]);
    expect(outcome.applied[0]!.reconciled).toEqual({
      round: 5,
      action: "UPDATED",
    });
  });
});

describe("unresolvedGuardianIssueDecisions", () => {
  it("counts everything the pass did not close, reopened first", () => {
    const decision = (
      action: FindingIssueDecision["action"],
      stableId: string,
    ): FindingIssueDecision => ({
      action,
      record: filed({ stableId }),
      reason: `${action} ${stableId}`,
    });

    expect(
      unresolvedGuardianIssueDecisions({
        update: [decision("UPDATE", "A-02")],
        close: [decision("CLOSE", "A-01")],
        reopen: [decision("REOPEN", "A-03")],
        refuse: [decision("REFUSE", "A-04")],
        unchanged: [decision("UNCHANGED", "A-05")],
      }).map((entry) => entry.record.stableId),
    ).toEqual(["A-03", "A-02", "A-04", "A-05"]);
  });
});
