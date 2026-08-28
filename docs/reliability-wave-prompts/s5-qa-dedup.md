# Wave session s5 — QA-dedup, fail-closed (plan §3 item 9)

You implement one reliability-wave item for the AFK pipeline, by hand, in your
own worktree. This is plan §3 item 9: stop QA from re-running a suite the
base gate just ran. Saves a measured ~13 minutes per QA round, starting with
the next PRD run.

## Setup — base branch matters here

#79 (PRD 1 slice 5) rewrote the QA-orchestration code this session touches.
Check whether PRD 1's feature branch is on main before you branch:

```
git -C C:\Code\afk merge-base --is-ancestor feat-codex/afk-v2-evidence-backbone main; echo $LASTEXITCODE
```

- Exit 0 (PRD 1 merged): base on main —
  `git -C C:\Code\afk worktree add ..\wave-s5-qadedup -b wave/qa-dedup main`
- Otherwise: base on the feature branch —
  `git -C C:\Code\afk worktree add ..\wave-s5-qadedup -b wave/qa-dedup feat-codex/afk-v2-evidence-backbone`
  and confirm the two `followup/s05-*` branches are already merged into it;
  if they are not, stop and report — assembly is not done and this session
  would conflict with it.

Work only inside that worktree.

## Read first

- `C:\Code\afk-v2-run\docs\specs\afk-v2-plan.md` — §3 item 9
- `C:\Code\afk-v2-run\docs\specs\afk-v2-plan-debate.md` — item 9 and its guards
- `C:\Code\afk-v2-run\docs\specs\afk-v2-recovery-plan.md` — Phase D step 14 (this design, named there first) and Runs 4–6 evidence (QA r1 ran the full suite at 772.5 s on the same tree a base gate had tested at 739.3 s; run 3's QA r2 already passed safely on base-gate evidence with 34 s of commands — the intended pattern)
- `C:\Code\afk\docs\adr\0012-evaluator-qa-runs-sanity-command-set.md` — the policy you are amending
- `prompts\evaluator-qa.md`, `src\orchestrator.ts`, `src\artifacts.ts` in your worktree
- `AGENTS.md` in your worktree — test discipline

## Task

1. At QA dispatch, the orchestrator injects into the QA prompt: the base-gate
   evidence (which gates passed, when) plus the exact tree sha it was
   produced on, phrased as an explicit, citable skip authorization.
2. Fail closed: the authorization is valid only when the sha exactly equals
   the tree under review. On any mismatch, QA re-runs the gates — today's
   behavior, strictly no worse.
3. The QA verdict artifact records the citation (evidence ID + sha) when the
   skip is used, so the skip is auditable.
4. Amend ADR 0012 in the same change — the amendment lands WITH the
   mechanism, not after. This is orchestrator-asserted deterministic
   evidence, not agent self-certification; keep that distinction in the ADR
   text.
5. This is the interim until PRD 4's #96 (exact-tree reuse) subsumes it.
   Note that in the ADR amendment.
6. Tests per the assertion-placement rule in AGENTS.md: unit-test the
   sha-match decision and the citation recording; avoid new spawned
   scenarios.

## Constraints

- A live AFK run may be executing in `C:\Code\afk-v2-run`. Never touch that
  checkout, its `.afk\` directory, or its tests.
- Tests: `pnpm test:fast` plus the heavy suites your change touches (QA
  orchestration lives in `test:heavy:qa-orchestration` — check the file
  headers). Do NOT run the full `pnpm test`; the wave merge gate owns it.
- Commit on your branch. Do not merge or push to main.

## Handoff

Report: branch name, files changed, the citation format, and what you
verified.
