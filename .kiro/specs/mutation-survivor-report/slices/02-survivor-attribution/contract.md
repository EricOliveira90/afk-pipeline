# Slice Contract — Survivor attribution and accepted decisions

**Parent PRD:** .kiro/specs/mutation-survivor-report/prd.md
**GH issue:** #304
**Status:** LOCKED

**Lock-Provenance:** negotiation round 2
**Negotiation round:** 2

## Scope lock

The report-only mutation survivor list becomes attributable and
non-repetitive. `afk.json`'s existing `mutationReport` member gains two
optional keys — `baselinePath` and `decisionsPath` — validated, normalized and
**returned** by `parseAfkManifest` exactly as `reportPath` already is. When the
merged review worktree carries the declared baseline artifact, each survivor is
labeled `new-in-this-run` or `pre-existing`; with no usable baseline every
survivor is labeled `unattributed`. When it carries the declared triage
decisions file, a survivor matching an `ACCEPT` entry is labeled `accepted`
instead of being re-raised as an open finding — and stays in the list, because
the report marks, it never suppresses. Attribution is one pure function over
(survivors × optional baseline × optional decisions), called once inside
`runMutationStep`; the labels ride the existing `mutation-step` event and run
state record, so `run-summary.md` and the draft PR body inherit them through
the one shared formatter and cannot disagree. Nothing here gates: no gate,
verdict or PR-open decision reads a label (ADR 0063, ADR 0071's "no blocking
mutation gate").

### In scope

- [behavior:B-01] `MutationReportDeclaration` (`src/afk-manifest.ts:52`) and
  `MutationReportConfig` (`src/mutation-report.ts:31`) each gain optional
  `baselinePath` and `decisionsPath`; `normalizeMutationReport`
  (`src/afk-manifest.ts:187`) normalizes a present value with
  `normalizeWaiverPath` and **returns** it in its result object, and an absent
  key stays absent (never `undefined`-valued, never defaulted) — the same
  absence discipline `mutationReport` itself is under (#303 B-04). Returning
  them is load-bearing: the ship gate rewrites `afk.json` from the parsed
  object, so a key the parser drops is deleted from the reviewed branch
  (#304 AC1). Declared in `afk.json` rather than a CLI flag or a script
  convention because `afk.json` is the strictly-validated cross-repository
  contract for a durable per-project fact (ADR 0034; reasoning recorded on
  #303).
- [behavior:B-02] Each new key is refused with a message naming the offending
  member when it is present but not a non-blank string, looks like a glob
  (`/[*?[]/`), is absolute (`/^(?:[a-zA-Z]:)?\//`), or traverses with `..` —
  the identical rule set `reportPath` carries at
  `src/afk-manifest.ts:202-226`, applied through one local helper the three
  paths share rather than a third copy of the block. `afk.json` stays at
  `version: 1` (#304 config surface; PRD "Implementation Decisions").
- [behavior:B-03] `trimUnclaimedMigrationPrefixes`
  (`src/afk-manifest.ts:376`) rewrites `afk.json` with both new keys intact in
  the bytes on disk, the way it already preserves `mutationReport`
  (`src/afk-manifest.test.ts:399-423`) (#304 AC1).
- [behavior:B-04] `src/mutation-report.ts` gains a pure, total
  `parseMutationDecisions(text)` returning
  `{ status: "PARSED"; decisions } | { status: "MALFORMED"; detail }` —
  never a throw, the discipline `parseMutationReport`
  (`src/mutation-report.ts:120`) is under, because a report-only step's parse
  error must not reach a gate. The accepted document is
  `{ "version": 1, "decisions": [ { "id", "file", "verdict", "consequence",
  "containment", "reasoning" } ] }`: ADR 0071's "Decisions file schema" field
  set (mutant identity, consequence, containment, `KILL`/`ACCEPT` verdict, one
  line of reasoning) with those exact key spellings pinned here so Stage A
  triage sessions have one spelling from day one, and its `version: 1` regime
  matching the manifest's per the same ADR section. A missing or non-`1`
  version, an absent `decisions` array, an unrecognized `verdict`, or any blank
  field is `MALFORMED` naming the offending member.
  `readMutationDecisions(cwd, decisionsPath)` and
  `readMutationBaseline(cwd, baselinePath)` read from the worktree the command
  ran in and **separate absence from unusability** — the one mechanism every
  degradation rule in this slice keys on. Each returns
  `{ status: "ABSENT" }` when `existsSync(join(cwd, path))` is false, and only
  then; a path that exists but throws on read is
  `{ status: "UNREADABLE"; detail }`, and one that reads but does not parse is
  `MALFORMED`. That deliberately diverges from `readMutationReport`
  (`src/mutation-report.ts:190-204`), which collapses an absent file into
  `UNREADABLE`, and `readMutationReport` itself is **not** changed: a missing
  mutation report is a real failure that must reach `REPORT_UNREADABLE` and
  `MUTATION_NOT_RUN` (#303, pinned by P-03 and by the existing
  `[behavior:#303:B-08]` case at `src/mutation-report.test.ts:219`), while a
  missing baseline or decisions file is the normal case and must stay silent
  (#304 AC4). `ABSENT` is observable without simulating a permission error: the
  absent case writes no file, and the present-but-`UNREADABLE` case puts a
  **directory** at the declared path, so `existsSync` is true and `readFileSync`
  throws. The baseline is parsed by the existing `parseMutationReport` on
  **this slice's stated assumption** that the tool's incremental artifact is the
  same mutation-testing-elements document, whose survivor set is exactly what
  "was this already surviving" asks: no sample incremental file and no schema
  artifact exists in this repository to confirm that shape — the same gap
  `src/mutation-report.ts:83-88` already records for the report schema it
  hand-derived. The assumption is safe because its failure is contained and
  named: a differently shaped baseline parses `MALFORMED`, which B-08 turns into
  `BASELINE_UNUSABLE` with every survivor `unattributed`, so a wrong shape can
  only cost attribution and can never produce a wrong label — and an operator
  reading "everything unattributed" next to `BASELINE_UNUSABLE` is one step from
  the cause.
- [behavior:B-05] A new pure `attributeMutationSurvivors({ survivors,
  baseline, decisions })` in `src/mutation-report.ts` returns
  `{ survivors, notes }` with one `label` per survivor from
  `MutationSurvivorLabel = "new-in-this-run" | "pre-existing" | "unattributed"
  | "accepted"`. With a parsed baseline, a survivor whose `file`, `mutator` and
  all four `position` numbers match a baseline survivor is `pre-existing`, and
  one that matches none is `new-in-this-run` (#304 AC2, AC3). The match is on
  location and mutator rather than on `id`, on the conservative assumption —
  this slice's, recorded here for the same reason B-04 records its schema
  assumption — that an incremental file may renumber its per-file mutant ids
  between runs, which would make an id-keyed comparison report unchanged
  survivors as new. Location and mutator are stable under renumbering either
  way, so the assumption costs nothing if it is wrong. B-07 states what the same
  assumption implies for the decisions key it cannot choose.
- [behavior:B-06] Absence is silent, and it is the *omitted or `ABSENT` input*
  that makes it so — never a read status an actual failure also produces.
  `attributeMutationSurvivors` takes `baseline` and `decisions` as optional
  parameters typed as their reader's full union (B-04), and an omitted argument
  and an `ABSENT` argument take the identical branch. So: with no `baselinePath`
  declared, or a declared `baselinePath` whose read returned `ABSENT`, every
  survivor is labeled `unattributed` and **no** note is produced. With no
  `decisionsPath` declared, or a declared `decisionsPath` whose read returned
  `ABSENT`, no survivor is labeled `accepted`, whatever baseline label each
  survivor carries is left exactly as it is, and again **no** note is produced.
  Both absences are normal, never an error (#304 AC4 and its settled decisions;
  the non-goal "neither absence is ever an error"). Because the silent branch is
  keyed on `ABSENT`-or-omitted and B-08's noted branch is keyed on `UNREADABLE`
  or `MALFORMED`, no single input can satisfy both behaviors.
- [behavior:B-07] A survivor whose `id` **and** `file` both match a
  `verdict: "ACCEPT"` entry is labeled `accepted`, replacing whatever baseline
  label it would otherwise carry, and remains in the returned list at its
  original position (#304 AC5, AC6). `id` is the tool's own id, as
  `src/mutation-report.ts:46-50` already declares the decisions file keys by;
  `file` corroborates it, because per-file ids collide across files and a bare
  id match must be corroborated before it resolves identity (ADR 0065).
  A `verdict: "KILL"` entry changes no label — an unkilled mutant a human ruled
  killable is still an open finding. This key deliberately diverges from B-05's
  location-and-mutator key, and the divergence is the recorded decision's rather
  than this slice's: `src/mutation-report.ts:46-50` and ADR 0071 already commit
  the decisions file to the tool's own `id`, and amending that ADR is an explicit
  non-goal. B-05's premise therefore lands here as a stated consequence rather
  than a hidden one — if the tool renumbers per-file ids between runs, a
  committed `ACCEPT` entry goes stale, either matching nothing (its survivor is
  re-raised carrying its baseline label) or matching whichever mutant now holds
  that id in the same file (a survivor no human adjudicated is labeled
  `accepted`). The harm is bounded by what a label is: report text read by no
  gate, verdict or PR-open condition (B-12), and an `accepted` survivor stays in
  the list at full detail (the suppression non-goal), so the worst case is one
  mislabeled bullet a reviewer can check against the decisions file — never a
  hidden survivor and never a changed outcome. Recorded here as this slice's
  decision, so the divergence between the two match keys reads as deliberate.
- [behavior:B-08] Degradation is graceful, named, and keyed **only** on
  `UNREADABLE` or `MALFORMED` — never on `ABSENT` and never on an omitted input,
  both of which B-06 owns. A decisions file that is present but `UNREADABLE` or
  `MALFORMED` yields no `accepted` label at all, leaves baseline attribution
  untouched, and adds the note `DECISIONS_UNUSABLE`; a baseline that is present
  but `UNREADABLE` or `MALFORMED` labels every survivor `unattributed` and adds
  `BASELINE_UNUSABLE`. Neither ever changes the step's status (#304 AC7).
- [behavior:B-09] `runMutationStep` (`src/mutation-report.ts:357`) calls
  `attributeMutationSurvivors` once on a `MUTATION_REPORTED` outcome, reading
  the two declared paths from its existing `config` under the step's own `cwd`
  — no new argument, no second read of git, no second producer of labels. A
  declared path is read and its result passed straight through, `ABSENT`
  included; an undeclared key means the corresponding argument is omitted, and
  the call site probes nothing itself, so the absent-versus-unusable
  distinction lives only in the readers (B-04, B-06). The
  `MUTATION_REPORTED` case of `MutationStepOutcome`
  (`src/mutation-report.ts:74`) carries the labeled survivors plus optional
  `attributionNotes`, and the reads happen after the command has exited, so the
  pre-spawn abandonment window (`src/mutation-report.ts:366-367`) is untouched
  (#304 settled decisions: assembly is a pure function over the three inputs).
- [behavior:B-10] `formatMutationReportLines`
  (`src/mutation-report.ts:500`) appends each survivor's label to that
  survivor's bullet and renders one line per attribution note stating the
  degradation. Because it is the one formatter both consumers call
  (`src/logger.ts:884` for `run-summary.md`, `src/ship-gate.ts:535` for the
  draft PR body), both surfaces show the labels and the degradation line with
  no per-consumer branch (#304 AC2-AC5, AC7; #303 B-14).
- [behavior:B-11] Labels and notes travel the existing channel end to end: the
  `mutation-step` event payload (`src/run-events.ts:483`),
  `PersistedMutationStep` (`src/run-state.ts:365`) with
  `sanitizeMutationStep` (`src/run-state.ts:950`) copying `label` and
  `attributionNotes` through, `MutationStepReport` (`src/logger.ts:290`), and
  `deriveMutationStepOutcome` (`src/logger.ts:306`). Both additions are
  optional members inside records every existing reader already tolerates as
  absent, so `EVENTS_SCHEMA_VERSION` stays 1 (`src/run-events.ts:31`) and
  `RUN_STATE_VERSION` stays 7 (`src/run-state.ts:72`) — the rationale #303
  recorded for the member itself (`src/afk-manifest.ts:312-317`): an optional
  member every existing reader ignores is not a schema break. A persisted
  record whose survivors carry no label loads unchanged and renders
  `unattributed`, which is what such a record means.
- [behavior:B-12] No label or note reaches a decision. Nothing in this slice
  adds a gate id, a `GateDeclaration`, a `GateFindings` field, or a read from
  any verdict or PR-open condition; a run whose survivors are labeled — the
  `accepted` label included — produces the same ship-gate verdict, the same
  gate results and the same opened draft PR as the same run with unlabeled
  survivors (#304 AC8; ADR 0063; ADR 0071 "no blocking mutation gate").

### Non-goals (explicit out-of-scope)

- Creating, refreshing or scoping a baseline artifact, and any AFK slice that
  writes one — operator work, out-of-band (PRD "Out of Scope").
- Writing, proposing or ratifying decisions-file entries; trust-ladder stages
  B and C.
- Any kill-rate number, threshold, gate, verdict change or PR-open condition
  keyed on mutation results.
- Suppressing an accepted survivor from the list, or shortening the list for
  any reason.
- Amending `docs/adr/0071-report-only-mutation-survivor-step.md`; this slice
  implements its recorded schema, and the pinned key spellings are documented
  at the parser instead.
- A CLI flag, a `package.json` script convention, or a preflight refusal for
  either new path; neither absence is ever an error (#304 config surface).
- Any new spawned pipeline scenario, and any test that invokes a real mutation
  tool (PRD "Testing Decisions").

### Existing behavior to preserve

Every behavior below is proven by at least one passing assertion whose full name
carries `[behavior:#304:P-0x]`. For P-01, P-02, P-04, P-05 and P-06 that
assertion is the **existing** test, retitled to carry this slice's tag *in
addition to* the `[behavior:#303:...]` tag it already has — the acceptance gate
matches each required tag independently with `fullName.includes`
(`src/acceptance-gate.ts:109-117`, `behaviorTag` at `:246`), so one name proves
both slices and #303's own coverage is never removed. Retitling a `describe`
carries the tag to every assertion inside it. The retitle is the whole edit:
no preserved assertion, expected string or `it.each` table row changes, which is
exactly what these behaviors assert.

- [behavior:P-01] A manifest with no `mutationReport`, and a run without
  `--mutation-report`, behave exactly as before: no member is written, no
  `mutation-step` event is emitted, and `run-summary.md` plus the draft PR body
  stay byte-identical (`src/afk-manifest.ts:312-317`, `src/logger.ts:874-885`,
  #303 B-04/P-01). Retitled to carry `[behavior:#304:P-01]`:
  `src/afk-manifest.test.ts:203`, `src/logger.test.ts:1719` and
  `src/ship-gate.test.ts:2577`.
- [behavior:P-02] `command` and `reportPath` validation, normalization and
  every existing refusal message in `normalizeMutationReport`
  (`src/afk-manifest.ts:187-228`) are unchanged, including the fail-closed
  throw rather than a `PreflightFinding` (`src/preflight.ts:142`). Retitled to
  carry `[behavior:#304:P-02]`: the `it.each` refusal table at
  `src/afk-manifest.test.ts:276` and the existing-member case at
  `src/afk-manifest.test.ts:288`, both with their expected messages and table
  rows unedited.
- [behavior:P-03] The `MUTATION_NOT_RUN` vocabulary is unchanged:
  `MutationNotRunReason` (`src/mutation-report.ts:67`) gains no member, and no
  absent, unreadable or malformed baseline or decisions file can classify the
  step `MUTATION_NOT_RUN` (#304 AC7).
- [behavior:P-04] `formatMutationReportLines` stays the single formatter both
  consumers call, and its existing lines are unchanged: the empty-survivor
  line, the `MUTATION_NOT_RUN` reason line, and the missing-reason line that
  refuses to invent a reason the run never observed
  (`src/mutation-report.ts:505-521`). Retitled to carry
  `[behavior:#304:P-04]`: the `describe` at `src/mutation-report.test.ts:659`,
  which carries the tag to every assertion inside it with their expected strings
  unedited.
- [behavior:P-05] The step's sequencing is untouched: one run, concurrent with
  the guardians, the flat `MUTATION_STEP_BOUND_MS` bound, quiesce-then-classify
  at the bound, and the abandonment read with no `await` before the runner
  invocation (`src/mutation-report.ts:356-397`, `461-487`). Retitled to carry
  `[behavior:#304:P-05]`: the `describe`s at `src/mutation-report.test.ts:398`
  and `:513`, plus the bound and ordering cases at `src/ship-gate.test.ts:2411`,
  `:2449` and `:2487`, bound constant and assertions unedited.
- [behavior:P-06] `parseMutationReport` keeps returning only `Survived`
  mutants and keeps degrading the whole report rather than dropping a survivor
  it cannot locate (`src/mutation-report.ts:159-181`), and `readMutationReport`
  keeps calling a missing report `UNREADABLE`
  (`src/mutation-report.test.ts:219`) — the two new readers' `ABSENT` status
  (B-04) is additive and touches neither function. Retitled to carry
  `[behavior:#304:P-06]`: the `describe` at `src/mutation-report.test.ts:131`,
  which carries the tag to every assertion inside it, fixtures and expectations
  unedited.

### Changes to existing behavior (only if the issue asks for it)

- Every survivor bullet in `run-summary.md` and the draft PR body gains a
  label suffix, and a degraded baseline or decisions file adds one stated line
  to that section — authorized by #304's "Both labels appear wherever
  survivors are listed" and AC7.
- `MutationSurvivor` (`src/mutation-report.ts:45`) gains an optional `label`,
  and the `MUTATION_REPORTED` outcome, event payload, persisted record and
  `MutationStepReport` gain optional `attributionNotes` — authorized by #304
  AC2-AC7, which require both facts to reach both render sites.

## Files expected to change

- src/afk-manifest.ts
- src/afk-manifest.test.ts
- src/mutation-report.ts
- src/mutation-report.test.ts
- src/run-events.ts
- src/run-state.ts
- src/run-state.test.ts
- src/logger.ts
- src/logger.test.ts
- src/ship-gate.ts
- src/ship-gate.test.ts

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- The committed decisions file's on-disk schema, pinned to ADR 0071's field
  set with exact key spellings (B-04). One new in-module read-status member,
  `ABSENT`, on the two new readers' result unions only — the distinction B-06
  and B-08 both key on, deliberately absent from `MutationReportRead`
  (`src/mutation-report.ts:61-64`), which stays as #303 shipped it (B-04, P-06).
  No new dependency; no new test-fixture
  convention — the fixture JSON is inline object and string literals, as every
  test in `src/mutation-report.test.ts` and `src/afk-manifest.test.ts` already
  builds it.

## Test plan

- Given a manifest declaring `mutationReport` with `./reports\incremental.json`
  and `docs/mutation-decisions.json`, when `parseAfkManifest` reads it, then
  both keys come back normalized to forward slashes with no `./` prefix.
- Given a manifest whose `baselinePath` or `decisionsPath` is blank, a glob, an
  absolute path or contains `..`, when `parseAfkManifest` reads it, then it
  throws naming that member (one `it.each` case per refusal, the pattern at
  `src/afk-manifest.test.ts:224-286`).
- Given an `afk.json` carrying both new keys, when
  `trimUnclaimedMigrationPrefixes` rewrites it, then the file on disk still
  carries both.
- Given a survivor list and a baseline holding one of those survivors at the
  same file, mutator and position, when `attributeMutationSurvivors` runs, then
  that survivor is `pre-existing` and the other is `new-in-this-run`.
- Given a survivor list and, in turn, an omitted `baseline` argument and a
  `baseline` of `{ status: "ABSENT" }`, when `attributeMutationSurvivors` runs,
  then every survivor is `unattributed` and `notes` is empty in both cases.
- Given a survivor list with baseline labels and, in turn, an omitted
  `decisions` argument and a `decisions` of `{ status: "ABSENT" }`, when it
  runs, then no survivor is `accepted`, every baseline label is intact, and
  `notes` is empty in both cases.
- Given a declared `baselinePath` and `decisionsPath` where no file exists,
  when `readMutationBaseline` and `readMutationDecisions` run, then each returns
  `ABSENT`; given a **directory** at each declared path, then each returns
  `UNREADABLE`; and `readMutationReport` still returns `UNREADABLE` for a
  missing report.
- Given a decisions document with an `ACCEPT` entry matching one survivor's
  `id` and `file` and a `KILL` entry matching another, when it runs, then the
  first is `accepted` (over its baseline label), the second keeps its baseline
  label, and the list length is unchanged.
- Given a decisions document that is not JSON, declares no `version: 1`, or
  holds a blank `reasoning`, when it runs, then no survivor is `accepted`,
  baseline labels are intact, `notes` holds `DECISIONS_UNUSABLE`, and the
  status stays `MUTATION_REPORTED`.
- Given a baseline that is present but `MALFORMED`, and separately one that is
  present but `UNREADABLE`, when it runs, then every survivor is `unattributed`
  and `notes` holds `BASELINE_UNUSABLE` in both cases — the note an `ABSENT`
  baseline does not produce.
- Given `runMutationStep` with a config declaring both paths and a stub runner,
  when the report parses, then the outcome's survivors carry labels and its
  `attributionNotes` reflect the two files on disk.
- Given a `MutationStepReport` whose survivors carry labels and whose
  `attributionNotes` holds `DECISIONS_UNUSABLE`, when
  `formatMutationReportLines` renders it, then each bullet ends with its label
  and one line states the degradation.
- Given a `mutation-step` event carrying labels and notes, when the run summary
  renders and `readMutationStepOutcome` reads it back, then both show the same
  labels and the same degradation line.
- Given a persisted `mutationStep` record whose survivors carry no `label`,
  when run state loads, then the record survives sanitization, the version on
  disk stays 7, and the section renders `unattributed`.
- Given a ship gate whose mutation step reported labeled and `accepted`
  survivors, when the gate finishes, then its verdict, gate results and
  PR-open decision equal those of the same run with unlabeled survivors.

## Definition of done

- [ ] `pnpm run typecheck` is green.
- [ ] `pnpm vitest run src/afk-manifest.test.ts src/mutation-report.test.ts
      src/run-state.test.ts src/logger.test.ts src/ship-gate.test.ts` is green.
- [ ] Every behavior id in this contract — `B-01`-`B-12` and `P-01`-`P-06` —
      has at least one passing assertion whose full name carries the
      `#304`-qualified tag `[behavior:#304:<id>]`, so the acceptance gate's
      `--testNamePattern` selects it. New tests carry that tag as their only
      behavior tag; the preserved tests named in P-01, P-02, P-04, P-05 and
      P-06 are **retitled** to add it alongside the `[behavior:#303:...]` tag
      they already carry, and no other `#303` tag is removed or renumbered.
- [ ] Retitling is the only edit those preserved tests receive: `git diff` on
      each shows changed `describe`/`it` name strings and nothing else — no
      changed assertion, expected string, fixture or `it.each` table row.
- [ ] `pnpm test:fast` is green.
- [ ] Both new keys are returned by `parseAfkManifest` and survive an
      `afk.json` rewrite on disk.
- [ ] Every label in `MutationSurvivorLabel` is produced by
      `attributeMutationSurvivors` in at least one test, and both notes in the
      degradation vocabulary are too — with one test per file proving that
      `ABSENT` produces the label and **no** note while `UNREADABLE` and
      `MALFORMED` produce the label **and** the note.
- [ ] `grep` over the diff shows no new gate id, `GateDeclaration`,
      `GateFindings` field, threshold, percentage or verdict read touching a
      label or note.
- [ ] No new spawned pipeline scenario and no new test fixture file were
      added, and no test invokes a real mutation tool.
