# Pre-build scope discovery cites a reserved identity

Closes the half of PRD 2's problem statement that slice 01 (#80) did not
ship. Evidence: the PRD 2 product guardian review, round 2, blocking
finding 1. Operator decision recorded 2026-08-29.

## What happened

The PRD exists to kill a specific deadlock: a generator that knows,
**before building**, that the correct implementation needs a file path the
locked contract does not declare, and has no structured way to say so.
Stories 1 and 2 name it directly.

What shipped was the QA-driven half only.

- `prompts/generator.md` authorized escalation only when *a cited finding's*
  correct fix requires an undeclared path, and told the generator to put the
  cited finding IDs in `findingIds`.
- `parseScopeEscalation` refuses an artifact whose `findingIds` has no
  non-blank entry — the fail-closed check story 13 asks for.
- `runSliceExecute`'s initial-generator prompt supplies no findings at all.
  Round 1 attempt 1 has an empty `RETRY_NOTE` by construction: there is no
  QA report, no base-gate failure and no contract-review finding yet.

So the first generator of a slice's life had no finding ID it could
honestly cite, and therefore no way to emit a schema-valid escalation. It
could stop and fail, or it could edit outside the declared scope. The
deadlock the PRD was written to remove was still reachable — reachable
only on the path the PRD's own problem statement describes.

## Decision

**Define a reserved `findingIds` identity for a pre-build scope
discovery: `PRE-BUILD-SCOPE`.**

An initial generator that discovers the locked file scope is too narrow
before it has any finding to cite writes an otherwise ordinary escalation
citing that one identity. Everything downstream — archiving, validation,
the focused revision, the resumed round — is unchanged, because the
artifact's *shape* is unchanged.

**`findingIds` stays mandatory and an empty list stays a refusal.** The
rejected alternative was relaxing the schema to allow `findingIds: []`.
It was turned down twice over: it trades away the fail-closed validation
story 13 asks for, and PRD 3's context-envelope work would inherit the
looser shape and carry it further.

**The reserved identity may not be mixed with real finding IDs.**
`parseScopeEscalation` refuses `["PRE-BUILD-SCOPE", "QA-03"]`. An
escalation is either a pre-build discovery or a cited-finding fix;
claiming both describes no single event, and accepting the mixture would
let a QA-driven generator launder an uncited path in beside a cited one.

**The prompt decides which identity applies, from what the invocation was
given.** `prompts/generator.md` now says: if a retry note above cites
findings, cite the ones whose fix needs the paths; if nothing was cited to
you, use `PRE-BUILD-SCOPE` alone. That is a fact the generator can read off
its own prompt, not a judgement call.

## Consequences

- `PRE_BUILD_SCOPE_FINDING_ID` in `src/escalation.ts` is the single place
  the string lives; the prompt spells it out literally, as prompts must.
- `PRE-BUILD-SCOPE` is now vocabulary for this PRD, enforced across its
  tickets by `pnpm lint:tickets` (ADR 0049).
- A generator can reach a focused revision without a finding, so a round-1
  slice can spend two revisions before writing anything (ADR 0050's
  allowance is per round, not per phase). That is the intended trade: the
  alternative is the deadlock.
