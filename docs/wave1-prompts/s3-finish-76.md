# S3 — finish #76 by hand (Wave 1)

Finish slice #76 of PRD 1 manually — the AFK run was stopped mid-slice and
we are completing it outside the pipeline.

Working directory:
`C:\Code\afk-v2-run\.afk\worktrees\afk-codex-afk-v2-evidence-backbone-s02`
(branch `afk-codex/afk-v2-evidence-backbone-slice-02-*`, 5 commits at
c58a93b, protected by tag `rescue/76-c58a93b`). Read AGENTS.md there first.

The spec is the slice's own artifacts, copied to
`C:\Code\afk-v2-run\.afk\artifacts\afk-v2-evidence-backbone-codex\stop-harvest-20260826\slice-02\`
— contract.md is the authoritative scope (respect its file list),
handoff.md records what the generator finished and what remains. Also read
the GitHub issue (`gh issue view 76 --repo EricOliveira90/afk-pipeline`)
for acceptance criteria.

**Time warning:** this worktree's branch predates the 2026-08-26 test-suite
work on the tool repo. The full suite here still costs about 14 minutes,
has no budget gate, and is not hermetic — host git hooks run in its
fixtures. Budget the handoff step accordingly; the one-full-suite-at-a-time
rule matters most for this session.

Rules:

1. Stay inside the contract's "Files expected to change" list. If the
   remaining work genuinely needs a file outside it, stop and ask the
   human — do not expand scope silently and do not revert existing work
   to satisfy the boundary.
2. Verify with `pnpm test:fast` plus the heavy suites your changes touch;
   run the full `pnpm test` once when you believe the slice is done. Only
   one session may run the full suite at a time on this machine — ask the
   human first. All green before handoff.
3. Commit in small conventional commits on the slice branch. Do not merge
   anywhere; do not touch run state or other worktrees.

Hand off with: what you implemented, the full-suite result, and the exact
merge command for the human to run against
`feat-codex/afk-v2-evidence-backbone`. Also: run state has NO entry for
#76 at all (the stop wrote no cancellation record — issue #114). Read
`src/run-state.ts` and confirm whether adding
`"76": { "phase": "PASS", "mergedToFeature": true }` after the human
merges satisfies `isSliceComplete` so `--only-failed` stops selecting it.
Propose the exact JSON edit against the real state file schema; do not
apply it.
