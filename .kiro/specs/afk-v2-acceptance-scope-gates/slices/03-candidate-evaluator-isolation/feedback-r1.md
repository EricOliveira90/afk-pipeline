# Contract feedback — round 1

## What this round settled

Most of the carried-in argument is over. The seed manifest is the right shape
of answer: recording the orchestrator's own writes at write time, as a set
explicitly distinct from the copy-back allowlist, makes the seeded pair
invisible to the violation scan by construction rather than by coincidence,
and the amendment attempt now has an assertion that it emits no violation for
`contract.md` or `acceptance-manifest.json`.

Abandoning the tree-object diff was also right, and the contract says why in
the text rather than leaving a reader to work it out: an index-built tree
cannot see an ignored path, and everything interesting here lives under a
gitignored root. Restating the refusal of an evaluator-authored
`approved-baseline.json` as a consequence of a positive copy-back allowlist —
so it holds whatever the scan sees — is stronger than the previous
formulation and does not depend on the scan at all.

The dependency questions from the last attempt are discharged:
`resolveCandidateTreeId` is now cited only as the mechanism being rejected,
the gate evidence artifact ids come from a callback the orchestrator already
receives, and `src/candidate-gate-phase.ts` is in the file scope regardless.
The copy-back enumeration matches its regex including the `uat-*` forms and
says in one clause why it, not `allowedWriteScope`, is the enforcement
surface. P-01 names a real counter and the control-flow reason it is skipped.
The logger observable reads the artifact under test. And the scope lock now
states an ordering — the B-01 → B-04 mechanism first, the two records next,
the reporting tail last — so a long session degrades to something narrower and
whole.

## What still blocks the lock

The mechanism changed but its seam did not get the same treatment the last
round's dependencies got. B-04 needs a porcelain status read that reports
ignored paths under `.afk/`, and B-05 needs commits, changed files and diff
stats between two refs. Neither is among the git functions the exploration
established as available — that evidence covers the worktree lifecycle
helpers and `diffTreePaths` — and B-01 declares `src/git.ts` out of scope on
the strength of "the four helpers this needs are already exported", which
speaks only to the worktree lifecycle.

The phrasing compounds it. "Run in-module through the already-imported
`git.js` seam the way `src/post-qa-gates.ts:4` does" points two ways at once:
in-module suggests the orchestrator issuing its own `git` reads, which is in
scope and has a precedent in this repo; through the `git.js` seam suggests
calling functions in `src/git.ts`, which is not in scope and, on the declared
evidence, would require new ones. With a file-scope gate shipping in this same
PRD, that ambiguity is what forces an out-of-scope edit mid-slice. Pick the
seam and, if it is `src/git.ts`, put the file in scope with the new primitive
named as a behavior. B-05's "pure" builder needs the same clarity: a builder
that returns diff stats reads git somewhere, and the contract should say
where.

Two smaller things worth fixing while you are in there. B-02's observable
asserts that the seed manifest "lists exactly the two pair paths", but nothing
in the contract exposes that set to a test — it is described only as
in-memory. Either name the surface or lean on the no-violation consequence
B-04 already observes. And B-08's observable drops the discard-instruction
clause its own `then` promises, then puts a static prompt string-match in
`src/qa-orchestration.test.ts`, which is the one place the contract's own
assertion ladder says such a check should not go.
