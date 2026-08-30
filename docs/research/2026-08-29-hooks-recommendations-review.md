# Review: hooks-for-AFK-v2-governance proposals

Review date: 2026-08-29. Reviewer: adversarial second-pass over (a) the
research document `docs/research/2026-08-29-hooks-in-ai-pipelines.md` and
(b) six proposals for using in-session agent hooks to improve AFK v2
pipeline governance. Load-bearing citations were re-verified against
primary sources; enforcement claims were checked against how AFK actually
invokes its providers (`src/claude.ts`, ADR 0011, `src/git.ts`,
`src/gate-runner.ts`).

---

## Verdict up front

Adopt none of the six proposals now. The research document is good; the
recommendations built on it transplant a mechanism from a context that
needs it (interactive tools with no verification boundary) into one that
doesn't (AFK, which already treats the agent session as untrusted and
re-establishes truth orchestrator-side at every round boundary). One idea
survives in a different, simpler shape — as a gate, not a hook. The rest
should be recorded as re-open triggers, plan-§6 style.

## The architectural objection the recommendations miss

The core claim — "industry governs at tool-call granularity, AFK governs
at round granularity, therefore gap" — reads the comparison backwards.
Cursor and Claude Code need in-session hooks because there is nothing
*after* the session: the human accepts the session's output directly, so
the tool-call boundary is the only enforcement point available. AFK's
design assumption is the opposite: the worktree is untrusted, and
everything that matters is verified from outside it — gates run on the
committed tree in a detached worktree the orchestrator creates
(`gate-runner.ts:218`), scope lock refuses undeclared files (#75,
merged), the QA evaluator re-verifies (ADR 0012), and the pre-ship gate
runs the full suite on the merged branch. Mid-round misbehavior that gets
reverted before commit deceives only the generator itself; misbehavior
that reaches a commit hits the scope and gate wall.

So the "gap column" is not a safety gap. It's at most a *cost* gap — a
burned round is expensive feedback. But the plan's own measured evidence
says where the minutes actually went: evaluator re-reading
(22.7–30.3 min/round), duplicated QA suites (~13 min/round), redundant
full-suite runs (~35 min in one generator round). Items 2, 5, and 9
attack that directly. In-round hooks attack a round-burn class with zero
recorded instances.

## The evidence test

Would any proposed hook have prevented any recorded incident? Going down
the list — #111 (stale error text), #112 (contract-amendment gap), #113
(restart destroyed commits), #114 (Windows stop bypass), #120
(misclassification), #121 (crash bookkeeping): **no**. All six are
orchestrator-side truth/classification defects; all six are already
fixed. The one hook-shaped incident in the repo's history runs the other
way: ADR 0011 records a third-party SessionStart *hook* silently
hijacking both guardian agents, and the fix was `--bare` — turning the
hook ecosystem *off*. AFK's only empirical experience with in-session
hooks is as an attack surface, not a control surface.

The debate's joint finding — "the pipeline does not lack checking; it
lacks memory of checking already done" — was earned by two adversarial
agents converging on the same evidence. These proposals add a fourth
checking surface (prompts, gates, orchestrator, now per-provider hooks).
That's a re-litigation of the settled finding without new evidence, and
it also brushes a cut item: hook config assembled per provider is exactly
the per-provider variance the deferred story 16 fence (ADR 0002: assembly
stays provider-agnostic at the interface) exists to prevent. The
recommendations acknowledge the fence and then propose the branching
anyway.

## Enforcement reality check (verified, not from the research doc)

This is where the proposals lose even on their own terms, checked against
primary sources and AFK's actual provider invocations:

