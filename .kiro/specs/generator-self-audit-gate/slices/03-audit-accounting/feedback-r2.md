# Contract review — round 2 feedback

Slice: `generator-self-audit-gate` / `03-audit-accounting` (GH #301)

All three findings routed into this round are resolved. The revision is
accepted; nothing new was introduced by the changed regions.

## F-08 — the degenerate-budget clause (B-03)

Round 1 held that B-03's contract text made "a value that is not a non-negative
safe integer reads as `0` rather than throwing" a load-bearing safety rule while
no declared observable could fail on it: the `given` supplied only
`infrastructureRetries: 2`, and every other budget in the pair pinned a valid
number.

The revision closes it on all three surfaces the clear-condition named. B-03's
`given` now carries a case (c) group — one input omitting `infrastructureRetries`
entirely, plus `-1`, `1.5` and `Number.NaN` — each with a dispatch that always
rejects, which is the shape that distinguishes "reads as 0" from "retries
anyway". The `observableResult` declares, per case (c) input, a dispatch count of
exactly one, no rejection, no `self-audit: infrastructure retry` line, and the
result `{ ran: true, verdict: "AUDIT_NOT_RUN", treeId: <released tree id> }`. The
test plan carries the matching bullet, and the contract statement enumerates the
rejected value classes and says what each does instead of throwing, with the ADR
0069 Consequences citation behind the "may never block a run by its own failure"
reasoning.

The two failure modes round 1 named — throwing on `-1` or `NaN`, and treating
`undefined` as unbounded retry — now each fail a declared assertion. The `then`
also names `Infinity` and a non-number among the rejected classes without a
dedicated case (c) input; that is not worth another round, since any
implementation that satisfies the four declared inputs (a `Number.isSafeInteger`
or equivalent guard) necessarily handles both, and a non-number cannot reach a
`infrastructureRetries?: number` field through the typecheck gate.

## F-09 — sanitizer discard granularity (B-06)

The advisory asked for the granularity to be *read out of the source* rather than
asserted, or for an authorizing bullet under `## Changes to existing behavior`.
The revision reads it out, and the citations check out against
`src/run-state.ts`: the malformed-entry condition at `:1062-1069` sets
`dropped = true` and `break`s; `if (dropped || entries.length === 0) continue;`
at `:1078` then omits that `ghIssue` key from the returned record; and the doc
comment at `:1032-1034` states the rule in the terms the contract quotes.

So the granularity is already whole-issue-list, the new `runId` check joins an
existing condition rather than introducing a rule, no discard behavior changes
for the pre-existing `candidateTreeId`, `verdict` or `auditedTreeId` checks, and
correctly no `## Changes to existing behavior` bullet was added. The manifest
also pins the `runId`-less case alongside the existing blank-`candidateTreeId`
case, which is what makes a per-entry rewrite of the sanitizer visible as a test
failure rather than a silent semantics change.

## F-10 — a decidable literal absence (B-12)

"No longer carries the unqualified phrase `no retry`" is replaced by a property a
text scan can decide: with the ADR whitespace-normalized, the one sentence at
`:52-53` must no longer appear as a substring, having been replaced whole. That
literal matches the ADR's present text exactly once the line break inside it is
normalized, so the assertion can fail on an unamended file. The retained-text
side is now the substring `no second challenge` rather than a paraphrase, so the
amendment B-12 actually asks for — a bound that counts *completed* invocations,
with infrastructure retry named — passes its own gate instead of tripping it. The
contract statement and the test-plan bullet were brought to the same literal, and
the bullet no longer mentions the bare phrase.

## Notes carried forward, not findings

- B-12's prose test is now declared in `src/logger.test.ts` rather than
  `src/self-audit.test.ts`'s ADR 0069 suite. Both files are in scope and both are
  established homes for text scans, so this is a placement choice for the
  implementer, not a gap.
- B-03's `then` describes the retry line as
  `self-audit: infrastructure retry N/M — <cause summary>` while the
  `observableResult` pins only the `1/2` and `2/2` fragments. That is a
  deliberately looser assertion over operator prose and is fine as declared.
- The `fileScope` entry for `CONTEXT.md` is spelled `context.md`. Manifest paths
  are case-insensitive comparison keys, so this changes nothing and is not a
  finding.
