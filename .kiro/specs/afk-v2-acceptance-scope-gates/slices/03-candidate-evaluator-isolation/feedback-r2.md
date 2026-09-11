# Contract review — round 2

Slice 03, candidate evaluator in a disposable worktree. Three findings were
routed into this round; each is judged below against its own clear-condition,
and every claim the revision makes about existing code was checked against the
tree rather than taken on the planner's word.

## F-08 — the two git reads no exported helper covers

Resolved. The revision does not pick either branch the clear-condition
spelled out; it removes the dilemma instead, which is the outcome the finding
was protecting. B-04's enumeration is now a named seam — a new exported
function in `src/qa-review.ts`, called once from `runQAStage`, issuing
`status --porcelain=v1 --untracked-files=all` over the review worktree plus a
second `--ignored` status scoped to the `.afk` roots with `execFileSync`, both
under `-c core.quotePath=false`. B-05's read is likewise located inside
`src/change-summary.ts`. Both hosting files are in `fileScope`, so no
out-of-scope edit is forced mid-slice and the file-scope gate has nothing to
fire on.

The reasons given for not reusing the existing exports hold up on inspection:

- `git.statusPorcelain` (`src/git.ts:489`) really does issue
  `["status", "--porcelain"]` with neither `--untracked-files=all` nor
  `--ignored`, and its own docstring records that the ship gate parses its
  output — so both halves of the "not reused, not amended" argument are true,
  not just asserted.
- `git.logCommitsWithStat` (`src/git.ts:726`) is hard-wired to
  `${base}..HEAD`, and `git.listChangedFiles` (`src/git.ts:1272`) returns a
  union path set, so neither answers a two-ref commits+files+stats question.
- The `core.quotePath=false` rationale the contract points at is where it says
  it is (`src/git.ts:1296-1305`), and importing that reasoning into a second
  call site is the right instinct.

The ambiguity that made the original finding blocking is gone: "run in-module
through the already-imported `git.js` seam" has been replaced by a statement
of which file owns the read and how it issues it. B-01's "four helpers"
assurance is narrowed to the worktree lifecycle with a line cite per helper,
the new non-goal forbids widening any `src/git.ts` export including
`statusPorcelain`'s argv, and a Definition-of-done item plus the `then` clauses
of B-04 and B-05 all make "src/git.ts is unmodified" a checkable obligation
rather than an intention. B-05's purity claim is honestly restated as
determinism over `(cwd, fromRef, toRef)` — which is the property slice 04
actually needs — and its scenario now runs in a temp repo and asserts
repeat-call stability, so the claim has an observable.

One consistency tidy, not a finding: the "New patterns / deps / schema" bullet
still describes `src/change-summary.ts` as "one pure two-tree builder", which
is the wording B-05 deliberately walked back. Worth aligning when the
generator touches the section, but nothing depends on it.

## F-09 — where the prompt-text assertion lives

Resolved. The observable now names all three obligations its `then` promises —
the four judgement questions, both halves of the D14 probe rule, and the
discard instruction — and moves the assertion into
`src/prompt-template.test.ts`. That file is genuinely the non-spawned home for
this kind of check: the cited region reads prompt and persona markdown straight
off disk via `new URL("../...", import.meta.url)` and asserts on the text. The
hosting file is added to both `fileScope` and the expected-change list, the
test-plan scenario matches, and the Definition-of-done item says "not in a
spawned suite" explicitly, so the ladder the contract sets for itself is now
self-consistent.

## F-10 — the seed manifest's observable surface

Resolved. B-02 no longer asks a test to read the contents of a per-attempt
in-memory set. It keeps the amended-bytes clause and restates the second clause
as the consequence B-04's scan already emits: no `reviewer-write-violation`
event names `contract.md` or `acceptance-manifest.json` for that attempt.
B-02's `then` now carries that consequence in words too, so the observable
covers the whole promise instead of a subset of it.

## Other revision changes

The manifest's `gateIds` arrays were reflowed one-per-line and the
`ARCHITECTURE.md` entry in `fileScope` was lowercased to `architecture.md`.
Neither changes meaning: `fileScope` paths are lowercased during manifest
normalization (`src/acceptance-manifest.ts:64-97`), so the scope gate matches
the tracked `ARCHITECTURE.md` either way.

The contract pair is ready to implement as written.
