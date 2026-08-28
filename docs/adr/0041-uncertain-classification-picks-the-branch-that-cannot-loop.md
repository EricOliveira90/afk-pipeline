# When classification is uncertain, choose the branch that cannot loop

Applies ADR 0036 (the retry anti-pattern) to the base gate's `prepare`
step, and refines ADR 0025's ownership question. Issue #120.

## What happened

Run 5 (PRD 1, `run-20260827-1442*`), slice #79. The generator finished
round 1 and committed 8 commits. The base gate then failed in
environment preparation:

```
"detail": "Gate environment preparation failed: pnpm install --frozen-lockfile (EXITED, exit 2)"
```

That detail appears three times in the run's gate evidence — the original
attempt and both infrastructure retries, byte-identical because the tree
was byte-identical. The slice ended `ERROR` with **two of its three
generator rounds unused**. No `tests` gate ran; no QA, no pre-ship gate,
no review, no PR.

The actual defect was the candidate's own: it emitted a warn reason from
three call sites in `src/orchestrator.ts` without adding it to the union
in `src/run-events.ts`, three `TS2820`s. This repo's `prepare` script
runs `tsc -p tsconfig.build.json`, and `prepare` is a pnpm lifecycle
script, so `pnpm install --frozen-lockfile` compiles the candidate. A
candidate that does not compile fails *environment preparation*, before
the `typecheck` gate that exists to catch exactly this.

Cost of the misclassification: a one-line type error consumed a
~100-minute generator round, both infrastructure retries, and the slice's
two remaining rounds. It was also silent about the cause — the operator
saw "Base gate infrastructure failed", which points at the machine.

## The rule

The classifier had a whitelist: `ERR_PNPM_OUTDATED_LOCKFILE` was the
candidate's fault, **everything else** was INFRASTRUCTURE. Its own
comment named the reason the whitelist existed — an identical retry
against an identical tree can never succeed — and then defaulted the
unknown case into precisely that trap. The whitelist answered "is this a
failure I have seen the candidate cause?" when the question that decides
whether a retry is even coherent is "could running this again plausibly
produce a different result?".

So, as a general rule for every classifier in this pipeline:

> **When it is uncertain who owns a failure, choose the branch that
> cannot loop.**

The two errors are not symmetric, and the asymmetry is measured:

- **Wrong FAIL/CONFIGURATION** (blaming the candidate for the
  environment) costs *at most one recoverable round*. The generator gets
  a failure detail, cannot reproduce it, and the round ends; rounds
  remain, and the pipeline still moves.
- **Wrong INFRASTRUCTURE** (blaming the environment for the candidate)
  burns both retries on identical work and then ends the slice. Nothing
  downstream runs. This is the ADR 0036 anti-pattern reached by
  classification rather than by retry policy, and #120 is the measured
  instance.

A wrong blame is recoverable because an actor exists who can act. A wrong
retry is not, because no actor is asked to change anything.

## Decision, in the narrow form

`src/gate-runner.ts` records a `prepare` failure as the candidate's
(FAIL/CONFIGURATION against every declaration, routed to the generator)
in two cases:

1. `ERR_PNPM_OUTDATED_LOCKFILE` in the output — unchanged.
2. **`EXITED` with a non-zero exit code other than 1** — new.

Everything else, including every non-`EXITED` outcome (spawn error,
inactivity and wall-clock timeouts, a signal kill that leaves no exit
code), stays INFRASTRUCTURE and the orchestrator's retry applies.

Rule 2 is keyed on the exit code, not on message text, because pnpm draws
the line there itself. pnpm reports what *it* did by printing an
`ERR_PNPM_*` code and exiting 1; it reports a failing *lifecycle script*
by propagating that script's own exit code. Measured 2026-08-28 against
the pnpm on this machine:

| Failure | Report | Exit |
|---|---|---|
| `prepare` script exits 3 | `ELIFECYCLE Command failed with exit code 3.` | **3** |
| Refused registry | `ERR_PNPM_META_FETCH_FAIL` | 1 |
| Lockfile drift under `--frozen-lockfile` | `ERR_PNPM_OUTDATED_LOCKFILE` | 1 |

And the incident itself: `tsc` exits 2 when it emits with errors, and the
install exited 2. Everything that fails *before* lifecycle scripts run —
fetch, network, registry, unresolvable versions — is pnpm's own error and
exits 1, so this rule cannot convert a transient network fault into blame.

Keying on the code rather than the wording also means the rule does not
have to be maintained against a package manager's message strings, which
is what made the one-marker whitelist so narrow in the first place.

The failure detail now carries the prepare output tail for both cases, so
the round asked to fix a compile error can read the compiler errors
(`outputTail`, already used for the lockfile case).

Scope: the base gate's `prepare` is always `pnpm install
--frozen-lockfile`, and `resolveSanityPlan` only emits it for a project
with a checked-in `pnpm-lock.yaml`. The exit-code premise is pnpm's, and
that is the only package manager this step ever runs.

## The alternative that was rejected

Issue #120 suggested inverting the test: a prepare failure is the
candidate's fault *unless* it matches a known environment signature
(`pnpm` absent, network, registry, timeout, checkpoint I/O). The
2026-08-28 plan debate rejected it, and this ADR keeps that rejection.

Inversion makes the environment signature list the thing that must be
complete, and it never is. Every fault not yet in the list becomes a
generator round spent trying to fix a registry outage — which converts
the most common real environment fault, a transient network failure, into
a burned round, and does so on exactly the failures nobody has enumerated
yet. The rule above ("choose the branch that cannot loop") does not say
"always blame the candidate"; it says break the tie that way *when the
branch would otherwise loop on identical work*. A network fault does not
loop on identical work — a retry is coherent there, which is why
INFRASTRUCTURE stays the default for the unknown case.

The narrow form gets the measured incident class, keeps the default that
handles the frequent case correctly, and gives up only the residual
below.

## What this does not fix

- **A lifecycle script that itself exits 1** is indistinguishable from a
  pnpm error by exit code alone, and stays INFRASTRUCTURE — i.e. #120's
  full behaviour for that subset. It did not fire here (`tsc` emitting
  with errors exits 2) and it will not fire for the common shapes of a
  `prepare` that compiles, but a project whose `prepare` runs a tool that
  exits 1 (a linter, or `tsc` under `noEmitOnError`) still gets the old
  outcome. **Re-open trigger:** one observed run where a prepare
  lifecycle script exits 1 and consumes infrastructure retries. At that
  point the honest fix is not inversion but for the pipeline to tell the
  two apart structurally — run the install and the candidate's lifecycle
  scripts as separate steps, so the step that failed identifies the owner.
- **The generator can still reach the base gate without compiling.**
  `vitest` strips types without checking them, so a `--test-command`
  without `pnpm typecheck` lets a round go green over code that does not
  compile; #79's did. Classification decides who is asked to fix that,
  not whether it happens. That gap is #120's second half and is separate
  work.
