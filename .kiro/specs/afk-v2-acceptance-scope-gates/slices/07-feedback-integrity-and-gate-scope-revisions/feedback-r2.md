# Contract feedback — Feedback integrity and gate-scope revisions (#193)

## What this contract already gets right

The scope lock reads as one story with one owner: a single waiver reader in
`src/afk-manifest.ts`, a single new in-process gate that consumes it, and one
journalling chain from gate evidence to run event to summary to run state. Most
of what a review of a slice this wide usually has to argue about is already
settled with repository evidence rather than intent:

- The four `GateFindings` fields the gate populates already exist at
  `GATE_EVIDENCE_VERSION = 3`, so the contract correctly declares
  `src/gate-runner.ts`, `src/post-qa-gates.ts`, `src/candidate-gate-phase.ts`,
  `src/base-gates.ts` and `src/gate-policy.ts` unedited instead of quietly
  reaching into them.
- The three unknowns the explorer left open that could have sunk a lock are
  each resolved with a named answer, not deferred: the deleted-test comparison
  base is the candidate source the `scope` and `tests:skipped` gates already
  take (worktree against `featureRef`, because the candidate is uncommitted at
  the post-QA site); `archivedScopeEscalations`' hand-rolled `parsed.version
  !== 1` check is owned explicitly by B-11 rather than assumed to upgrade
  itself; and gate-cache participation is ruled out in the non-goals with the
  reason (only the command path consults the cache).
- The two doors stay apart. `GATE-SCOPE` travels ADR 0052's existing
  focused-revision door, P-02 keeps the already-implemented refusal of an
  escalation for a path the worktree has already edited, P-03 keeps
  `MAX_SCOPE_REVISIONS_PER_ROUND` and the accepted-pair restore ahead of any
  escalation read, and the non-goals refuse both a second request channel and
  any "reconciliation" with ADR 0048's after-the-fact amendment.
- Version-as-schema-version is stated precisely in B-09: a version-2 document
  without `gateEvidence` is still an ordinary cited-finding or
  `PRE-BUILD-SCOPE` escalation, and `requireExactKeys` admits `gateEvidence`
  only at version 2. That is the reading `src/escalation.ts`'s exact-key check
  forces, and P-01 holds every version-1 rule in place beside it.
- Authorization is closed at both ends: B-06 makes a candidate-authored
  `afk.json` waiver worth nothing, and both B-03 and B-15 state that declaring
  a path in the contract's `fileScope` authorizes nothing.
- Every behavior's gates are drawn from the executable catalog (`typecheck`,
  `tests`); nothing leans on `lint`, which is not executable here.

## What has to change before this can lock

**The value inside `gateEvidence.evidenceArtifactId` is undefined, and the
sources disagree.** The contract constrains it only to a non-blank string.
prd.md D22 calls it the evidence sha256; the slice anchors correct that to the
repo-relative, forward-slashed evidence path already computed at
`src/candidate-gate-phase.ts:132-135`, precisely so a `GATE-SCOPE` citation
points at the same `gate-outcome` event an operator can look up. A generator
can satisfy this contract from either reading, and the two produce different
parser validation, different prompt bytes in the three generator-facing sources
B-16 rewrites, and a different STUCK diagnosis in B-11. Name the form in B-09,
teach that same form in B-16's version-2 literal, and bind the cross-reference
with a test that asserts the cited id equals the failing gate's
`gate-outcome` `evidenceArtifactId`. This is the citation's only reason to
exist; leaving it to the implementer is the one thing here that cannot be
fixed after the lock without re-cutting the prompts.

## Smaller things worth fixing while you are in here

- B-07 requires `detail` to say which risk class the policy suppressed, but its
  observable result asserts only the PASS and the FAIL. As written a generator
  can pass the declared test while the catalog stays silent about what it
  stopped enforcing — which is the entire justification the behavior gives for
  itself. Also worth confirming that a non-failing outcome carries `detail` at
  all; the two gates named as models populate it on their failure paths.
- B-08 presents `acceptedPairIntact: false` as a run outcome. It is not one
  today: `src/orchestrator.ts:5305-5407` archives, restores and throws on a
  mutated pair, and sets `acceptedPairIntact = true` only after that check
  passes, so the value arriving at the post-QA declaration site is always
  `true`. Keep the fail-closed property — say plainly that it is a module-level
  defence, so nobody builds plumbing to reach it.
- B-03 pins `src/qa-orchestration.test.ts` lines 1075, 2287 and 2436. Identify
  those assertions by the list literal they assert or by their enclosing test
  names; a line number that has drifted reads at gate time as either a missed
  assertion or an unexplained edit.
- The journalling chain de-duplicates in one place only. `saveAppliedWaivers`
  ignores a repeated `riskClass` + `path`, but a second post-QA phase in the
  same run re-reads the same evidence and emits the `waiver-applied` events
  again, and `## Applied Waivers` renders from the events — so the summary can
  list a waiver several times while run state holds one record. Say which side
  suppresses the repeat.

## Feasibility

The slice is large — seventeen new behaviors across a new gate module, a
manifest parser, an escalation schema bump, a run-state version bump, the
skip gate, the logger, the orchestrator and four prompt-facing files. It is
still a single session's work because almost none of it is discovery: each
piece has a named existing pattern to copy (`src/scope-gate.ts` for the gate,
`saveFiledFindings` for the writer, `adaptLoadedState`'s accept-1|2|3
return-4 shape for the bump, `src/run-state.test.ts`'s older-literal-version
fixture for its test), and the test plan honours the repo's cost discipline by
adding `it`s to the existing spawned escalation scenario instead of new
spawns. The recommended order is waiver reader first, then the gate, then the
journalling chain, then the escalation schema and prompts, since every later
piece reads the earlier one's types.
