# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

`pnpm install --frozen-lockfile` ran here and exited 0. `pnpm run typecheck` is
covered by the skip authorization (evidence artifact
`.afk/logs/afk-preserved-work-renegotiation-claude-code/run-20260914-231711/gates/s02/attempt-8e3cee1bb837.json`,
gate attempt `8e3cee1b-b837-4395-8670-a93cc45ed26c`, tree
`cc940a1469f279bc900f77430c1108d1c1b05ccc`) — but because I probed by editing
`src/preserve-work-recovery.test.ts`, I reverted the probe with
`git checkout --` and re-ran `pnpm run typecheck` myself: clean, no output.

Boundary: the change summary
(`.afk/artifacts/afk-preserved-work-renegotiation-claude-code/slice-02/change-summary.json`)
lists eight modified source files — `src/cli-options.ts`,
`src/cli-options.test.ts`, `src/run-state.ts`, `src/run-state.test.ts`,
`src/slice-scope.ts`, `src/slice-scope.test.ts`,
`src/preserve-work-recovery.ts`, `src/preserve-work-recovery.test.ts` — which is
exactly the contract's declared list, plus the slice's own spec artifacts. None
of #336's reporting surface (`src/run-events.ts`, `src/run-snapshot.ts`,
`src/status.ts`) was touched. No migration file. No scope amendment is needed.

Preservation: P-01 through P-05 each have assertions that would fail if the
behavior broke, and they pass. As a probe I ran the slice's four test files
(`pnpm vitest run src/cli-options.test.ts src/run-state.test.ts
src/slice-scope.test.ts src/preserve-work-recovery.test.ts`): **403 passed, 4
files passed, 31.7s.** `RUN_STATE_VERSION` is still 7 and no migration ships.
`resolveRunScope`'s narrow-only throw is asserted both before and after a
widening in `src/slice-scope.test.ts`.

The blocking defect is not a failing test — it is a behavior the tests cannot
reach, because the fixture's issue ids (`278`–`284`) are all larger than its
slice numbers (`07`–`14`), which is the one arrangement that hides it.

## Pass 2: Quality & Craft
- Convention compliance: NOT RUN
- Code quality: NOT RUN
- Test quality: NOT RUN

Pass 1 is not clean, so Pass 2 was not conducted. QA-03 below is a mechanical
observation made while reading the diff, not the output of a craft sweep.

## Resolved findings
- none (no findings were routed into this stage)

## Findings

### Finding 1 — Completion re-derives its revalidation selectors from `ghIssue`, so an unchanged, validly admitted set is refused and rolled back
**Severity:** Blocker
**Pass:** 1

**Evidence:**
`src/preserve-work-recovery.ts:2381` revalidates the admitted set by feeding
issue ids back in as selectors:

```ts
const additions = current.extensions;
const revalidated = resolveScopeExtensions({
  selectors: additions.map((entry) => entry.ghIssue),
  ...
```

`resolveScopeExtensions` accepts a selector that matches a slice by *either*
spelling (`src/preserve-work-recovery.ts:352-357`):

```ts
canonicalSliceNumber(slice.number) === wanted || slice.ghIssue === selector
```

So an addition admitted through its slice-number spelling is revalidated through
its issue-id spelling, and that spelling can match a second, different slice by
number — which is `extension-identity-conflict` (`:359-370`).

Probe (a temporary `describe` appended to `src/preserve-work-recovery.test.ts`,
run and then reverted with `git checkout --`). Declared slices
`[07/#277, 08/#278, 03/#9, 09/#15]`, `manifest: null`, fixture scope
`[{07,277},{08,278}]`:

```
$ pnpm vitest run src/preserve-work-recovery.test.ts -t "QAPROBE"
PROBE admitted extensions: [{"number":"3","ghIssue":"9"}]
PROBE completion result: {"completed":false,"code":"facts-changed-before-lock",
  "message":"The scope additions recovery attempt attempt-probe was admitted with
  no longer resolve to the same identities under the run-state lock
  (extension-identity-conflict); no COMPLETED event was appended and the run's
  persisted scope was not widened", "attemptId":"attempt-probe",
  "failure":{"trigger":"completion-cas-lost",...}, "rollback":{"rolledBack":true,...}}
PROBE trailing state: PENDING,ROLLED_BACK
PROBE scope: {"mode":"explicit","slices":[{"number":"07","ghIssue":"277"},
  {"number":"08","ghIssue":"278"}]}
 ✓ src/preserve-work-recovery.test.ts (174 tests | 173 skipped) 1024ms
```

