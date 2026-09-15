# Handoff — #319 stable ticket anchors

Branch `fix/319-stable-ticket-anchors`, worktree `C:\Code\afk-319`, direct
in-repo work (not an AFK slice).

## What landed

**Limb 1 only: ticket lint check 6.** A source or test line-number citation
under a *load-bearing* heading gates, waivable with a reason through the
existing `ticket-lint-waivers.json` mechanism. That is #319's first acceptance
criterion, plus its second (guidance toward semantic anchors, carried in the
finding's own message), sixth (deterministic `pnpm lint:tickets <issue>...`
output) and eighth (authoring guidance).

- `scripts/lint-tickets.mjs` — `sectionsOf`, `isLoadBearingSection`,
  `lineCitationsIn`, `checkLineCitations`; wired into `lintTicket` and the
  usage text. Same finding shape, same severity vocabulary, same waiver route
  as checks 2–5.
- `ticket-lint-vocabulary.json` — new `loadBearingSections` list plus its
  `_loadBearingSectionsComment` explaining what belongs and what deliberately
  does not.
- `ticket-lint-waivers.json` — `_comment` field docs updated for check 6 (the
  token is the citation itself) and for check 5's `outcome` key, which the
  field list never mentioned.
- `src/lint-tickets.test.ts` — 3 new `describe` blocks (`sectionsOf`,
  `isLoadBearingSection`, `lineCitationsIn`), the check-6 block, and 2 new
  assertions on the committed vocabulary. 67 tests total, all unit tests
  against fixture text; nothing spawns.
- `docs/adr/0049-ticket-lint-declares-its-vocabulary.md` — amendment recording
  the decision, the corpus measurement, and why the remaining limbs cannot be
  done at the ticket.
- `AGENTS.md` — "Anchor a ticket on a name, never on a line number", in the
  section that already documents the lint.
- `docs/specs/afk-v2-plan.md` — §2e's #319 row and the §"Post-plan work" item
  3 now say which half landed and which is owed.

## The two design calls a reviewer should be able to reverse

**1. "Load-bearing" is a declared list of heading prefixes, not something
inferred from the sentence.** `loadBearingSections` names the sections whose
content instructs the implementer. The alternative — flag every line citation
anywhere in a ticket — was rejected on measured evidence, not taste: 47 of this
repo's 255 issues cite a line somewhere and only 15 do it under an instructing
heading. The other 32 are bug tickets whose "Suspected cause" / "Evidence"
citation is a dated observation about the tree at filing time, which is exactly
what it should be. Gating those would make the lint loudest where it is least
useful — the failure mode ADR 0049 refused a source parser to avoid.

