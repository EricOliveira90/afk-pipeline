# Contract review feedback — round 1 (#335, recovery completion and replay)

The protocol shape you describe is right: one lock-protected `COMPLETED`
writer that rechecks the trailing `PENDING` event and the scope fingerprint,
a classifier that separates exact replay from conflict from a genuinely newer
lock, a fail-closed pre-dispatch reread, and no second rollback writer. B-02's
copy-forward list, the "writes none of the three `ROLLBACK_FAILED`-only
fields" clause, the unrelated-keys byte-equality obligation, and P-02/P-03's
pin on the transition table and `RUN_STATE_VERSION` are all anchored in the
evidence and are testable as stated. B-07 also binds both halves of the parser
regression surface for the widened payload union — the accepted round-trip and
the still-skipped torn line — in `src/logger.test.ts`, which is the
established harness for that reader. Those parts do not need rework.

Three things stop the lock.

**The lock-provenance stamp is not evidenced (F-01).** B-01 hangs the primary
completion refusal on a `**Lock-Provenance:** <text>` line in the replacement
`contract.md`, and attributes it to `LOCK_PROVENANCE_FIELD` at
`src/artifacts.ts:1539`. The evidence available to this review says the
opposite: the accepted-pair reader validates exactly one literal line,
`**Status:** LOCKED`, and no `lockProvenance` symbol or lock-provenance
module exists anywhere — the closest analogue is the provenance facts already
recorded on `PersistedRecoveryLineageEvent` (`sliceHead`, `featureHead`,
`scopeFingerprint`, the two fingerprints). Worse, the contract simultaneously
forbids importing the module it names as the format's owner, so the generator
would reimplement a byte format it cannot read and no cited fact pins, while
the test asserts the stamp matches "verbatim". Either cite the symbol, its
literal field text and the writer that puts it into a locked contract, or
restate the provenance requirement over the facts the evidence does support
and define `completion-pair-not-locked` solely by the reader returning
`undefined`.

**Two orchestrator seams are unlocated (F-02).** B-04 requires the
pre-dispatch check "once immediately before dispatching a generator", and
B-09 requires completion "at the one seam where that target's replacement pair
reaches `LOCKED`". The evidence flags the dispatch site as an explicit unknown
and names no LOCKED-transition seam at all; the only orchestrator anchors are
`reconcileRecoveryLineage` at L8515-8543 and the post-parse read of the flag
values at L8510. Both the implementation and B-04's "calls it exactly once"
assertion depend on those points being identified and singular, and neither
is. Name the function or line range for each — or say plainly that dispatch
happens at more than one site and how each is covered.

**The slice is too large for one session (F-03).** Nineteen files, nine
behaviors and five preservation anchors carry four independent bodies of work:
the new recovery seams plus the new persisted field; the additive event
variant and its regression pair; the snapshot fold field and a new `afk
status` block; and removal of the CLI refusal with the whole recovery request
path wired through `runPipeline` and three entry points, plus an end-to-end
drive through the resume/negotiation fixture. Two of those four also sit on
the unlocated seams above. Moving the reporting surface (B-06 through B-08) or
the CLI and orchestrator wiring (B-09) to a named follow-up, and narrowing the
file scope and manifest to match, would make the remainder deliverable and
verifiable in one pass.

Three smaller notes, worth fixing while you are in the file but not blocking
on their own: the fold's invocation shape (once per whole log versus
incrementally) is unknown, and B-08's dual derivation assumes the former;
three behaviors compare pair fingerprints without naming where those
fingerprints come from, and B-01 pins them to plain SHA-256 of the two files
on no cited fact; and B-09's observable includes an unbounded repository-wide
search for "a refusal string naming an unshipped slice", which will collide
with legitimate comments that reference unshipped issues — bound it to named
files and a named pattern.
