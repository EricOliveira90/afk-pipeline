# Contract feedback — 03-audit-accounting

The contract locks. It is testable at seams that already exist, every declared
file is backed by explorer evidence, and the three unknowns the explorer left
open are each closed by a decision the contract states and defends rather than
deferred into the implementation.

## Why it is testable

Every behavior names a gate that can produce evidence for it, and the evidence
is concrete rather than aspirational.

The two new pure functions (B-01, B-02) are unit-testable in isolation and the
contract enumerates the six inputs and their expected kinds, including the one
case that decides the slice's shape: a `tool-call-cap` kill is an
`orchestrator-kill` and still is not infrastructure. That distinction is not
asserted as a rule to be trusted — it is asserted as a truth table with a false
row, mirroring `isInfrastructureCause` and citing the reason (an opted-in cap
tripping is the bound working; a verbatim retry re-hits it).

The retry bound (B-03) is bound by call counts on a dispatch spy, not by prose:
three calls for two rejections then a completion, exactly one call for every
degenerate budget. The degenerate-budget cases are the strongest part of the
pair — they pin the direction of the failure. An implementation that throws on
`-1`, or that reads absent as unbounded, fails a stated assertion. That matters
because ADR 0069's Consequences forbid this stage from blocking a run by its
own failure, and "reads as 0 rather than throwing" is the only reading of that
constraint that survives a bad flag value.

The reporting half is bound the same way. B-09 states the arithmetic
(`graded = unchanged + changed`, `AUDIT_NOT_RUN` excluded from the denominator,
the rate absent when `graded` is `0`) and B-10 states the rendered bytes
(`Changed rate: 25% (1 of 4 graded audits)`, `n/a` otherwise). The
zero-evidence path — no `events.jsonl` at all — returns zero totals instead of
throwing, which is the behavior `readQualityStageOutcomes` already establishes.

B-11 is the honest form of a never-gates obligation: it does not assert an
intention, it asserts absences a reader can check — `src/gate-runner.ts`
contains none of the three identifiers, `src/orchestrator.ts` contains no
`changedRatePercent`.

## Why the scope is evidence-backed

The schema change is the part that could have gone wrong, and it does not. The
explorer left open whether a `runId` on `PersistedSelfAuditOutcome` is a v8 bump
or an additive-within-v7 change. The contract chooses the unconditional bump and
gives the reason the version-history comment already gives for v6 and v7:
without it, a file whose entries predate provenance and a file whose entries
carry it are indistinguishable to every reader. Having chosen that, it then does
the work the choice implies instead of leaving it to be discovered — all three
stale literal readers of the constant are named with file and line, and each is
described as refreshed `7 → 8` with its surrounding assertions untouched, so the
two `qa-orchestration` files earn their place in scope for a stated mechanical
reason rather than appearing without justification.

The sanitizer's discard granularity is handled the same way. Requiring `runId`
nonblank means a pre-v8 `selfAudits` entry degrades its whole issue list to
absent — and the contract says so, quotes the helper's own doc comment for why
that granularity is right, and prices the consequence: at most one re-dispatched
audit on a run resumed across the upgrade. A contract that had quietly
introduced per-entry dropping here would have changed a rule the repository
deliberately set; this one pins the existing rule with an assertion placed
beside the existing blank-`candidateTreeId` case, so a per-entry rewrite fails.

The classifier's home is argued rather than assumed: `src/self-audit.ts` rather
than importing the hub's private `classifyNegotiateFailure`, because that would
be an import cycle, and because a situation-specific classifier over the same
provider messages is the established pattern (`classifyReviewFailure`, which the
hub's own comment cites as the same approach). The `dispatch`-injection seam
means every retry attempt logs under the existing callback, which is also what
keeps a declined audit from leaving an empty log behind (P-06).

The recorded-decision conflict is resolved in the same slice that creates it.
ADR 0069 currently says "no loop in the stage, no retry"; B-12 replaces that one
sentence in place, keeps `no second challenge`, and states the bound the ADR
actually means — the count is of *completed* invocations. The amendment is
justified by the parent specification requiring the retry, so the ADR is made
precise, not reversed. P-03 then holds the invariant that survives:
`AuditedTreeVerificationInput` still declares no `dispatch`, and no
`bumpEvalRound` sits between the stage call and QA, so neither the audit nor its
retries spend a generator round.

Non-goals are named where a reader would otherwise wonder. Provider-level exit
classification stays untouched, with the consequence stated rather than hidden:
under claude and codex a transient death classifies as `provider-exit`, which is
still infrastructure, so it still retries. That is the explorer's third unknown,
answered.

## What is worth tightening, none of it blocking

Four advisories, all narrow.

B-11's manifest wording says the `src/logger.ts` occurrences lie in the
derivation and the render "rather than a branch", dropping the contract's own
"outside the summary render" qualifier. B-10 requires a `Changed rate: n/a`
line, which is a branch. The contract text is the correct one; restating its
carve-out in the manifest would stop a literal reader from writing a test that
contradicts B-10.

B-03's case (c) asserts `Infinity` and a non-number read as `0`, but the Given
lists four inputs and the observable result counts four. `Infinity` is reachable
and worth a fifth input; a non-number cannot reach a typed `SelfAuditStageInput`
literal at all, so it is a defensive coercion rather than something the declared
gates observe.

B-12's ADR text test is placed in `src/logger.test.ts`. The file is in scope so
the evidence exists, but the assertion's subject is the self-audit stage's bound,
and the next reader of ADR 0069 will look in `src/self-audit.test.ts`.

Finally, the slice is at the top of what one session carries: fifteen files, a
classifier, a retry loop, a schema bump, an event, a derivation, a summary
section, an ADR and a term. It is feasible because every piece mirrors a cited
pattern and the bump's blast radius is fully enumerated rather than guessed —
but sequence the bump and its three pins first, since that is the only change
whose failure mode is a red heavy suite rather than a red unit test.
