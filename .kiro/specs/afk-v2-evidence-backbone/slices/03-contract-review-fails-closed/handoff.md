# Handoff

Slice #77 was implemented by hand, outside the pipeline, on the
pipeline's slice branch. The AFK attempt died at worktree refresh before
its explorer ran, so there is no `context.md` and no negotiated
`contract.md` for this slice — the issue's acceptance criteria (including
the operator's type-strictness amendment) were the spec.

## What shipped

- Canonical verdict artifact: `src/contract-review.ts` defines
  `contract-review.json` — `version: 1`, one `verdict` (`ACCEPT` or
  `REVISE`), and `findings`, each carrying `id`, `severity`
  (`BLOCKING`/`ADVISORY`), `behaviorIds`, `evidence`, `expected`,
  `observed`, and `clearCondition`.
- Fail-closed parsing: `parseContractReview` refuses a missing file,
  invalid JSON, a non-object root, an unknown version, extra or missing
  root keys, an unrecognized verdict or severity, extra finding keys,
  duplicate finding IDs, a non-array or non-string-element `behaviorIds`,
  blank or duplicate behavior IDs, and a non-string or blank value in any
  of `id`, `evidence`, `expected`, `observed`, `clearCondition`.
- Contradiction checks: `ACCEPT` beside any `BLOCKING` finding is refused
  with every offending finding ID named, and `REVISE` with no `BLOCKING`
  finding is refused — a REVISE that gives the planner nothing to clear
  is as unusable as a silent ACCEPT.
- Duplicate control fields: `findDuplicateJsonKey` scans the raw bytes
  for a key repeated in one object, because `JSON.parse` keeps the last
  of a repeated key and `{"verdict":"ACCEPT","verdict":"REVISE"}` would
  otherwise read as a clean single-verdict artifact. This is why
  `parseContractReview` takes text and not a parsed value.
- Terminal artifact failure: `src/orchestrator.ts:negotiateAttempt` loads
  the artifact after every evaluator invocation. A refusal returns
  `{ phase: "ERROR" }` with a new `review-artifact` failure cause naming
  the artifact and the defect. It is deliberately not an infrastructure
  cause, so it is not retried in-loop, and it does not spend a planner
  round: the contract stays `NEGOTIATING` and nothing advances.
- Marker parsing removed: `readEvaluatorVerdict` and
  `readEvaluatorFeedbackMetrics` are deleted from `src/artifacts.ts`, and
  `ESCALATE` leaves the verdict vocabulary with them.
  `RecordedContractVerdict` (`ACCEPT | REVISE | NONE`) replaces
  `EvaluatorVerdict`, where `NONE` means no review reached a verdict.
- Derived gap metrics: `contractReviewGapMetrics` counts blocking
  findings, and counts a reused finding `id` as a re-raised gap.
  `assessContractExtension` reads those instead of the evaluator's
  `GAPS:`/`RE_RAISED_GAPS:` self-counts.
- Findings route to the planner: `revisionNote` renders the review's
  findings with their clear-conditions into the next planner prompt.
  `stuck.md` renders the same findings instead of scraping a markdown
  section.
- Per-attempt archive: `artifacts.archiveContractReviewAttempt` copies
  the JSON artifact and its markdown companion to
  `.afk/artifacts/<run-slug>/slice-<NN>/reviews/` as
  `contract-review-r<round>-a<attempt>.json` and
  `feedback-r<round>-a<attempt>.md`. `invokeAgent` gained an
  `afterAttempt` hook that fires whether the attempt succeeded, died, or
  was cancelled, so a half-written artifact from a dead attempt is kept.
  The copy uses `errorOnExist` — later attempts cannot overwrite earlier
  ones.
- Freshness: both working artifacts are deleted before each evaluator
  attempt, so a stale review from an earlier attempt or round can never
  be read as this attempt's verdict.
- Prompt: `prompts/evaluator-contract.md` sheds the counts and the marker
  invariants, pins the JSON schema, requires a clear-condition per
  finding, requires stable finding IDs across rounds, and keeps the
  markdown companion explicitly unparsed. `agents/evaluator.md`'s stale
  Mode 1 section was updated to match.

## Decisions made during implementation

- **Severity is two-valued** (`BLOCKING`/`ADVISORY`). The issue says
  "severity" without a vocabulary, and "ACCEPT coexisting with a blocking
  finding" needs exactly one bit: whether a finding stands in the way of
  a lock. A richer scale would have to be mapped back to that bit
  anyway.
- **`behaviorIds` may be empty.** A finding about the contract as a whole
  — a missing non-goal, an infeasible scope — belongs to no behavior, and
  requiring one would make the evaluator invent an attribution.
- **A refused artifact is `ERROR`, not `ESCALATE`.** `ESCALATE` means the
  negotiation was judged and gave up; here nothing was judged. `ERROR`
  also means the next run retries the slice with a fresh evaluator, which
  is right: one evaluator's broken output is not evidence the contract is
  bad.
- **No `stuck.md` on a refused artifact.** `stuck.md` reports unresolved
  gaps to the operator; a refused artifact has none to report. The cause
  summary carries the artifact name into run state, the event stream, and
  `afk status`.
- **Re-raise detection is by finding `id`.** That is the machine-checkable
  replacement for the `RE_RAISED_GAPS:` self-count, and it is why the
  prompt now requires ID stability across rounds.
- **Gap count counts blocking findings only.** The round cap judges
  progress towards a lockable contract, and an advisory finding never
  stood in the way of a lock.

## Gotchas / learnings

- `JSON.parse` hides duplicate keys. Any "exactly one control field"
  rule over JSON needs a raw-text scan; a test that only checks the
  parsed object cannot fail. The parser test proves the defect is
  invisible after parsing before asserting the refusal.
- The duplicate-key scanner has to walk strings properly. A `":"` inside
  a finding's `evidence` would otherwise read as a key separator and get
  a valid artifact refused; there is a fixture for exactly that.
- The marker-absence criterion is not observable from any single run —
  "no other path to a verdict exists" is a claim about the source. It is
  pinned by a test that reads `orchestrator.ts`, `artifacts.ts`,
  `contract-review.ts`, and the prompt with comments stripped, so prose
  *about* the removed markers stays legal while a surviving regex does
  not.
- Type-strictness fixtures are one per conjunct, per the amendment.
  `behaviorIds: [1]` and `["a", 2]` are separate cases because the first
  exercises "the only element is a number" and the second "a later
  element is a number" — a check that looks at the first element only
  passes one and fails the other. The five required string fields are
  enumerated in the test, not summarized, and there is an assertion
  pinning that list itself.
- `src/test-support.ts` gained `writeContractReview`, and every fixture
  that drives a verdict goes through it. There were seven stub providers
  writing `VERDICT: ACCEPT` markers across four suites; a schema change
  now breaks in one place.
- Two `wave.test.ts` cases drove the "genuine verdict" negotiate failure
  with `contractVerdict: "ESCALATE"`. With `ESCALATE` gone they use
  `REVISE` against `maxContractRounds: 1`, which produces the same
  verdict-class ESCALATE outcome from a verdict that still exists.
- Line endings in this repo are mixed (`orchestrator.ts` is LF, most
  `*.test.ts` are CRLF). Scripted edits must normalize before matching
  and restore afterwards, or a multi-line pattern silently never matches.

## Status

Full `pnpm test` green in this worktree (see the handoff message for the
run). No regressions.
