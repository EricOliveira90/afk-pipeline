import { describe, expect, it, vi } from "vitest";
import {
  buildFindingIssueDrafts,
  fileFindingIssues,
  type FindingIssueDraft,
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
    ...overrides,
  };
}

describe("buildFindingIssueDrafts", () => {
  it("carries the ledger identity, the clear condition, and where to read the review", () => {
    const [blocker] = buildFindingIssueDrafts({
      prdSlug: "demo",
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
    expect(outcome.filed).toEqual([
      {
        guardian: "architect",
        stableId: "A-01",
        fingerprint: expect.any(String),
        kind: "NOTE",
        round: 1,
        issue: "https://github.com/acme/repo/issues/A-01",
      },
      {
        guardian: "architect",
        stableId: "A-02",
        fingerprint: "fp-2",
        kind: "NOTE",
        round: 1,
        issue: "https://github.com/acme/repo/issues/A-02",
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
