# `afk adopt` discovers the provider-qualified run, and names its refusals

Extends ADR 0002 (branch and state namespacing is keyed off the provider
name) to the adoption bypass valve shipped by PRD 2 slice 06 (#129).
Evidence: the PRD 2 product guardian review, round 2, blocking finding 2 —
the PM ran the command against this very run and it refused. Also records
the operator-visible refusals the round-1 fixes introduced, which the same
review called defensible but undocumented.

## What happened

`pipelineRunSlug` stores a non-kiro run's state under
`<prd-slug>-<provider>` and names its feature branch
`feat-<provider>/<prd-slug>`. Every other caller of `loadRunState` and
`saveSliceState` passes that run slug. Adoption passed the PRD slug the
operator typed.

`loadRunState` on a missing file returns a fresh record defaulting to
`feat/<prd-slug>`, so the failure was not a missing-file error but a
plausible-looking one further downstream. Against the PRD 2 run itself:

```
Adoption refused: Feature branch not found: feat/afk-v2-routing-adjudication
```

The real state was `afk-v2-routing-adjudication-codex.json`, with feature
branch `feat-codex/afk-v2-routing-adjudication`. So the bypass valve was
unusable for exactly the runs most likely to need it — the Codex and Claude
backends AFK actually self-runs on — and had it somehow reached the state
write, it would have recorded provenance in a file no pipeline reads.

## Decision

**Adoption discovers the run rather than assuming it.** `.afk/state` is
matched the way `afk stop` matches log directories (`logSlugMatches`): a
candidate is the PRD slug itself, or the slug plus a suffix. The run slug
that comes out keys the state read, the state write, and the adoption
evidence directory under `.afk/logs/<run-slug>/adoptions/`.

**One candidate is the answer; anything else is a named refusal.**

- Several candidates — two providers ran the same PRD — refuses, lists them,
  and asks for `--provider <name>`. Guessing would move the wrong feature
  branch, and the two are not interchangeable.
- No candidate refuses too. Adoption moves an *existing* run's feature
  branch; inventing `feat/<prd-slug>` for a run that never happened only
  defers the failure to a worse place, which is precisely the bug above.

**`--provider <name>` names the run outright**, resolved through the same
rule that builds the slug in the first place (`runSlugForProviderName`, which
`pipelineRunSlug` now delegates to, so the two cannot drift).

The prefix match can also catch a PRD slug that starts with this one — the
caveat `afk stop` already carries. Here it surfaces as the ambiguity
refusal, which names every candidate, rather than as a silent wrong pick.

## Operator-visible refusals

The whole set, in the order adoption checks them. All of these happen before
the candidate merge exists, so no ref and no state file is touched:

1. **No adopter identity.** Pass `--adopter` or configure `git user.name`.
2. **Unreadable or missing `.kiro/specs/<prd-slug>/issues.md`.** Adoption
   writes state under the GitHub issue ID the pipeline is keyed on, and the
   slice table is the only place the `<slice>` → issue mapping lives. This is
   the file the pipeline already needs to run at all.
3. **A `<slice>` the slice table does not declare, or declares twice.**
4. **No run state, or more than one, for the PRD slug** — this ADR.
5. **The feature branch is checked out in a registered worktree.** Adoption
   advances a ref, and a ref is half of a checked-out branch's identity:
   moving it behind a worktree leaves that worktree's index and files at the
   old tree while `git status` reports the whole difference as staged work
   (ADR 0010). The PRD does not specify what a successful adoption should do
   to such a worktree, so adoption refuses and names the paths rather than
   updating a tree it half-understands. Check out another branch there and
   run adopt again.

Later refusals — a merge conflict, a failing base gate, a branch that moved
during verification, a candidate worktree that survived teardown — are
reported with the same `Adoption refused:` prefix and leave both refs and
the state file unchanged.

## Consequences

- `afk adopt` is only mounted on the `afk` entry point. That stays true:
  the subcommand now selects the run explicitly, so `afk adopt demo 06
  --provider codex` is the canonical way to adopt into a Codex run and no
  `afk-codex adopt` is needed.
- `listRunStateSlugs` in `src/run-state.ts` is the shared enumeration. It
  returns run slugs, not PRD slugs — the distinction the original defect
  blurred.
- Adoption evidence moved from `.afk/logs/<prd-slug>/adoptions/` to
  `.afk/logs/<run-slug>/adoptions/`. For a kiro run those are the same path.
- Still incomplete, deliberately: if both the state write *and* the reverse
  CAS fail, adoption leaves merged code with no state recording it. The
  refusal says so and names both commits, which makes it repairable by hand
  but not mechanically. A durable intent record would close it; tracked as a
  follow-up rather than fixed here.
