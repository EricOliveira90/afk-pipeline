# Contract feedback — Eval seed pack (round 1)

## The README casing mismatch is fixed

The path that carried over from the previous attempt now agrees everywhere. The
manifest's file-scope list spells `eval-packs/afk/README.md` with the uppercase
name, and so does every other mention: the "Files expected to change" entry,
B-07's behavior text, B-06's `given`, the test-plan line that reads the README's
text, and the definition-of-done row. On a case-sensitive checkout the written
path and the declared path are now the same string, so the file-scope gate has
nothing undeclared to flag and B-07's read finds the file on Linux CI as well as
on Windows. Nothing further is needed here.

## What still blocks the lock: the four PRD 4 cases

B-06 does the right thing about the missing archive. It records, as a decision,
that where the operator's archived inputs are unavailable in this checkout the
prompt is reconstructed from the excerpts quoted inside `prd.md`, #192 and #194,
with the `source` still naming the archived path plus `hand-reconstructed`. That
decision genuinely covers B-02 and B-03: #192's three escalations are identified
by decision (D1 `gatePolicy` shapes, D5 waiver `path`, D6 glob dialect) and its
PRD 4 excerpt is pinned to a reachable commit, and #194's F-03 false premise is
quoted inline in `prd.md`. A generator can write those four cases.

B-05's four cases have no such backing. The explorer's evidence is explicit that
PRD 4's `reviews/` directories are absent from this worktree and gitignored
everywhere, and that which archived verdicts a human later bore out cannot be
determined here — `prd.md` records only file counts per slice, not verdict
content and not any outcome confirmation. B-06's fallback names three excerpt
sources and none of them is PRD 4, so for these four cases the fallback is
empty. That leaves the generator two ways to finish the session, and the
contract cannot distinguish them at QA time: invent four verdict
reconstructions with four confirming facts it has no way to check, or leave four
of the nine declared files unwritten. Either way the count B-01 locks and the
per-case `source` rule B-06 locks stop being checkable claims.

Three ways out, any one of which clears it. Name, per case, the material the
reconstruction actually draws on and a reachable record of the human
confirmation — a merge commit or PR number on the PRD 4 feature branch would do,
since those are in this repository's history even though the review artifacts are
not. Or record a decision that replaces the "verdicts a human later bore out"
criterion with one the generator can satisfy from what it can read, and update
B-05's manifest `then` and `observableResult` to the new criterion. Or move B-05
to the non-goals and restate the pack's count everywhere it appears — B-01, B-06,
B-07, the "Files expected to change" list, the manifest's file-scope paths, and
the test plan's nine-case assertions.

## A smaller point about how B-05's assertion is written

B-05's observable result says a test asserts each `source` contains "a
confirming-fact clause." That is not a property a test can decide; B-06 shows the
form that works, fixing the literal word `hand-reconstructed` as the substring to
look for. The same looseness appears in B-05's `then` and in the third test-plan
bullet. If the blocking issue above is cleared by keeping B-05 and citing
reachable confirmations, fix the marker at the same time: state the literal
substring or structure the confirming fact must carry, and phrase the manifest
assertion in terms of it. If B-05 goes away, so does this.

## What the rest of the contract gets right

The parser surface is bound on both halves, which is what ADR 0060 asks for even
though no parser code changes here. The positive half is B-01 and B-08: two new
packs that `readEvalPack` must accept, with the seven-member case shape, the
`NN-` filename prefix that makes the byte-wise scan order the declared order, and
`fromFile` targets that all resolve inside the declared fixture list. The
rejected half is P-02: slice 01's `01-unknown-member.json` stays untouched and
stays refused for its unknown `notes` member, and the contract says out loud that
it is a refusal fixture rather than a template. The owning fixture area is
declared path by path, so nothing is left to be discovered during the run.

Gate choices are apt. Every behavior that makes a claim about committed file
content routes to `tests` plus `acceptance:behaviors`, which is right — these are
assertions a vitest file makes by reading packs and README text. The three
preservation behaviors route to diff inspection plus the existing eval suites,
and P-01 correctly names the five slice 01 runner modules it is protecting. B-10
is a real assertion rather than a promise: it inspects the pack-directory
argument of every eval dispatch under `src/`, which a test can do by reading
files, and it is the thing that keeps `pnpm test` from spending a model call.

Scope is evidence-backed and matches the explorer's file-scope map: no `src/`
production file, no `CONTEXT.md`, no `ARCHITECTURE.md`, no migrations, no new
spawned scenario or `test:heavy` suite. The non-goals name the neighbouring work
explicitly — the prompt recorder in slice 03, live-model dispatch, any gate
consuming an eval report, and the sources `decisions-review.md` H2 dropped. The
two counts the issue left open are settled in the contract rather than deferred:
nine cases, and one case from #194 rather than two, each with its reasoning
attached. Feasibility is fine for the parts that are authorable — the fixture
files are short documents — and would be comfortable once B-05 is either
grounded or dropped.
