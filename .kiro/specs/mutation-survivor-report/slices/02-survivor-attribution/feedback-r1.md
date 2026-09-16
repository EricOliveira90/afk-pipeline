# Contract feedback — round 1

## What is already solid

The scope lock reads as one coherent slice: two optional manifest keys, one
pure attribution function, and the labels riding channels that already exist.
Several things that usually go wrong here are handled explicitly and correctly
against the code in this worktree:

- **The parser's return object is treated as load-bearing.** B-01 is right that
  `normalizeMutationReport` (`src/afk-manifest.ts:187-228`) returns a literal
  built from only the fields it reads, so a key it does not return is dropped —
  and B-03 pairs that with the on-disk rewrite the way the existing
  `[behavior:#303:B-05]` test at `src/afk-manifest.test.ts:397-423` does.
- **The manifest parser's language change binds both halves.** B-01 supplies
  newly accepted input, B-02 supplies the refusals for each new key, and P-02
  holds the existing `command`/`reportPath` refusals in place. The established
  harness for this parser really is inline object and string literals (the
  `it.each` refusal table at `src/afk-manifest.test.ts:225-286`), so the
  contract's claim that no new fixture convention is needed matches the repo.
- **One formatter, no per-consumer branch.** `formatMutationReportLines`
  (`src/mutation-report.ts:500-528`) is the sole shared renderer, and B-10 puts
  the label suffix there rather than at either call site. P-04 correctly names
  the three existing lines that must not move, including the
  reason-not-recorded line.
- **Degradation stays out of the step's verdict vocabulary.** P-03 pins
  `MutationNotRunReason` to its four members, and B-12 plus the non-goals keep
  every label away from a gate id, a verdict and the PR-open decision.
- **The persistence claim is checkable.** `sanitizeMutationStep`
  (`src/run-state.ts:950-992`) rebuilds each survivor field by field, so B-11 is
  right that `label` has to be copied through explicitly, and its
  legacy-record case (no `label` renders `unattributed`) is the right shape for
  keeping `RUN_STATE_VERSION` at 7.

Scale is on the high side — eleven files, twelve new behaviors, a new parser and
a new pure function — but there are no migrations, no spawned scenarios and no
new fixture files, and each piece is a unit-testable seam. I read it as
deliverable in one session.

## What has to change before this can lock

### An absent file and an unusable file currently claim the same input

This is the one that would break in the test suite rather than in review.
B-04 specifies the two new readers on the `readMutationReport` pattern —
"`{ status: "UNREADABLE"; detail }` on any read failure" — and the manifest's
B-04 spells the consequence out: "a missing file returns status UNREADABLE".
That is faithful to `src/mutation-report.ts:190-204`, where an absent file and
an unreadable one are the same result.

But B-06 says an absent declared baseline yields "no attribution note", and
B-08 says an `UNREADABLE` baseline adds `BASELINE_UNUSABLE`. An absent declared
baseline is both. Two acceptance tests in the same slice would assert opposite
notes for one input, and the generator has to invent the distinguishing
mechanism — a distinct read status for absence, an existence probe before the
read, or absence expressed as an omitted input to `attributeMutationSurvivors`.
Pick one and say it.

The decisions side has the same hole with less coverage: B-08 gives an
`UNREADABLE` decisions file `DECISIONS_UNUSABLE`, and nothing states what an
absent `decisionsPath` produces, even though the scope lock and the non-goals
both promise that neither absence is ever an error.

### Five preservation behaviors declare a gate that cannot see them

P-01, P-02, P-04, P-05 and P-06 all declare `acceptance:behaviors`, whose
command is `pnpm exec vitest run --reporter=json --testNamePattern
{behaviorId}`. That gate counts coverage only from assertions whose name
carries this slice's issue-qualified tag — `src/acceptance-gate.ts:109-117`
filters on `behaviorTag(issueNumber, behaviorId)`, and this repo spells it
`[behavior:#303:B-08]` / `[behavior:#303:P-02]`
(`src/mutation-report.test.ts:131`, `src/afk-manifest.test.ts:284`).

Those five observable results say the existing tests pass untouched, and the
Definition of done scopes tagging to "each new test name". Every existing test
they point at is tagged `#303`, so the gate would find no `#304`-qualified
assertion for `P-01` and friends and fail coverage on a slice that is in fact
correct. Slice 01's manifest sidestepped this by phrasing each preservation
observable as an assertion its named test file makes. Retitling an existing
test to carry the `#304` tag is enough here, and it leaves the assertions
themselves unedited, which is what P-02 and P-04 actually care about.

## Two things worth stating, not blockers

**The baseline's format is an assumption, not a fact this repo can check.**
B-04 justifies reusing `parseMutationReport` on the ground that the tool's
incremental file "is the same mutation-testing-elements document". Nothing in
this repository establishes that — there is no sample incremental file and no
schema reference. The design contains the risk well: a differently shaped file
parses `MALFORMED` and B-08 turns that into `BASELINE_UNUSABLE` with every
survivor `unattributed`, which is exactly the graceful path. Say it is an
assumption and name that fallback, so a future "everything is unattributed"
report is diagnosable in one step.

**The two match keys rest on opposite premises about id stability.** B-05
declines to key the baseline on `id` because "an incremental file renumbers its
per-file mutant ids between runs", while B-07 keys the decisions lookup on `id`
plus `file`. Keying decisions on `id` is the right call — it is what
`src/mutation-report.ts:46-50` already committed to and what ADR 0071 records,
and amending the ADR is properly a non-goal. But if B-05's premise holds, a
committed decisions entry goes stale on the next run and the `accepted` label
quietly stops applying. Name that consequence where B-07 states the key, so the
divergence reads as deliberate rather than as an oversight.
