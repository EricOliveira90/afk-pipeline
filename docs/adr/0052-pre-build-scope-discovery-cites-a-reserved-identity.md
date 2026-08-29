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
- The section is byte-identical across `agents/generator.md`,
  `prompts/generator.md`, `prompts/generator-resume.md` and
  `prompts/generator-resume-stuck.md`, which
  `prompt-template.test.ts` already enforces ("gives every generator
  invocation the canonical scope-escalation contract"). So the branch is
  written in terms the four share — *were findings cited to you?* — rather
  than naming `RETRY_NOTE` or `UNRESOLVED_FINDINGS`, and a resumed
  generator that arrives with neither findings nor a diagnosis gets the
  same legal identity as an initial one.
- Nothing validates that a generator citing `PRE-BUILD-SCOPE` really had no
  findings, or that a cited ID names a real finding — the parser has never
  seen the finding set and cannot. The check that exists is the exclusivity
  rule; the rest is prompt discipline, the same as for cited IDs today.
