import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTRACT_RESPONSE_FILENAME,
  CONTRACT_REVIEW_FILENAME,
  type ContractResponsePosition,
  type ContractReviewFinding,
  type ContractReviewVerdict,
} from "./contract-review.js";

type ContractReviewFindingInput = Omit<
  ContractReviewFinding,
  "state" | "revisionCitation"
> &
  Partial<Pick<ContractReviewFinding, "state" | "revisionCitation">>;

/**
 * Write a schema-valid contract review artifact into a slice directory —
 * what a stub `evaluator-contract` produces. Every fixture that drives a
 * verdict goes through here, so a schema change breaks in one place
 * rather than in thirty stub providers.
 *
 * A bare `REVISE` gets one BLOCKING finding, because a REVISE with no
 * blocking finding is a contradiction the parser refuses.
 */
export function writeContractReview(
  sliceDir: string,
  verdict: ContractReviewVerdict,
  findings?: readonly ContractReviewFindingInput[],
): void {
  const inputs =
    findings ??
    (verdict === "REVISE"
      ? [
          {
            id: "F-01",
            severity: "BLOCKING" as const,
            behaviorIds: [],
            evidence: '"the contract as written"',
            expected: "a falsifiable test plan entry",
            observed: "no entry that can fail",
            clearCondition: "the test plan names a command that can fail",
          },
        ]
      : []);
  const resolved: ContractReviewFinding[] = inputs.map((finding) => ({
    ...finding,
    state: finding.state ?? "OPEN",
    revisionCitation: finding.revisionCitation ?? null,
  }));
  writeFileSync(
    join(sliceDir, CONTRACT_REVIEW_FILENAME),
    JSON.stringify({ version: 2, verdict, findings: resolved }, null, 2),
    "utf-8",
  );
}

export function writeContractResponse(
  sliceDir: string,
  findingIds: readonly string[],
  position: ContractResponsePosition = "UNRESOLVED",
): void {
  writeFileSync(
    join(sliceDir, CONTRACT_RESPONSE_FILENAME),
    JSON.stringify(
      {
        version: 1,
        round: 2,
        responses: findingIds.map((findingId) => ({
          findingId,
          position,
          evidence:
            position === "UNRESOLVED"
              ? ""
              : `planner evidence for ${findingId}`,
        })),
      },
      null,
      2,
    ),
    "utf-8",
  );
}

/** Errors Windows raises while another process still holds a handle. */
const TRANSIENT_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM", "EACCES"]);

/**
 * Remove a fixture directory, tolerating Windows handle contention.
 *
 * The integration suites spawn hundreds of real `git` processes against
 * temporary repositories. On Windows a child can still hold a handle on a
 * `.git` file for a short window after it exits, so a bare
 * `rmSync(dir, { recursive: true, force: true })` in an `afterEach` hook
 * intermittently throws `EBUSY`/`ENOTEMPTY` and fails an otherwise green
 * test. Retry with a bounded backoff instead of failing the suite.
 *
 * Synchronous on purpose: cleanup hooks in these suites are synchronous, and
 * making them async would reorder fixture teardown between sibling tests.
 */
export function rmDirWithRetry(dir: string, attempts = 30): void {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= attempts || !TRANSIENT_CODES.has(code)) {
        throw error;
      }
      sleepSync(Math.min(50 * attempt, 400));
    }
  }
}

/**
 * Block the thread briefly. `Atomics.wait` is used rather than a busy loop so
 * the retry backoff does not burn CPU on an already-contended host.
 */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}
