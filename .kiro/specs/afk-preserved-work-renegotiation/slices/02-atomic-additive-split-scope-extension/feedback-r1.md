# Contract feedback — round 1

## What is already solid

Most of this contract does the hard part well. The scope lock names one seam per
obligation and each one lands on evidence the explorer actually recorded: the
`extensions` placeholder and its `--extend-scope` comment, the literal `[]`
every writer emits today, the single `transactRunState` body and its scope
fingerprint recheck, the narrow-only invariant in `resolveRunScope` that forces
additions to arrive through the completion write rather than through normal
scope resolution, and the ADR 0065 non-reuse precedent for identity resolution.

Two judgment calls deserve credit for being recorded rather than assumed. The
`RUN_STATE_VERSION` argument — that widening `extensions` from `string[]` to a
pair array is compatible for every reachable v7 document because no writer has
ever emitted a non-empty array — is the right shape of reasoning and it cites
the comment that authorizes it. And B-10 choosing a derivation over a second
persisted provenance field, on the grounds that a duplicated fact can disagree
with the original, resolves something the PRD left silent without inventing
schema.

The explorer's one live unknown about ownership — whether the "refused until
#335 lands" throw belongs to this slice — is settled cleanly: P-01 preserves the
throw, the non-goal names #336 as its owner, and B-01 keeps the accepted case
observable on the exported parser so the still-live guard does not hide it. The
`src/scope-amendment.ts` name-collision non-goal is a genuinely useful piece of
hygiene.

The design also keeps its own test cost down in a way this repo cares about.
Passing `issues.md` slices and the manifest in as arguments means the resolver
and the locked revalidation are exercisable without a fixture repo, and no new
spawned pipeline scenario is required. Ten behaviors is a lot, but the
production surface behind them is small and mechanical, and B-03 and B-06 are
assertions over existing paths rather than new code — one session is realistic.

## What must change

**The replay path and the resolver disagree about a completed attempt.**
This is the one blocker, and it is a sequencing hole rather than a wrong
decision. B-08 appends the completed set to `state.scope.slices`. B-02 refuses
any member already present in persisted scope. B-03 runs that resolver before
admission publishes anything or takes the lock. Put those three together and
repeating a completed request cannot reach `replayOutcome` at all: the exact
replay of `{2,3}` is refused because 2 and 3 are now in scope, and the
overlapping cases `{2}`, `{2,3,4}` and `{2,4}` are refused on their in-scope
members. Every case B-09 declares — the no-op and all four conflicts — is
unreachable through the admission path as the contract currently describes it.

The fix is to say which check runs first, or what scope view the resolver sees
when the request matches a completed attempt. Either answer is defensible; the
contract just cannot leave it unstated, because the whole of B-09 depends on it
and a generator would otherwise have to invent the ordering and could easily
pick the one that makes its own B-09 tests unwritable.

## Smaller things worth tightening

The selector language for GitHub-issue selectors is left implicit. B-01 binds
the parser to digits-only parts, borrowing the `parseSliceIdList` rule, while
B-02 declares a refusal for "one selector matching one slice by number and
another by issue id" — which only makes sense if an issue-id selector can get
through the parser. That is consistent if `ghIssue` values are bare numerics,
but the contract never says so, and the explorer explicitly flagged
`parseSliceIdList` as numeric-only and therefore a precedent rather than a
reuse. One sentence naming the accepted issue-id spelling, plus one newly
accepted issue-id selector in the test plan, closes it.

B-08's atomicity evidence is slightly oversold. An interleave at
`beforeLockAcquired` fires before the transaction starts, so it can show that
nothing was written early but cannot witness a half-published document. The
real evidence for atomicity is already declared — one `changed: true`
transaction and one reloaded document holding both halves — so either name a
seam inside the transaction body or restate the obligation (and its
definition-of-done line) as what the declared observation actually proves.

Finally, the gates and the definition of done set different bars: every
behavior declares the full-suite `tests` gate, while the last checkbox asks only
for `typecheck` plus the test files in this slice's file scope. The catalog's
per-behavior gate, which is the one that produces behavior-scoped evidence, goes
unused. Pick one story — either declare the per-behavior gate on the behavior
rows, or make the closing checkbox match the gate the manifest binds.
