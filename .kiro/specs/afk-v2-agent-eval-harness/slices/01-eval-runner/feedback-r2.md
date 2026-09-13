# Contract feedback — round 2 (eval runner, #262)

Both round-1 findings are answered. One thing the answer to F-07 introduced has
to change before the pair is implementable.

## F-06 — the B-27 scanned set (resolved)

The behavior no longer hands the implementer an exclusion list to interpret. It
declares a pattern: every `src/*.ts` whose name matches neither `*.test.ts` nor
`*.fixtures.ts`, minus the four `src/eval-*.ts` modules and the three CLI
entries. `src/eval.fixtures.ts` is therefore outside the set by the same rule
that keeps `src/orchestrator.fixtures.ts` outside it, not by an eighth
hand-added exception — and the contract says so explicitly ("the `*.fixtures.ts`
pattern is the whole exclusion and no per-file exception is added on top of
it"), which closes the door the round-1 finding was worried about.

The manifest entry now asserts over that same set rather than over a vaguer
"every non-test file": the offender list deep-equals `[]`, the set is asserted
non-empty and asserted to contain the eight production hubs, and
`src/eval.fixtures.ts` is asserted to be a non-member. That last assertion is
what makes the gate's evidence evidence for the declared rule — a generator that
drifted into scanning fixture modules would fail the membership assertion rather
than silently pass a different rule.

Widening the exclusion from one named file to the whole `*.fixtures.ts` pattern
does not loosen the boundary this slice exists to defend. Fixture modules are
test support; the hubs whose independence matters — `orchestrator`, `wave`,
`ship-gate`, `preship`, `gate-runner`, `base-gates`, `candidate-gate-phase`,
`post-qa-gates` — are all inside the asserted set, by name.

## F-07 — where the refusing packs live (resolved)

The scope lock now says it outright: the ~14 refusing packs of B-02–B-07 are
each built in a per-test `mkdtemp` directory and none is committed, and
`eval-packs/fixtures/refused/01-unknown-member.json` is the only committed pack
this slice adds. It also names the consequence, which is the part that matters —
the "Files expected to change" list stays exhaustive and the definition of
done's `git status` clause holds. B-02, the manifest's B-02 `given`, and the test
plan's refusal line all repeat the location, and no pack path was added to the
file scope. The `01-` prefix no longer invites uncommitted siblings.

## F-08 — B-28's listing assertion will go red when S2 merges

Making that scope lock observable is right; the assertion chosen to do it reaches
too far. B-28 now asserts that `eval-packs/` "contains no other file", with an
observableResult pinning a recursive listing of `eval-packs/` to exactly
`["fixtures/refused/01-unknown-member.json"]`.

This slice's own non-goals section says #263 (S2) creates `eval-packs/afk/` and
`eval-packs/fixtures/consumer-governance/`. PRD 7 selects #262, #263 and #264
onto one feature branch, and #264 is already merged on this checkout — so slices
land sequentially onto a shared branch, and `pnpm test` runs again on the merged
branch at the pre-ship gate. The first `eval-packs/` file S2 commits turns
B-28's test red there, with nothing wrong in either slice: S1 asserted the
absence of files S2 is contracted to add. Repairing it at that point means
editing `src/eval-pack.test.ts`, which belongs to S1's file scope, not S2's.

The prior version of B-28 asserted only the refusal, so this is a
revision-caused gap rather than a standing one.

The fix is to bound the assertion to what this slice owns. Asserting that a
recursive listing of `eval-packs/fixtures/refused/` equals exactly
`["01-unknown-member.json"]` still proves the point F-07 asked for — that no
sibling refusal packs were committed next to the one D2 names — and stays true
after S2 lands. Asserting over the paths this slice's diff adds under
`eval-packs/` would work equally well. Either way the scope-lock sentence naming
this as the only pack S1 commits can stay exactly as written; it is prose, and
prose is the right place for it.

## One observation, not a finding

The manifest's `fileScope` entries for the two docs were lowercased in this
revision (`CONTEXT.md` → `context.md`, `ARCHITECTURE.md` → `architecture.md`)
while `contract.md`'s "Files expected to change" keeps the real casing. That is
harmless — `normalizePath` in `src/acceptance-manifest.ts` lowercases both sides
of the comparison — so scope enforcement still authorizes the edits B-30 and
B-31 make. Restoring the on-disk casing would just make the two artifacts read
alike; nothing depends on it.