- The section is byte-identical across every generator source —
  `agents/generator.md`, `prompts/generator.md` and
  `prompts/generator-resume.md` — which `prompt-template.test.ts` already
  enforces ("gives every generator invocation the canonical
  scope-escalation contract"). So the branch is written in terms they all
  share — *were findings cited to you?* — rather than naming `RETRY_NOTE`
  or `UNRESOLVED_FINDINGS`, and a resumed generator that arrives with
  neither findings nor a diagnosis gets the same legal identity as an
  initial one. `prompts/generator-resume-stuck.md` carried it too until
  slice 04 (#82) retired the stuck variants; the test's source list is the
  thing to keep in step, not this list.
- Nothing validates that a generator citing `PRE-BUILD-SCOPE` really had no
  findings, or that a cited ID names a real finding — the parser has never
  seen the finding set and cannot. The check that exists is the exclusivity
  rule; the rest is prompt discipline, the same as for cited IDs today.

## Amendment — the grant is only for an edit that has not happened yet

Fifth adjudication gate round, architect blocker 1. Operator-authorized fix
round recorded 2026-08-31.

The route above is defined as a **pre-build** discovery, and both generator
prompts say so in those words: *stop before making the undeclared edit*.
Nothing checked it. `runSliceExecute` archived `escalation.md`, validated it
against the locked manifest, checked the two-revision bound and went straight
into `runFocusedScopeRevision` — it never compared the worktree against the
scope it was about to widen. So a generator could edit an undeclared path,
name that path in a perfectly valid escalation, and have the focused revision
declare it *after the fact*. The control artifact laundered the boundary
violation it exists to prevent, and the edit then reached the gates as though
it had been made under the revised lock (ADR 0008/0048: the locked contract is
the orchestrator's, and the generator owns no part of the file list).

**Before granting a focused revision, the full changed set of the worktree is
compared against the currently locked scope, and any out-of-scope change
refuses the grant.** `outOfScopeChangedPaths` in `src/escalation.ts` decides
it; the caller is the grant site in `runSliceExecute`.

Four things about the shape, each of which was a way to get it wrong:

- **The full changed set, not the requested paths.** Checking only
  `escalation.paths` leaves the laundering intact one step removed: edit
  undeclared `X`, escalate for unrelated `Y`, keep `X`. The question the grant
  has to answer is whether the tree is still inside its lock.
- **Exempt the slice artifact directory by directory prefix.** The slice's own
  artifacts are written into the worktree by the pipeline and the agents as a
  matter of course, `escalation.md` above all — it is the file that triggers
  the check. The exemption is deliberately *not* built from
  `artifacts.sliceArtifactNames()`: that list omits `escalation.md`,
  `acceptance-manifest.json` and both adjudication files, so a filename-list
  exemption would refuse every honest escalation on its own escalation
  artifact.
- **Exempt migration files.** `fileScope` forbids placeholders and globs and a
  migration's exact filename is chosen at build time, so a migration can never
  be a declared path — `planScopeAmendment` refuses migration paths for that
  same reason. The reserved-prefix claim gate
  (`checkClaimedGeneratedMigrations`, ADR 0028/0034) governs them, on this same
  tree, before QA.
- **Placement and refusal shape.** After the archive call, so the raw
  escalation evidence survives the refusal, and before the revision, so the
  contract is never reopened. It refuses by `throw` — surfacing as `ERROR`,
  like the two-revision bound beside it — names the offending paths, and
  reverts nothing: the tree is the operator's to inspect.

### The two scope doors are asymmetric on purpose

`planScopeAmendment` (the QA amendment door, #112) **requires** the requested
path to be already changed. This door **forbids** any undeclared change at all.
A future reviewer will read that as a contradiction and try to "fix" one of
them. It is not:

- The amendment's warrant is an **independent evaluator finding**, which a
  generator cannot forge. "The work is already there" is then evidence that the
  work was judged correct and only the bookkeeping is wrong — and refusing a
  path with no work in it would declare a file the slice never wrote (ADR 0048:
  a QA finding names its remedy, and this remedy is the orchestrator's).
- The escalation's warrant is **written by the generator itself**. "The work is
  already there" is therefore evidence of nothing, and is precisely the state
  this route exists to prevent.

Same word, "changed", opposite polarity, because the two doors are guarded by
warrants of different trustworthiness. Neither should be made to match the
other.

### Absence is proved, not inferred — here too

The check reads the changed set from `git.listChangedFiles`, which used to
swallow each of its three git commands' failures and return the partial union.
A swallowed failure would have read as "no out-of-scope changes" and **granted**
the revision. It now returns a `ChangedFilesProbe` that distinguishes failure
from empty, and both callers fail closed in their own direction: this door
refuses the grant, and the QA amendment door refuses the amendment rather than
blaming the evaluator for a path git could not confirm. That is the same
decision as the estate probe's tri-state (ADR 0055 Seam 2 §8) — one honest
primitive, every caller refusing by name.