1. **AFK runs Claude workers with `--dangerously-skip-permissions`**
   (`src/claude.ts:112,128`). Anthropic's own hooks doc says the `if`
   matcher is best-effort and to "use the permission system rather than a
   hook to enforce a hard allow or deny" — the permission system AFK's
   flag disables. Under bypass mode there are multiple open Claude Code
   bugs directly on point: PreToolUse hooks firing but not blocking
   ([anthropics/claude-code#20946](https://github.com/anthropics/claude-code/issues/20946)),
   hooks silently ceasing to take effect mid-session
   ([#47810](https://github.com/anthropics/claude-code/issues/47810)),
   and — fatal for proposal 1's `ask` verb — **`ask` being silently
   auto-approved under bypassPermissions while only `deny` blocks**
   ([#77212](https://github.com/anthropics/claude-code/issues/77212)).
   `ask` is also architecturally wrong for AFK: there is no human at the
   terminal; escalation is the courier channel (§3c policy 1), which a
   hook cannot reach. It would stall or self-approve.

2. **The self-reference guard in proposal 1 is unsound.** Claude Code's
   settings precedence lets a *project* `.claude/settings.json` set
   `disableAllHooks` over user settings, and the settings file-watcher
   picks up edits live — so an agent can kill worktree-assembled hooks
   with one settings write. A ConfigChange-blocking hook guarding that
   lives in the same mutable config: circular. The only tamper-proof
   level is machine-wide managed policy, which would leak AFK's deny
   rules into the operator's own interactive sessions and every other
   project on the machine — a standing cost the proposal doesn't price.
   And even with settings locked, hook *scripts* referenced by
   `${CLAUDE_PROJECT_DIR}` paths sit in the agent-writable worktree.
   Gemini's fingerprinting doesn't help; Gemini isn't a backend.

3. **Coverage across actual backends is worse than "Codex is the
   exception."** The backends are Kiro, Claude, and Codex. Codex: no
   hooks, conceded. Kiro: hooks exist but live in workspace-level
   `.kiro/hooks` — agent-writable, no managed tier. Claude: contested
   under the exact flags AFK passes (above), stripped entirely for
   guardians by `--bare` (ADR 0011), and there's an unverified landmine
   on top: project-scoped hooks are gated on workspace trust, each slice
   worktree is a fresh never-trusted path, and headless `-p` runs don't
   count as accepting trust — the whole dispatch-time assembly seam may
   silently no-op. So the honest coverage statement is: **one of three
   backends, partially, with open reliability bugs, fail-open by
   default.** The orchestrator-side gates aren't just the parity floor;
   they're nearly the whole building.

## Proposal-by-proposal, in the plan's vocabulary

Ratings are L/C/E/R (Leverage / Cost, higher = costlier / Evidence /
Reversibility, 1–5), matching plan §3.

| Proposal | L/C/E/R | Recurring cost | Verdict |
|---|---|---|---|
| 1. Risk-catalog PreToolUse deny/ask | 2/3/1/4 | per-provider config assembly per dispatch; per-tool-call spawn (expensive on Windows) | **Cut.** `ask` broken under bypass; self-reference guard unsound; zero recorded incidents; scope lock + gates already cover the commit boundary. Re-open trigger: first recorded in-session destructive-git or config-tamper incident *that reached a merge or burned a round*. |
| 2. Stop hook running derived verification | 1/3/2/4 | duplicate verification run at every healthy stop — **adds minutes to the happy path**, violating the plan's headline constraint | **Cut.** #120's cause was the launch command + misclassification, both fixed; item 2 kills the class at derivation; evaluator-QA and pre-ship already make it unskippable, provider-agnostically. Residual (agent ignores instruction *and* item 2's derived loop): unobserved. |
| 3. Migration-prefix write-time hook | 2/2/1/5 | per-write matcher eval | **Cut.** Drift mode never observed; ADR 0028 catches it deterministically. If it ever occurs, the fix is a changed-tree *gate* (migration filenames vs. manifest claim) — provider-agnostic, no hooks. |
| 4a. Pre-read deny on `.env`/keys | 1/2/1/4 | per-read | **Cut.** Slice worktrees are fresh checkouts of *tracked* files; gitignored `.env` files don't exist in them. The threat mostly doesn't exist in AFK's architecture. |
| 4b. Pre-write secret scan | 3/1/2/5 *as a gate* | seconds on changed tree | **Transform, don't adopt as hook.** A gitleaks-style cheap changed-tree gate in the gate catalog rides item 2's derivation, covers all three backends identically, feeds existing evidence/classification. Ship only when a consuming project actually handles credentials; for self-runs, defer. |
| 5. PostToolUse JSONL auditor | 2/3/2/4 as hooks | one process spawn per tool call, hundreds/round, on the machine where spawn cost ate 45% of suite runtime | **Replace with zero-build alternative.** AFK already parses provider JSON streams (ADR 0004) — the tool-call record exists in captured logs. If a question ever needs a tool-call audit, harvest it from the stream, one implementation, all providers. Failure-tagging-at-capture is already items 13–14 + ADR 0031. |
| 6. Per-edit typecheck/lint | 1/5/1/4 | 3.3–3.8s typecheck × dozens–hundreds of edits per round | **Cut hard.** Flatly violates "nothing adds minutes to the happy path" — this is the anti-pattern the debate spent a whole section killing. |

## Research doc quality

Better than most: spot-checks of Cursor's `failClosed` / `loop_limit` /
project-hook claims and Claude Code's exit-2 / `ask` / 8-cap / fail-open
semantics against the vendor docs all held, including the honest
fail-open warnings. Three flaws:

- **The single most load-bearing fact for AFK is absent**: the
  `bypassPermissions` interaction. The doc describes hook semantics for
  interactive sessions; AFK runs `-p --dangerously-skip-permissions`,
  where the semantics are demonstrably different and buggy. Any future
  research feeding this decision must test claims under AFK's actual
  invocation mode.
- **The portability headline is overstated.** Only the stdin-JSON /
  exit-2 convention is shared; matchers, config locations, working
  directories, and trust models all differ. "Hooks written once port
  across three agents" is true for the easy 20%.
- **Liquibase's "validating AI-generated SQL" is vendor marketing**
  cited as practice evidence. Fine as an existence proof of the pattern
  (which ADR 0027/0028/0034 already prove internally anyway); it
  shouldn't carry weight.

## Recommendation (the simple version)

1. **Adopt nothing from the six now.** Record two §6-style triggers in
   the plan:
   - (a) An in-session destructive-git or config-tamper incident that
     reaches a merge or burns a round → revisit pre-action gating,
     preferring structural options (command allowlist / sandbox, the
     SWE-agent/Codex direction the research itself flags) over hooks,
     since those don't depend on per-provider hook fidelity.
   - (b) A concrete question that invocation-level evidence can't
     answer → derive a tool-call audit from the ADR 0004 stream logs
     already captured; build no new in-session machinery.
2. **Keep one sentence of principle** wherever §3c lives: *deterministic
   in-round checks belong in the gate catalog, not in provider hook
   config* — one implementation, three backends, existing evidence
   trail. The secret-scan gate is the first candidate if a consuming
   project ever warrants it.
3. **Take the research's one genuinely transferable lesson**: fail-open
   guardrails that die silently. AFK's gates already fail closed; keep
   it that way when item 12 makes some advisory.

The originating session's diagnosis ("the risk catalog is prompt text")
is fair, but the plan already routes its structural half through PRD 4
item 12 declarations — the fix is landing there, not in a fourth
enforcement surface with the weakest reliability story of the four.