The reversible part is the *contents* of the list. I excluded the hedged
sections ("Suggested fix", "Proposed fix", "Suggested direction", "Solution")
on the grounds that they say themselves they do not bind; someone could argue
that a "Proposed fix" citation is what the implementer actually reads. Adding
them costs 5 more citations across 3 tickets. I included "What to build",
which is where the largest single cluster lives (#264, 15 citations).

**2. It scans sections rather than criteria.** This departs from checks 2–4,
which run over `parseTicket`'s criteria. Two reasons from the corpus: none of
the citations that actually cost this repo were in a criterion (#86's were
under "Code anchors", #195's under "What to build", #87's in a scope-narrowing
addendum), and `parseTicket` recognises only `- [ ]` items, so a ticket that
numbers its criteria `1.` (#341) is invisible to checks 2–4. A test asserts
that gap and that check 6 does not share it.

Consequence worth knowing: **`parseTicket` still cannot see numbered criteria,
so checks 2, 3 and 4 silently do nothing on such a ticket.** That is a
pre-existing defect I found while measuring and deliberately did not fix —
widening `parseTicket` changes checks 2–4 across the whole corpus and deserves
its own issue and its own measurement.

## What I did NOT do, and why

**#319's acceptance criteria 3, 4, 5 and 7 are not done.** Those are: validate
that referenced files exist and named tests can be found before launch; repeat
it before resuming a preserved lock; refuse a stale lock before dispatch rather
than auto-editing it; and the four fixtures for those cases.

Three reasons, in the order they decided it.

*It does not belong in the lint, and the corpus proves it rather than suggests
it.* I built the resolver as a throwaway and measured it. Over the eleven
tickets currently prepared for launch, "every cited path must exist in the
tree" refuses **7 of 11**, on 20 of 26 cited paths — and almost every one of
those paths is correct as written. `issues.md`, `prd.md`, `contract.md`,
`afk.json`, `run-summary.md` are per-slice run artifacts, not repo files (they
are in this vocabulary's own `names` list for that reason), and
`src/run-events.test.ts` in #336 is a file that slice creates. The lint cannot
tell a repo path from an artifact name from a file about to be written. The
information that settles it is the manifest's `fileScope` — a cited path
*outside* `fileScope` that does not exist is stale; one inside it may
legitimately not exist yet — and that lives with the locked pair, not with the
ticket. The ADR amendment records this so it is not rediscovered.

Symmetrically: there are **zero** `describe(...)`/`it(...)` citations under a
load-bearing heading in all 255 issues, so a test-title resolver would have had
nothing to verify today. Check 6 is what creates the corpus a resolver would
later check.

*The call site is unverifiable under tonight's constraints.* The two candidate
sites are the preserved-`LOCKED` read-back in `negotiateAttempt` (which already
refuses a lock it cannot validate, by *returning an outcome* — `lockRefusedByGate`
/ `refuseInvalidManifest` — not by throwing) and the pre-dispatch manifest read
in `runSliceExecute` (which throws, and whose outer catch turns it into
`phase: "ERROR"` with the tree kept). Both live in `src/orchestrator.ts`, whose
tests are in the heavy orchestrator suite, and an AFK self-run held this host
tonight — heavy suites were forbidden. A refusal at the single choke point
every generator dispatch passes through is the last thing to ship unverified: a
false positive there breaks every run.

*It would have collided.* `fix/284-drop-contract-view` and
`fix/320-guardian-finding-reconciliation` both touch `src/orchestrator.ts`.
This branch touches none of the files any of the four branches that landed
tonight touch — verified with `git diff --name-only main...origin/<branch>` for
all four. Zero overlap.

On the `PreflightCheck` question in the brief: neither refusal I would have
written belongs in `src/preflight.ts`. `--preflight-report-only` downgrades
every finding-based refusal to a warning (`refuse = request.reportOnly !== true
&& …`), and a stale *locked* contract must not be bypassable by a report-only
flag — the whole point of #319's fifth criterion is that the run stops. It
belongs as a fail-closed refusal at the lock read-back or the pre-dispatch
read. Recorded here so the next agent does not have to re-derive it. Check 6
itself is not a preflight concern at all: it gates a ticket, not a tree, and
`pnpm lint:tickets` is already the before-launch entry point.

## Verification — exact commands and outcomes

An AFK self-run held this host, so per the task's hard rules no full `pnpm
test`, no `pnpm test:fast`, and no `pnpm run test:heavy:*` was run.

| Command | Outcome |
|---|---|
| `pnpm run typecheck` | pass, no output (`tsc --noEmit`) |
| `pnpm vitest run src/lint-tickets.test.ts` | 67 passed, 1 file, 401 ms |
| `pnpm vitest run src/eval-packs.test.ts` | 22 passed — it asserts on the literal `"AGENTS.md:74-77"` in a committed eval pack, so the `AGENTS.md` edit had to be checked against it |
| `node scripts/lint-tickets.mjs --dir <corpus> 277 278 299 300 303 304 332 333 334 335 336` | exit 0, "0 gating" — none of the eleven prepared tickets gates |
| `node scripts/lint-tickets.mjs --dir <corpus> 86` | exit 1, 7 gating findings, one per citation, each quoting its line |
| `checkLineCitations` over all 255 issues (`gh issue list --state all`) | 15 tickets, 50 findings: #85 #86 #87 #91 #96 #132 #168 #195 #261 #262 #263 #264 #289 #292 #341 |

**Red-on-old-code evidence**, twice:

1. Narrow. Removing only the backticked-continuation shape from
   `LINE_CITATION` and running
   `pnpm vitest run src/lint-tickets.test.ts -t "continuation"` fails with
   `Expected ":169" / Received [ "src/candidate-gate-phase.ts:86" ]` at the
   `lineCitationsIn` assertion. Restored.
2. Wide. `git checkout HEAD~1 -- scripts/lint-tickets.mjs
   ticket-lint-vocabulary.json ticket-lint-waivers.json`, keeping the test
   file, fails 15 tests: every `sectionsOf` / `isLoadBearingSection` /
   `lineCitationsIn` / check-6 case with `is not a function`, plus
   "declares load-bearing sections in the form the matcher compares" with
   `Cannot read properties of undefined`. Restored; `git status` clean.

`src/orchestrator.test.ts`'s B-05 assertion reads `--test-command "…"` out of
both `AGENTS.md` and `CLAUDE.md` by regex on the first match. The inserted
`AGENTS.md` paragraph contains no `--test-command`, and it sits above the code
block, so the first match is unchanged. I could not run that heavy file to
prove it; verified by reading the assertion instead.

## Still owed

- **The full `pnpm test`.** Not run: an AFK self-run held the host.
- `pnpm run test:heavy:orchestrator`, for the `AGENTS.md` B-05 assertion above.
- #319 acceptance criteria 3, 4, 5 and 7 (lock/resume anchor resolution and its
  fixtures), for the reasons above. The plan row and the ADR amendment both say
  so, so the roadmap does not read as if #319 is closed.
- Not opened as a PR, not merged, no GitHub comment posted, per the task.
