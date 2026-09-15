# Contract review feedback — round 2

Slice: `02-atomic-additive-split-scope-extension` (GH #278)

The blocking ordering gap is closed and the contract is buildable as written.
Two advisories stay open; one of them is a claim the revision added that its own
companion artifact does not support.

## What the revision closed

**The replay / resolution ordering (F-01).** B-03 now fixes the insertion point
instead of leaving it to the generator: eligibility, `attempt-already-pending`,
`completedReplacementFor` (`:709-728`, unmoved), then extension resolution, all
still ahead of the branch-tip reads, the snapshot and the lock. It then names the
scope view per branch under one rule — plain `state.scope.slices` when the request
is not a replay, and `state.scope.slices` minus the identities the trailing
`COMPLETED` event records when it is. That makes each of B-09's declared cases
actually reachable: `{2,3}` resolves against the pre-completion view and lands on
`replay-completed-no-op`, and `{2}`, `{2,3,4}`, `{2,4}` resolve and then fail set
equality as `replay-conflict`. The different-target case reaches the same branch
because `completedReplacementFor` keys off the pair's fingerprints, not the
requested target. B-02 taking a *view* rather than `RunState`, and B-07 pinning
completion-time revalidation to the plain locked view, keep the two call sites
from being confused. B-09's distinguisher is stated in shape and code rather than
message text (`replayed: true`, `code: "replay-completed-no-op"` /
`"replay-conflict"`, never an `extension-*` code), and the malformed-replay case
that *does* return `extension-slice-unknown` is now in the test plan — which is
what stops the "never `extension-*`" assertion from being vacuous.

**The selector language (F-02).** B-01 declares digits-only to be the whole
accepted language and shows why it already covers issue ids: `issues.md` parsing
stores `Slice.ghIssue` with the `#` stripped (`src/issues-parser.ts:80`), so
every issue id an extension member can resolve to is itself digits-only. The
decision to refuse `#278` rather than normalize it is recorded with its reason.
Both halves of the parser regression surface are bound in the inline harness this
repo uses for `cli-options`: `--extend-scope 03,278` as the newly accepted input,
and `12,x`, `12,#278`, `12,12`, the duplicated flag and the missing value as the
rejected/boundary side, all in `src/cli-options.test.ts`, which is in `fileScope`.

**The atomicity observation (F-03).** B-08 takes the honest option: it says
outright that there is no seam inside the transaction body, and restates the
obligation as the evidence the observation produces — exactly one
`transactRunState` returning `changed: true` once, no second writer on the path,
one published document holding both halves. The `beforeLockAcquired` interleave is
relabelled as the adjacent fact it can witness, and the definition-of-done line
now matches that bar instead of promising an intermediate-document observation.

## Still open

**F-04 — the gate story got asserted rather than fixed.** The planner's response
says every behavior row now declares
`["typecheck", "tests", "acceptance:behaviors"]` on all fifteen behaviors. The
file does not: five rows carry `acceptance:behaviors` (B-01, B-02, B-03, B-08,
B-09) and ten do not — B-04, B-10, P-02 and P-05 at `["typecheck", "tests"]`, and
B-05, B-06, B-07, P-01, P-03 at `["tests"]` alone. Some of those rows appear in
the revision evidence only as whitespace reformatting of the same gate list.
Because the definition of done was rewritten in the same round to say
"`acceptance:behaviors` for every behavior id in this slice's manifest … the same
three ids the manifest declares", the round moved the mismatch *into* the contract
as a false statement about its companion, rather than removing it. Either finish
the manifest edit so that sentence is true of the file, or narrow the sentence to
the ids the rows actually carry — and give the five `["tests"]`-only rows a
`typecheck` beside the full-suite gate while you are there.

**F-05 (new) — B-03's "only branch" sentence overreaches its own rule.** Because
replay detection is keyed by the pair on disk, *any* request arriving while a
completed attempt's pair is present takes the replay branch, including one with a
different target or a different set — which B-09 answers as `replay-conflict`. The
replay view subtracts only what the trailing `COMPLETED` event added, so a member
that was in persisted scope *before* that attempt is still in the view and does
draw `extension-already-in-scope` on the replay branch. That is the one case where
B-03's "this is the only branch that refusal can arise in" and B-09's blanket "a
different identity set … is `replay-conflict`" do not hold. Nothing declared
becomes unreachable — every set B-09 enumerates is the completed attempt's own
additions plus a fresh member — so this is advisory: narrow the invariant to what
the view rule supports (a member the completed attempt itself added cannot draw
that code) and add already-in-scope to the replay branch's refusal list, or state
that such a member is refused rather than answered as a replay and scope B-09's
claim to match.
