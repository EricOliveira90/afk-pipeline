# Contract review — round 2

## Recovery completion and replay (#335)

The revision resolves both findings routed to the planner. The contract is
implementable as written; one advisory remains about where an injected argument
lives, and it does not block the slice.

## F-07 — the completion-CAS-lost failure path — resolved

Round 1 refused the contract because B-03 collapsed two different failures into
one delegation. It sent every "recheck lost" ending to `rollBackRecoveryAttempt`
and then asserted, as a gated observable, that the writer had appended a
`ROLLED_BACK` or `ROLLBACK_FAILED` event — but that writer takes no `attemptId`.
It reloads state and acts on whatever `rollbackableEvent` returns, so for the
half of the given where the trailing event had *changed* the mandated observable
was unreachable, and the reachable version of it was a write against an attempt
completion never admitted.

The revision splits the surface into three shapes and states each over what the
unedited writer actually does:

- a precondition refusal (invalid pair, refusing gate, blank provenance), which
  delegates only after a read has found this attempt still the trailing
  `PENDING` event;
- a locked recheck lost *only* to scope-fingerprint drift with this attempt
  still trailing — now the single `completion-cas-lost` path;
- a trailing event that is no longer this attempt's `PENDING` event, which
  appends nothing, restores nothing, calls no rollback, and refuses with
  `facts-changed-before-lock`.

That third shape is the one that had to change, and it now carries its own
reasoning inline: delegating it is exactly what would let a completion roll back
an attempt it never admitted, because after a `ROLLED_BACK` event
`hasOpenRecoveryAttempt` is false and a fresh `PENDING` attempt can be trailing.
Both cited codes check out against the module — `facts-changed-before-lock`
exists at `src/preserve-work-recovery.ts:133-134` and is the same code the
writer's own recheck returns at `:1419`, and `RecoveryFailureTrigger`
(`:1255-1260`) already carries `deterministic-validation-refusal` and
`lock-gate-refusal`, so `completion-cas-lost` is genuinely the only addition the
contract claims.

P-02 was tightened from the other side: it now pins the writer's signature ("it
gains no `attemptId` parameter and no new recheck") and names the write-nothing
refusal as the consequence, so the forbidden alternative is closed rather than
merely unmentioned.

The test plan follows. Fingerprint drift and changed-trailing-event are separate
bullets now, and the second one asserts what a write-nothing path should assert:
an event-for-event unchanged lineage, byte-identical pair files, and that the
second attempt's snapshot is neither restored nor given an event.

One residual is worth naming because the contract names it first: the window
between completion's unlocked read and the writer's own load stays open, and a
sufficiently unlucky interleave there still lands the writer on a different
attempt. The contract states this, attributes it to #333's behavior under P-02,
and gates no observable on it. Closing it would require the writer edit P-02
forbids, so it is correctly out of this slice.

## F-08 — what B-01's refusal forbids — resolved

"Refuses before any write" is gone. B-01 now names the write it forbids — the
`COMPLETED` append and the run-state document that would carry it — and settles
the reading the finding said was loose: a precondition refusal is terminal, not
retryable, and the attempt is ended through the rollback writer rather than left
`PENDING`. The "of its own" carve-out reads cleanly because the same sentence
attributes the document that *is* written to #333.

The gate moved with the prose, which is what makes this closed rather than
merely better worded. Manifest B-01 previously asserted only the refusal code
per precondition, so the retryable reading passed too. It now also asserts that
no `COMPLETED` event exists anywhere in the lineage and that the trailing event
afterwards is the `ROLLED_BACK` event appended for the same `attemptId` — so the
reading the finding objected to now fails the gate.

## F-09 — where `lockGate` is injected — advisory

Contract B-01 defines the gate as a required `lockGate: (contractPath: string)
=> string | null` argument and cites `RecoveryGitProbes` as the *pattern*.
Manifest B-01's `then` says the gate and provenance stamp are injected "on the
module's existing `RecoveryGitProbes` seam (`:279-298`)", which reads as the
interface itself.

That interface is a closed three-member git-predicate type with a
`DEFAULT_RECOVERY_GIT_PROBES` constant (`src/preserve-work-recovery.ts:288-298`),
consumed as `probes?: RecoveryGitProbes` by eligibility (`:379`) and admission
(`:611`), and its doc comment earns its shape from being exactly the git surface
eligibility may reach. Adding a `lockGate` member would change that constant and
both consumers' option shape — surfaces P-03 preserves — and would blunt the
type-level claim the interface exists to make.

This is advisory, not blocking, because the manifest's own `given` already pins
the settled reading ("a `completeRecoveryAttempt(args)` call whose ... required
`lockGate: (contractPath: string) => string | null`"). A generator can recover
the args-level placement from the pair without guessing; only the `then`'s
phrasing points the other way. Saying in that `then` that the gate and
provenance are arguments following the `RecoveryGitProbes` pattern, and that the
interface and its default constant gain no member, would remove the last way to
read it wrong.
