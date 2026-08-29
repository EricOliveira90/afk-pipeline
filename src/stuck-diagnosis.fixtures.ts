import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  QAReviewAttemptFinding,
  QAReviewAttemptRecord,
  QAReviewFinding,
  QAReviewFindingState,
} from "./qa-review.js";

export const STUCK_DIAGNOSIS_ADDITIONAL_ARTIFACTS = [
  ".afk/gates/s01/ROUND-1-GATE.json",
  ".afk/gates/s01/ROUND-2-GATE.log",
] as const;

export const STUCK_DIAGNOSIS_COMMIT_LOG =
  "commit ROUND-2-COMMIT\n" +
  "    second round marker\n\n" +
  "commit ROUND-1-COMMIT\n" +
  "    first round marker";

export const EXPECTED_STUCK_DIAGNOSIS = `# Stuck diagnosis

## Finding lifecycle

### RESOLVED

- [QA-ALPHA] BLOCKING RESOLVED
  - Stage: deterministic
  - Summary: Alpha summary
  - Clear condition: Alpha clear condition
  - Artifact references:
    - \`.afk/artifacts/prd-070-stub/slice-01/reviews/qa-review-r2-a1.json\`
    - \`specs/slices/01-prd-070-regression/qa-report-r2-a1.md\`

### OPEN

- [QA-BETA] BLOCKING OPEN
  - Stage: deterministic
  - Summary: Beta summary
  - Clear condition: Beta clear condition
  - Artifact references:
    - \`.afk/artifacts/prd-070-stub/slice-01/reviews/qa-review-r3-a1.json\`
    - \`specs/slices/01-prd-070-regression/qa-report-r3-a1.md\`

## Scope escalations

- Round 2 attempt 2
  - Finding IDs: \`ESC-BETA\`, \`ESC-ALPHA\`
  - Paths: \`src/beta.ts\`, \`src/alpha.ts\`
  - Reason: Distinct escalation reason

## Round evidence

- Round 1 attempt 1 (deterministic): FAIL / IMPLEMENTATION
  - Lifecycle record: \`qa-review-r1-a1-record.json\`
  - Artifact references:
    - \`.afk/artifacts/prd-070-stub/slice-01/reviews/qa-review-r1-a1.json\`
    - \`specs/slices/01-prd-070-regression/qa-report-r1-a1.md\`
- Round 2 attempt 1 (deterministic): FAIL / IMPLEMENTATION
  - Lifecycle record: \`qa-review-r2-a1-record.json\`
  - Artifact references:
    - \`.afk/artifacts/prd-070-stub/slice-01/reviews/qa-review-r2-a1.json\`
    - \`specs/slices/01-prd-070-regression/qa-report-r2-a1.md\`
- Round 3 attempt 1 (deterministic): FAIL / IMPLEMENTATION
  - Lifecycle record: \`qa-review-r3-a1-record.json\`
  - Artifact references:
    - \`.afk/artifacts/prd-070-stub/slice-01/reviews/qa-review-r3-a1.json\`
    - \`specs/slices/01-prd-070-regression/qa-report-r3-a1.md\`
- Additional artifact: \`.afk/gates/s01/ROUND-1-GATE.json\`
- Additional artifact: \`.afk/gates/s01/ROUND-2-GATE.log\`

## Commit evidence

\`\`\`text
commit ROUND-2-COMMIT
    second round marker

commit ROUND-1-COMMIT
    first round marker
\`\`\`
`;

function reviewFinding(
  id: "QA-ALPHA" | "QA-BETA",
  severity: "BLOCKING" | "ADVISORY",
  state: QAReviewFindingState,
  summary: string,
  clearCondition: string,
): QAReviewFinding {
  return {
    id,
    severity,
    behaviorIds: ["B-01"],
    summary,
    evidence: `${id} fixture evidence`,
    expected: `${id} expected behavior`,
    observed: `${id} observed behavior`,
    clearCondition,
    state,
    remedy: "SOURCE_CHANGE",
    amendmentPaths: [],
  };
}

export function stuckDiagnosisReviewFindings(
  round: 1 | 2 | 3,
): QAReviewFinding[] {
  if (round === 1) {
    return [
      reviewFinding(
        "QA-ALPHA",
        "BLOCKING",
        "OPEN",
        "Alpha summary",
        "Alpha clear condition",
      ),
    ];
  }
  if (round === 2) {
    return [
      reviewFinding(
        "QA-ALPHA",
        "BLOCKING",
        "RESOLVED",
        "Alpha summary",
        "Alpha clear condition",
      ),
      reviewFinding(
        "QA-BETA",
        "BLOCKING",
        "OPEN",
        "Beta summary",
        "Beta clear condition",
      ),
    ];
  }
  return [
    reviewFinding(
      "QA-BETA",
      "BLOCKING",
      "OPEN",
      "Beta summary",
      "Beta clear condition",
    ),
  ];
}

function attemptFinding(
  finding: QAReviewFinding,
  round: number,
): QAReviewAttemptFinding {
  return {
    id: finding.id,
    severity: finding.severity,
    state: finding.state,
    unresolved: finding.state === "OPEN",
    summary: finding.summary,
    clearCondition: finding.clearCondition,
    artifactReferences: [
      `.afk/artifacts/prd-070-stub/slice-01/reviews/qa-review-r${round}-a1.json`,
      `specs/slices/01-prd-070-regression/qa-report-r${round}-a1.md`,
    ],
    remedy: finding.remedy,
  };
}

export function stuckDiagnosisAttemptRecord(
  round: 1 | 2 | 3,
): QAReviewAttemptRecord {
  return {
    version: 2,
    stage: "deterministic",
    round,
    attempt: 1,
    verdict: "FAIL",
    failureClass: "IMPLEMENTATION",
    findings: stuckDiagnosisReviewFindings(round).map((finding) =>
      attemptFinding(finding, round),
    ),
  };
}

export function seedStuckDiagnosisArchive(
  reviewArchiveDir: string,
  options: {
    rounds?: readonly (1 | 2 | 3)[];
    reverse?: boolean;
    includeEscalation?: boolean;
  } = {},
): void {
  const rounds = options.rounds ?? [1, 2, 3];
  const entries: Array<[string, string]> = rounds.map((round) => [
    `qa-review-r${round}-a1-record.json`,
    JSON.stringify(stuckDiagnosisAttemptRecord(round)),
  ]);
  if (options.includeEscalation ?? true) {
    entries.push([
      "escalation-r2-a2.md",
      JSON.stringify({
        version: 1,
        findingIds: ["ESC-BETA", "ESC-ALPHA"],
        paths: ["src/beta.ts", "src/alpha.ts"],
        reason: "Distinct escalation reason",
      }),
    ]);
  }
  if (options.reverse) entries.reverse();
  mkdirSync(reviewArchiveDir, { recursive: true });
  for (const [name, contents] of entries) {
    writeFileSync(join(reviewArchiveDir, name), contents, "utf-8");
  }
}
