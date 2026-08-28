import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveContractReviewRecord,
  archiveArtifactsBeforeRestart,
  archiveQAReviewAttempt,
  archiveQAReviewRecord,
  archiveQAReviewValidation,
  classifyReviewFailure,
  hasStuckFile,
  isFavorableReviewOutcome,
  isReviewInfrastructureFailure,
  lockContract,
  reopenContract,
  readContractFiles,
  readContractStatus,
  preserveNegotiationFailure,
  readReviewVerdict,
} from "./artifacts.js";
import type {
  ContractNegotiationOutcome,
  ContractReviewAttemptRecord,
} from "./contract-review.js";
import type { QAReviewAttemptRecord } from "./qa-review.js";

/**
 * Regression tests for the review-verdict parser.
 *
 * All three wire formats below were observed in real AFK runs under
 * `.afk/logs/<prd>/slice-all-{architect,pm}-review.log` where the summary
 * ended up as "UNKNOWN" because the original regex only accepted a single
 * markdown emphasis style.
 */

function withTempFile(content: string, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "afk-artifacts-"));
  const path = join(dir, "review.md");
  try {
    writeFileSync(path, content, "utf-8");
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("archiveContractReviewRecord", () => {
  it("writes a round-and-attempt-stamped lifecycle record", () => {
    const archiveDir = mkdtempSync(join(tmpdir(), "afk-review-record-"));
    const record: ContractReviewAttemptRecord = {
      version: 1,
      round: 2,
      attempt: 3,
      verdict: "REVISE",
      findings: [
        {
          id: "F-01",
          severity: "BLOCKING",
          state: "CONTESTED",
          unresolved: true,
          plannerPosition: "CONTESTED",
          plannerEvidence: "the existing gate is sufficient",
          evaluatorEvidence: "the gate misses the negative path",
        },
      ],
    };
    try {
      expect(
        archiveContractReviewRecord({ archiveDir, record }),
      ).toBe("contract-review-r2-a3-record.json");
      expect(
        JSON.parse(
          readFileSync(
            join(archiveDir, "contract-review-r2-a3-record.json"),
            "utf-8",
          ),
        ),
      ).toEqual(record);
    } finally {
      rmSync(archiveDir, { recursive: true, force: true });
    }
  });
});

describe("canonical QA review archives", () => {
  it("copies raw QA and UAT attempts under exact stage-specific names", () => {
    const sliceDir = mkdtempSync(join(tmpdir(), "afk-qa-review-source-"));
    const archiveDir = mkdtempSync(join(tmpdir(), "afk-qa-review-archive-"));
    try {
      writeFileSync(join(sliceDir, "qa-review.json"), '{"version":1}', "utf-8");
      writeFileSync(join(sliceDir, "uat-review.json"), '{"version":1}', "utf-8");

      expect(
        archiveQAReviewAttempt({
          sliceDir,
          archiveDir,
          stage: "deterministic",
          round: 2,
          attempt: 3,
        }),
      ).toBe("qa-review-r2-a3.json");
      expect(
        archiveQAReviewAttempt({
          sliceDir,
          archiveDir,
          stage: "shared-preview",
          round: 1,
          attempt: 2,
        }),
      ).toBe("uat-review-r1-a2.json");
      expect(
        readFileSync(join(archiveDir, "qa-review-r2-a3.json"), "utf-8"),
      ).toBe('{"version":1}');
      expect(
        readFileSync(join(archiveDir, "uat-review-r1-a2.json"), "utf-8"),
      ).toBe('{"version":1}');
    } finally {
      rmSync(sliceDir, { recursive: true, force: true });
      rmSync(archiveDir, { recursive: true, force: true });
    }
  });

  it("returns null and creates no raw archive when canonical JSON is missing", () => {
    const sliceDir = mkdtempSync(join(tmpdir(), "afk-qa-review-source-"));
    const archiveDir = join(sliceDir, "reviews");
    try {
      expect(
        archiveQAReviewAttempt({
          sliceDir,
          archiveDir,
          stage: "deterministic",
          round: 1,
          attempt: 1,
        }),
      ).toBeNull();
      expect(existsSync(archiveDir)).toBe(false);
    } finally {
      rmSync(sliceDir, { recursive: true, force: true });
    }
  });

  it("writes validation evidence without inventing a lifecycle record", () => {
    const archiveDir = mkdtempSync(join(tmpdir(), "afk-qa-validation-"));
    try {
      expect(
        archiveQAReviewValidation({
          archiveDir,
          stage: "shared-preview",
          round: 3,
          attempt: 1,
          evidence: "uat-review.json is missing",
        }),
      ).toBe("uat-review-r3-a1-validation.txt");
      expect(
        readFileSync(
          join(archiveDir, "uat-review-r3-a1-validation.txt"),
          "utf-8",
        ),
      ).toBe("uat-review.json is missing\n");
      expect(
        existsSync(join(archiveDir, "uat-review-r3-a1-record.json")),
      ).toBe(false);
    } finally {
      rmSync(archiveDir, { recursive: true, force: true });
    }
  });

  it("writes a valid lifecycle record under the exact attempt name", () => {
    const archiveDir = mkdtempSync(join(tmpdir(), "afk-qa-record-"));
    const record: QAReviewAttemptRecord = {
      version: 1,
      stage: "deterministic",
      round: 1,
      attempt: 1,
      verdict: "FAIL",
      failureClass: "IMPLEMENTATION",
      findings: [
        {
          id: "QA-01",
          severity: "BLOCKING",
          state: "OPEN",
          unresolved: true,
          summary: "Retry needed",
          clearCondition: "The regression test passes",
          artifactReferences: [
            "qa-review-r1-a1.json",
            "qa-report-r1-a1.md",
          ],
        },
      ],
    };
    try {
      expect(archiveQAReviewRecord({ archiveDir, record })).toBe(
        "qa-review-r1-a1-record.json",
      );
      expect(
        JSON.parse(
          readFileSync(
            join(archiveDir, "qa-review-r1-a1-record.json"),
            "utf-8",
          ),
        ),
      ).toEqual(record);
    } finally {
      rmSync(archiveDir, { recursive: true, force: true });
    }
  });
});


/**
 * A from-base restart recreates the slice worktree, so the untracked spec
 * artifacts under it are the only copy until something copies them out
 * (#113). The PRD 1 incident lost a LOCKED contract, its operator
 * amendment, context.md, two feedback rounds and every qa-report this
 * way, because archiving only ran on ESCALATE/STUCK.
 */
describe("archiveArtifactsBeforeRestart (#113)", () => {
  function makeSliceFixture(names: string[]) {
    const repoRoot = mkdtempSync(join(tmpdir(), "afk-prerestart-"));
    const sliceDir = join(repoRoot, ".afk", "worktrees", "s01", "slices", "01-demo");
    mkdirSync(sliceDir, { recursive: true });
    for (const name of names) writeFileSync(join(sliceDir, name), `# ${name}\n`, "utf-8");
    return { repoRoot, sliceDir };
  }

  it("copies out the contract, context, feedback rounds and qa reports", () => {
    const names = [
      "contract.md",
      "context.md",
      "feedback-r1.md",
      "feedback-r2.md",
      "qa-report.md",
      "uat-report.md",
      "handoff.md",
    ];
    const { repoRoot, sliceDir } = makeSliceFixture(names);
    try {
      writeFileSync(join(sliceDir, "contract.md"), "**Status:** LOCKED\n", "utf-8");

      const archiveDir = archiveArtifactsBeforeRestart(
        repoRoot,
        "demo-stub",
        "01",
        sliceDir,
      );

      expect(archiveDir).toBe(
        join(repoRoot, ".afk", "artifacts", "demo-stub", "slice-01", "pre-restart-1"),
      );
      // The restart would delete the worktree — prove the archive stands alone.
      rmSync(sliceDir, { recursive: true, force: true });
      for (const name of names) {
        expect(existsSync(join(archiveDir!, name))).toBe(true);
      }
      expect(readFileSync(join(archiveDir!, "contract.md"), "utf-8")).toContain(
        "**Status:** LOCKED",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("numbers each restart so a second one cannot overwrite the first", () => {
    const { repoRoot, sliceDir } = makeSliceFixture(["contract.md"]);
    try {
      writeFileSync(join(sliceDir, "contract.md"), "first\n", "utf-8");
      const first = archiveArtifactsBeforeRestart(repoRoot, "s", "01", sliceDir)!;
      writeFileSync(join(sliceDir, "contract.md"), "second\n", "utf-8");
      const second = archiveArtifactsBeforeRestart(repoRoot, "s", "01", sliceDir)!;

      expect(second).not.toBe(first);
      expect(readFileSync(join(first, "contract.md"), "utf-8")).toContain("first");
      expect(readFileSync(join(second, "contract.md"), "utf-8")).toContain("second");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  /**
   * #123: nothing ever cleared `reviews/`, and since #79 a round-1
   * evidence write that lands on another life's `r1-a1` archive fails
   * closed — so a restarted slice burned its infrastructure retries on a
   * deterministic collision. The dir is *moved*, not copied: copying
   * would leave the slots occupied.
   */
  it("moves the prior life's review archives out of round 1's way", () => {
    const { repoRoot, sliceDir } = makeSliceFixture(["contract.md"]);
    try {
      const reviews = join(
        repoRoot, ".afk", "artifacts", "s", "slice-01", "reviews",
      );
      mkdirSync(reviews, { recursive: true });
      writeFileSync(
        join(reviews, "qa-review-r1-a1.json"), "prior life\n", "utf-8",
      );
      writeFileSync(
        join(reviews, "qa-review-r1-a1-record.json"), "{}\n", "utf-8",
      );

      const archiveDir = archiveArtifactsBeforeRestart(
        repoRoot, "s", "01", sliceDir,
      )!;

      // The slot round 1 will write to is free again...
      expect(existsSync(join(reviews, "qa-review-r1-a1.json"))).toBe(false);
      // ...and the evidence still exists, whole, one level down: a record
      // and the raw artifact it references travel together.
      expect(
        readFileSync(
          join(archiveDir, "reviews", "qa-review-r1-a1.json"), "utf-8",
        ),
      ).toBe("prior life\n");
      expect(
        existsSync(join(archiveDir, "reviews", "qa-review-r1-a1-record.json")),
      ).toBe(true);
      // And the write that used to hit `errorOnExist` goes through.
      writeFileSync(join(sliceDir, "qa-review.json"), "new life\n", "utf-8");
      expect(
        archiveQAReviewAttempt({
          sliceDir,
          archiveDir: reviews,
          stage: "deterministic",
          round: 1,
          attempt: 1,
        }),
      ).toBe("qa-review-r1-a1.json");
      expect(readFileSync(join(reviews, "qa-review-r1-a1.json"), "utf-8")).toBe(
        "new life\n",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("relocates stale reviews for a slice whose worktree is already gone", () => {
    const { repoRoot } = makeSliceFixture([]);
    try {
      const reviews = join(
        repoRoot, ".afk", "artifacts", "s", "slice-01", "reviews",
      );
      mkdirSync(reviews, { recursive: true });
      writeFileSync(
        join(reviews, "qa-review-r1-a1.json"), "prior life\n", "utf-8",
      );

      // No spec artifacts to copy — the clean-failed/deleted-branch state
      // — so the archive dir exists for the relocation alone.
      const archiveDir = archiveArtifactsBeforeRestart(
        repoRoot, "s", "01", join(repoRoot, "nope"),
      );

      expect(archiveDir).toBe(
        join(repoRoot, ".afk", "artifacts", "s", "slice-01", "pre-restart-1"),
      );
      expect(existsSync(join(archiveDir!, "reviews", "qa-review-r1-a1.json")))
        .toBe(true);
      expect(existsSync(reviews)).toBe(false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("leaves an empty reviews dir alone rather than numbering a restart for it", () => {
    const { repoRoot, sliceDir } = makeSliceFixture([]);
    try {
      const reviews = join(
        repoRoot, ".afk", "artifacts", "s", "slice-01", "reviews",
      );
      mkdirSync(reviews, { recursive: true });

      expect(archiveArtifactsBeforeRestart(repoRoot, "s", "01", sliceDir))
        .toBeNull();
      expect(
        existsSync(join(repoRoot, ".afk", "artifacts", "s", "slice-01", "pre-restart-1")),
      ).toBe(false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("archives nothing, and creates no directory, for a slice with no artifacts", () => {
    const { repoRoot, sliceDir } = makeSliceFixture([]);
    try {
      expect(archiveArtifactsBeforeRestart(repoRoot, "s", "01", sliceDir)).toBeNull();
      expect(existsSync(join(repoRoot, ".afk", "artifacts"))).toBe(false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("tolerates a slice dir that does not exist yet", () => {
    const { repoRoot } = makeSliceFixture([]);
    try {
      expect(
        archiveArtifactsBeforeRestart(repoRoot, "s", "01", join(repoRoot, "nope")),
      ).toBeNull();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("preserveNegotiationFailure", () => {
  function makeFailureFixture() {
    const repoRoot = mkdtempSync(join(tmpdir(), "afk-preserve-"));
    const sliceDir = join(repoRoot, ".afk", "worktrees", "slice", "spec", "slices", "01-demo");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, "contract.md"), "# Contract\n\n**Status:** NEGOTIATING\n", "utf-8");
    writeFileSync(join(sliceDir, "context.md"), "# Context\n", "utf-8");
    writeFileSync(join(sliceDir, "feedback-r1.md"), "VERDICT: REVISE\n", "utf-8");
    writeFileSync(
      join(sliceDir, "feedback-r2.md"),
      "VERDICT: REVISE\n\n### If REVISE, specific gaps:\n- Add an issue-body acceptance clause.\n",
      "utf-8",
    );
    return { repoRoot, sliceDir };
  }

  it("writes and renders the versioned exhaustion outcome", () => {
    const { repoRoot, sliceDir } = makeFailureFixture();
    const negotiationOutcome: ContractNegotiationOutcome = {
      version: 1,
      classification: "IMPASSE",
      round: 2,
      attempt: 1,
      findings: [
        {
          id: "F-CONTEST",
          severity: "BLOCKING",
          state: "CONTESTED",
          unresolved: true,
          plannerPosition: "CONTESTED",
          plannerEvidence: "the existing gate is sufficient",
          evaluatorEvidence: "the gate misses the negative path",
        },
      ],
    };
    try {
      preserveNegotiationFailure({
        repoRoot,
        runSlug: "impasse-stub",
        sliceDir,
        sliceNumber: "01",
        ghIssue: "7001",
        title: "Notification foundation",
        round: 2,
        outcome: "ESCALATE",
        verdict: "REVISE",
        feedbackPath: join(sliceDir, "feedback-r2.md"),
        contractPath: join(sliceDir, "contract.md"),
        contextPath: join(sliceDir, "context.md"),
        negotiationOutcome,
      });

      expect(
        JSON.parse(
          readFileSync(
            join(sliceDir, "contract-negotiation-outcome.json"),
            "utf-8",
          ),
        ),
      ).toEqual(negotiationOutcome);
      const stuck = readFileSync(join(sliceDir, "stuck.md"), "utf-8");
      expect(stuck).toContain("Exhaustion classification: IMPASSE");
      expect(stuck).toContain("Planner position: CONTESTED");
      expect(stuck).toContain(
        "Planner evidence: the existing gate is sufficient",
      );
      expect(stuck).toContain(
        "Evaluator evidence: the gate misses the negative path",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("writes actionable ESCALATE details and archives every negotiation artifact", () => {
    const { repoRoot, sliceDir } = makeFailureFixture();
    try {
      const result = preserveNegotiationFailure({
        repoRoot,
        runSlug: "demo-stub",
        sliceDir,
        sliceNumber: "01",
        ghIssue: "7001",
        title: "Notification foundation",
        round: 2,
        outcome: "ESCALATE",
        verdict: "REVISE",
        feedbackPath: join(sliceDir, "feedback-r2.md"),
        contractPath: join(sliceDir, "contract.md"),
        contextPath: join(sliceDir, "context.md"),
        capDecision: "Round cap reached; extension refused because gaps were flat.",
      });

      expect(result.archived).toBe(true);
      expect(hasStuckFile(sliceDir)).toBe(true);
      const stuck = readFileSync(join(sliceDir, "stuck.md"), "utf-8");
      expect(stuck).toContain("#7001 Notification foundation");
      expect(stuck).toContain("Final verdict: VERDICT: REVISE");
      expect(stuck).toContain("Add an issue-body acceptance clause.");
      expect(stuck).toContain(".afk/artifacts/demo-stub/slice-01/contract.md");

      rmSync(sliceDir, { recursive: true, force: true });
      for (const name of [
        "contract.md",
        "context.md",
        "feedback-r1.md",
        "feedback-r2.md",
        "stuck.md",
      ]) {
        expect(existsSync(join(result.archiveDir, name))).toBe(true);
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("writes STUCK details and warns without throwing when archiving fails", () => {
    const { repoRoot, sliceDir } = makeFailureFixture();
    const warnings: string[] = [];
    try {
      const blockedRunDir = join(repoRoot, ".afk", "artifacts", "blocked-run");
      mkdirSync(join(repoRoot, ".afk", "artifacts"), { recursive: true });
      writeFileSync(blockedRunDir, "not a directory", "utf-8");

      const result = preserveNegotiationFailure(
        {
          repoRoot,
          runSlug: "blocked-run",
          sliceDir,
          sliceNumber: "01",
          ghIssue: "7001",
          title: "Notification foundation",
          round: 2,
          outcome: "STUCK",
          verdict: "NONE",
          feedbackPath: join(sliceDir, "feedback-r2.md"),
          contractPath: join(sliceDir, "contract.md"),
          contextPath: join(sliceDir, "context.md"),
        },
        (message) => warnings.push(message),
      );

      expect(result.archived).toBe(false);
      expect(hasStuckFile(sliceDir)).toBe(true);
      expect(readFileSync(join(sliceDir, "stuck.md"), "utf-8")).toContain(
        "Outcome: STUCK",
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("failed to archive negotiation artifacts");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("readReviewVerdict", () => {
  let cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  describe("real-world formats observed in AFK runs", () => {
    it("parses bold format: **Verdict:** SHIP (bug-fixes-round-2 architect)", () => {
      withTempFile(
        `# Architect Review\n\n**Date:** 2026-05-05\n**Verdict:** SHIP\n\nAll good.\n`,
        (p) => expect(readReviewVerdict(p)).toBe("SHIP"),
      );
    });

    it("parses markdown header: ## Verdict: SHIP (architecture-deepening both, bug-fixes-round-2 PM)", () => {
      withTempFile(
        `# PM Review\n\nSome prose.\n\n## Verdict: SHIP\n\nBoth slices are minimal bug fixes.\n`,
        (p) => expect(readReviewVerdict(p)).toBe("SHIP"),
      );
    });

    it("returns UNPARSEABLE when no Verdict line is present (bug-fixes-tiers-1-3 both)", () => {
      withTempFile(
        `# Architect Review\n\nCritical finding: slice 01 has 5 of 8 requirements completely unimplemented.\n\nThe two blockers must be fixed before the client demo.\n`,
        (p) => expect(readReviewVerdict(p)).toBe("UNPARSEABLE"),
      );
    });
  });

  describe("accepted format variations", () => {
    it("parses ACCEPT-WITH-NOTES under bold format", () => {
      withTempFile(`**Verdict:** ACCEPT-WITH-NOTES\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("ACCEPT-WITH-NOTES"),
      );
    });

    it("parses ACCEPT WITH NOTES (spaces) under header format", () => {
      withTempFile(`## Verdict: ACCEPT WITH NOTES\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("ACCEPT-WITH-NOTES"),
      );
    });

    it("parses FIX-BEFORE-SHIP under header format", () => {
      withTempFile(`### Verdict: FIX-BEFORE-SHIP\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("FIX-BEFORE-SHIP"),
      );
    });

    it("parses FIX BEFORE SHIP (spaces) under bold format", () => {
      withTempFile(`**Verdict:** FIX BEFORE SHIP\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("FIX-BEFORE-SHIP"),
      );
    });

    it("parses plain format: Verdict: SHIP", () => {
      withTempFile(`Verdict: SHIP\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("SHIP"),
      );
    });

    it("parses single-asterisk italic: *Verdict:* SHIP", () => {
      withTempFile(`*Verdict:* SHIP\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("SHIP"),
      );
    });

    it("is case-insensitive on the 'Verdict' key", () => {
      withTempFile(`**verdict:** ship\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("SHIP"),
      );
    });

    it("tolerates trailing whitespace after the value", () => {
      withTempFile(`**Verdict:** SHIP   \n`, (p) =>
        expect(readReviewVerdict(p)).toBe("SHIP"),
      );
    });

    it("strips trailing bold markers on the value itself", () => {
      withTempFile(`**Verdict: SHIP**\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("SHIP"),
      );
    });
  });

  describe("negative cases", () => {
    it("returns UNPARSEABLE when the file does not exist", () => {
      expect(readReviewVerdict("/nonexistent/path/review.md")).toBe("UNPARSEABLE");
    });

    it("returns UNPARSEABLE when the verdict value is unrecognized", () => {
      withTempFile(`**Verdict:** MAYBE\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("UNPARSEABLE"),
      );
    });

    it("returns UNPARSEABLE for a file with only prose", () => {
      withTempFile(`# Review\n\nLooks fine to me.\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("UNPARSEABLE"),
      );
    });
  });
});

/**
 * Tests for `readContractFiles`, the planner's declared "Files expected
 * to change" extractor used by the lane partitioner.
 *
 * Section semantics: undefined when the file or section is missing;
 * empty array when the section exists but yielded no usable paths.
 */
function withContractFile(
  content: string,
  fn: (path: string) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), "afk-contract-"));
  const path = join(dir, "contract.md");
  try {
    writeFileSync(path, content, "utf-8");
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("readContractFiles", () => {
  it("returns undefined when the contract file is missing", () => {
    expect(readContractFiles("/nonexistent/path/contract.md")).toBeUndefined();
  });

  it("returns undefined when the section heading is absent", () => {
    withContractFile(
      `# Slice Contract\n\n## Scope lock\nDo a thing.\n`,
      (p) => expect(readContractFiles(p)).toBeUndefined(),
    );
  });

  it("returns [] when the section exists but is empty", () => {
    withContractFile(
      `# Slice Contract\n\n## Files expected to change\n\n## Test plan\n- a test\n`,
      (p) => expect(readContractFiles(p)).toEqual([]),
    );
  });

  it("returns [] for the <rough list> placeholder", () => {
    withContractFile(
      `## Files expected to change\n- <rough list>\n\n## Test plan\n- a test\n`,
      (p) => expect(readContractFiles(p)).toEqual([]),
    );
  });

  it("returns [] for the <unknown> opt-out", () => {
    withContractFile(
      `## Files expected to change\n- <unknown>\n\n## Test plan\n- a test\n`,
      (p) => expect(readContractFiles(p)).toEqual([]),
    );
  });

  it("strips trailing prose annotation: '- src/cli.py (rename) ' → 'src/cli.py'", () => {
    withContractFile(
      `## Files expected to change\n- src/cli.py (rename to support recipe group)\n`,
      (p) => expect(readContractFiles(p)).toEqual(["src/cli.py"]),
    );
  });

  it("unwraps a backticked path: '- `src/lanes.ts`' → 'src/lanes.ts'", () => {
    withContractFile(
      "## Files expected to change\n- `src/lanes.ts` (new)\n",
      (p) => expect(readContractFiles(p)).toEqual(["src/lanes.ts"]),
    );
  });

  it("collects multiple bullets and stops at the next heading", () => {
    withContractFile(
      `## Files expected to change
- src/cli.py
- src/lanes.ts
- \`src/orchestrator.ts\` (touch wave loop)

## New patterns
- src/should-not-appear.ts
`,
      (p) =>
        expect(readContractFiles(p)).toEqual([
          "src/cli.py",
          "src/lanes.ts",
          "src/orchestrator.ts",
        ]),
    );
  });

  it("supports asterisk bullets as well as dashes", () => {
    withContractFile(
      `## Files expected to change\n* src/cli.py\n* src/lanes.ts\n`,
      (p) => expect(readContractFiles(p)).toEqual(["src/cli.py", "src/lanes.ts"]),
    );
  });
});

describe("readContractStatus", () => {
  it("returns LOCKED when the Status field is literally LOCKED", () => {
    withContractFile(
      `# Slice Contract\n\n**Status:** LOCKED\n\n## Scope lock\nFoo.\n`,
      (p) => expect(readContractStatus(p)).toBe("LOCKED"),
    );
  });

  it("returns NEGOTIATING when Status is NEGOTIATING — even if evaluator wrote ACCEPT", () => {
    withContractFile(
      [
        `# Slice Contract`,
        ``,
        `**Status:** NEGOTIATING`,
        ``,
        `## Scope lock`,
        `Foo.`,
        ``,
        `## Evaluator feedback — round 1`,
        ``,
        `VERDICT: ACCEPT`,
      ].join("\n"),
      (p) => expect(readContractStatus(p)).toBe("NEGOTIATING"),
    );
  });

  it("returns NEGOTIATING when Status is missing entirely", () => {
    withContractFile(
      `# Slice Contract\n\n## Scope lock\nFoo.\n`,
      (p) => expect(readContractStatus(p)).toBe("NEGOTIATING"),
    );
  });

  it("returns UNKNOWN when the file is missing", () => {
    expect(readContractStatus("/nonexistent/path/contract.md")).toBe("UNKNOWN");
  });
});

describe("lockContract", () => {
  it("flips **Status:** NEGOTIATING to LOCKED in place", () => {
    withContractFile(
      `# Slice\n\n**Status:** NEGOTIATING\n**Negotiation round:** 1\n\n## Scope lock\nFoo.\n`,
      (p) => {
        lockContract(p);
        expect(readContractStatus(p)).toBe("LOCKED");
        const content = readFileSync(p, "utf-8");
        expect(content).toContain("**Status:** LOCKED");
        expect(content).not.toContain("**Status:** NEGOTIATING");
        // Other fields preserved.
        expect(content).toContain("**Negotiation round:** 1");
        expect(content).toContain("## Scope lock");
      },
    );
  });

  it("is idempotent when Status is already LOCKED", () => {
    withContractFile(
      `# Slice\n\n**Status:** LOCKED\n\n## Scope lock\nFoo.\n`,
      (p) => {
        lockContract(p);
        const content = readFileSync(p, "utf-8");
        expect(content.match(/\*\*Status:\*\*/g)?.length).toBe(1);
      },
    );
  });

  it("inserts the Status field if absent (defensive — should never happen in prod)", () => {
    withContractFile(`# Slice Contract\n\n## Scope lock\nFoo.\n`, (p) => {
      lockContract(p);
      expect(readContractStatus(p)).toBe("LOCKED");
    });
  });
});

/**
 * Taking a lock back (ADR 0028). When the contract-lock gate refuses a
 * contract the orchestrator has already locked, the file must stop
 * claiming LOCKED — the generator's own invariant reads that field, so a
 * stale LOCKED would let a contract the pipeline rejected reach
 * generation.
 */
describe("reopenContract", () => {
  it("flips **Status:** LOCKED back to NEGOTIATING in place", () => {
    withContractFile(
      `# Slice\n\n**Status:** LOCKED\n\n## Files expected to change\n- supabase/migrations/003_a.sql\n`,
      (p) => {
        reopenContract(p);
        expect(readContractStatus(p)).toBe("NEGOTIATING");
        const content = readFileSync(p, "utf-8");
        expect(content).not.toContain("**Status:** LOCKED");
        // The rest of the contract survives for the planner to revise.
        expect(content).toContain("supabase/migrations/003_a.sql");
      },
    );
  });

  it("round-trips with lockContract", () => {
    withContractFile(`# Slice\n\n**Status:** NEGOTIATING\n`, (p) => {
      lockContract(p);
      reopenContract(p);
      lockContract(p);
      expect(readContractStatus(p)).toBe("LOCKED");
      expect(
        readFileSync(p, "utf-8").match(/\*\*Status:\*\*/g)?.length,
      ).toBe(1);
    });
  });

  it("is idempotent when Status is already NEGOTIATING", () => {
    withContractFile(`# Slice\n\n**Status:** NEGOTIATING\n`, (p) => {
      reopenContract(p);
      expect(readContractStatus(p)).toBe("NEGOTIATING");
      expect(
        readFileSync(p, "utf-8").match(/\*\*Status:\*\*/g)?.length,
      ).toBe(1);
    });
  });
});


/**
 * ADR 0015 review failure classes. The classifier turns a rejected
 * guardian invocation into NEVER_RAN (died at spawn, before any parsed
 * output) or DIED_MID_RUN (killed after real activity) — both
 * infrastructure-class and retried, unlike terminal UNPARSEABLE.
 */
describe("classifyReviewFailure", () => {
  it("classifies a spawn-style wrapper failure with no output as NEVER_RAN", () => {
    // Verbatim failure shape from the PRD 070 run (attempt 8).
    const error = new Error(
      "Agent pm-review exited with code 1: codex-wrapper: error: failed to persist AWS config file: failed to persist temporary file: Access is denied. (os error 5)",
    );
    expect(classifyReviewFailure(error, false)).toBe("NEVER_RAN");
  });

  it("classifies a nonzero exit after real stream activity as DIED_MID_RUN", () => {
    const error = new Error("Agent pm-review exited with code 1: boom");
    expect(classifyReviewFailure(error, true)).toBe("DIED_MID_RUN");
  });

  it("classifies an idle-watcher kill as DIED_MID_RUN even without observed output", () => {
    // codex uses "- killed", claude/kiro use "— killed"; both must match.
    expect(
      classifyReviewFailure(new Error("Agent pm-review idle for 600s - killed"), false),
    ).toBe("DIED_MID_RUN");
    expect(
      classifyReviewFailure(new Error("Agent pm-review idle for 600s — killed"), false),
    ).toBe("DIED_MID_RUN");
  });

  it("classifies a tool-cap kill as DIED_MID_RUN", () => {
    expect(
      classifyReviewFailure(
        new Error("Agent architect-review exceeded 100 tool calls - killed"),
        false,
      ),
    ).toBe("DIED_MID_RUN");
  });

  it("classifies non-Error rejections without output as NEVER_RAN", () => {
    expect(classifyReviewFailure("ENOENT", false)).toBe("NEVER_RAN");
  });
});

describe("review outcome predicates", () => {
  it("treats only SHIP and ACCEPT-WITH-NOTES as favorable", () => {
    expect(isFavorableReviewOutcome("SHIP")).toBe(true);
    expect(isFavorableReviewOutcome("ACCEPT-WITH-NOTES")).toBe(true);
    expect(isFavorableReviewOutcome("FIX-BEFORE-SHIP")).toBe(false);
    expect(isFavorableReviewOutcome("UNPARSEABLE")).toBe(false);
    expect(isFavorableReviewOutcome("NEVER_RAN")).toBe(false);
    expect(isFavorableReviewOutcome("DIED_MID_RUN")).toBe(false);
  });

  it("treats only NEVER_RAN and DIED_MID_RUN as infrastructure failures", () => {
    expect(isReviewInfrastructureFailure("NEVER_RAN")).toBe(true);
    expect(isReviewInfrastructureFailure("DIED_MID_RUN")).toBe(true);
    expect(isReviewInfrastructureFailure("UNPARSEABLE")).toBe(false);
    expect(isReviewInfrastructureFailure("FIX-BEFORE-SHIP")).toBe(false);
    expect(isReviewInfrastructureFailure("SHIP")).toBe(false);
  });
});