`admit` accepted `--extend-scope 3` and recorded `{number:"3", ghIssue:"9"}` on
the `PENDING` event. `complete` was then handed the *same* slice list, the same
absent manifest and the same scope, with nothing interleaved — and refused.
Selector `"9"` matched slice `03` by `ghIssue` and slice `09` by number.

The shipped tests cannot see this: every `EXTENSION_SLICES` issue id is `278`
or higher while every declared slice number is `14` or lower, so no addition's
`ghIssue` can collide with another slice's number in that fixture.

**What the contract expected:**
B-07: "the set read **from the trailing `PENDING` event** — never from a caller
argument — is revalidated through B-02's resolver against the run state held
under the lock… A member that became invalid or is now present in persisted
scope is an admitted failure". B-08: "When the rechecks hold, that one locked
read-modify-write publishes one run-state document that both appends the
`COMPLETED` event … and appends the whole set to `state.scope.slices`."

**What I observed:**
With every fact unchanged since admission, the revalidation reports
`extension-identity-conflict`, the transaction returns `changed: false` with
`casLost: true`, and the attempt ends through `rollBackRecoveryAttempt` with
`facts-changed-before-lock` / `completion-cas-lost`. No `COMPLETED` event, no
widened scope. Nothing became invalid; the refusal is an artifact of the
identity being round-tripped through an ambiguous selector language. The trigger
condition — one slice's GitHub issue id equal to a different slice's slice
number — is the ordinary case whenever issue ids and slice numbers are offset by
a constant, as they are in a freshly filed PRD, so in such a repository
`--extend-scope` can never complete for any addition.

### Finding 2 — The absent-scope completion refusal is untested and misreports its own cause
**Severity:** Minor
**Pass:** 1

**Evidence:**
`src/preserve-work-recovery.ts:2386-2402` refuses when
`additions.length > 0 && locked.scope === undefined`, but composes its message
as `revalidated.ok ? "a different identity set" : revalidated.code`. With scope
absent the revalidation *is* `ok` — its view is `locked.scope?.slices ?? []` —
so the operator is told the additions "no longer resolve to the same identities
under the run-state lock (a different identity set)" when the real cause is that
the run has no persisted scope to widen. None of the three `REVALIDATION_CASES`
rows drives an absent scope, and `Select-String -Path
src/preserve-work-recovery.test.ts -Pattern 'locked.scope === undefined'` finds
nothing, so the branch could invert without a failing test.

**What the contract expected:**
B-07 names the refusal cause as a member that "became invalid or is now present
in persisted scope", and the code-not-prose rule at
`src/preserve-work-recovery.ts:101-108` asks each distinguishable cause to be
reported as itself.

**What I observed:**
A third, undocumented cause shares the identity-drift wording, and no assertion
covers the ending or the message.

### Finding 3 — Three edited test files lost their trailing newline
**Severity:** Minor
**Pass:** 1

**Evidence:**
```
$ foreach ($f in @('src/cli-options.test.ts','src/run-state.test.ts',
  'src/slice-scope.test.ts','src/preserve-work-recovery.test.ts',
  'src/cli-options.ts','src/slice-scope.ts')) {
    $b=[System.IO.File]::ReadAllBytes($f); "$f last=$($b[$b.Length-1])" }
src/cli-options.test.ts last=59
src/run-state.test.ts last=59
src/slice-scope.test.ts last=59
src/preserve-work-recovery.test.ts last=10
src/cli-options.ts last=10
src/slice-scope.ts last=10
```
`git diff feat-claude-code/afk-preserved-work-renegotiation..HEAD` prints
`\ No newline at end of file` for exactly those three files.

**What the contract expected:**
Nothing explicit — but every other file in `src/`, including the fourth test
file this slice edited, ends with a newline.

**What I observed:**
Three of the four edited test files end mid-line, so every future append to them
will render as a modification of the last existing line.
