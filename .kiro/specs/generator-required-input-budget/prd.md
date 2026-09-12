# Generator required-input budget

Parent PRD: #271.

## Problem Statement

AFK limits the generator's assembled inline prompt to 65,536 bytes, but the
limit stops measuring required generator context when an authoritative
artifact travels by worktree path. A file then counts as zero even when the
prompt requires the generator to read it in full before writing code.

PRD 5 slice #87 exposed both sides of the problem. Its accepted contract and
acceptance manifest made the inline prompt 72,040 bytes, so dispatch failed
before the generator ran. Moving that pair to worktree references unblocks
dispatch, but it does not reduce the required content the generator receives.
The current budget therefore confuses transport size with the context load it
is intended to bound.

The 65,536-byte value is also not a calibrated deliverability threshold.
Slice #87 locked with 24 behaviors, while PRD 7 slice #262 delivered 36
behavior IDs in one generator round. AFK needs a larger, explicit
generator-only limit based on all required initial input, without adding a
behavior-count gate or forcing accepted contracts to discard detail.

## Solution

Replace the generator's inline-only limit with a 96 KiB required-input budget.
Required input is the assembled inline prompt plus the UTF-8 byte size of each
worktree artifact the generator is explicitly required to read in full.

Worktree references remain the preferred transport for authoritative files,
but references no longer make those files free for budget purposes. AFK counts
each required artifact once, reports inline and referenced weights separately,
and fails prompt preparation before dispatch when their total exceeds 98,304
bytes.

The limit is a deterministic lower bound on required starting context. It does
not attempt to predict provider tokenization or budget every later,
agent-chosen tool read. When the required input exceeds the limit, the operator
must remove real duplication or split the slice into two or more independently
deliverable slices.

## User Stories

1. As a pipeline operator, I want required worktree reads included in the
   generator budget, so that moving content from the prompt to a file does not
   hide the context load.
2. As a generator, I want authoritative contract artifacts to remain available
   by stable worktree path, so that the prompt does not duplicate files I can
   open directly.
3. As a pipeline operator, I want a 96 KiB generator limit, so that demonstrated
   large slices can dispatch without treating the old 64 KiB value as a
   calibrated context-rot threshold.
4. As a babysitter diagnosing a refusal, I want separate inline, referenced,
   total, and per-artifact byte weights, so that I can tell whether duplication
   or slice size caused the failure.
5. As a maintainer, I want initial and repair rounds to use the same budget
   meaning, so that a referenced contract pair cannot consume unrecorded repair
   room.
6. As a project maintainer, I want existing budget overrides to remain
   stricter-only, so that a project can choose a smaller context allowance
   without bypassing AFK's upper bound.
7. As a contract author, I want AFK to preserve required behavior and evidence
   when the budget is exceeded, so that the pipeline fails closed instead of
   silently shortening an accepted contract.

## Implementation Decisions

- Define the generator budget as required-input bytes: assembled inline prompt
  bytes plus required referenced artifact bytes.
- Set the generator default and maximum to 98,304 bytes. Existing overrides
  may lower this value but may not raise it.
- Count the exact UTF-8 content AFK requires the generator to read from each
  materialized artifact. A missing or unreadable required artifact is a
  configuration failure, not a zero-byte reference.
- Count one logical artifact once. Do not add a second referenced weight when
  the same content is already included inline.
- Apply the total to both initial and repair prompt preparation. Calculate
  repair evidence room only after reserving both fixed inline content and
  required referenced content.
- Record the assembled inline weight, required referenced weight,
  required-input total, allowed total, and per-artifact weights in prompt
  assembly evidence and overflow diagnostics.
- Keep authoritative contract artifacts by reference. This PRD follows the
  generator pair-by-reference fix; it changes that fix's budget accounting,
  not its transport rule.
- Keep the existing fail-closed rule: required contract, manifest, findings,
  and repair evidence are never silently omitted or truncated to fit.
- Make no change to other role budgets. A later proposal needs its own evidence
  before applying required-input accounting elsewhere.
- Add an ADR that records the new budget meaning and supersedes only the
  inline-only budget interpretation in the prior by-reference decisions.

## Testing Decisions

- Use the existing context-envelope unit seam. Do not add a spawned pipeline
  scenario.
- Cover initial and repair generator envelopes.
- Prove that the exact 98,304-byte boundary passes and one byte over fails
  before dispatch.
- Prove that required referenced artifacts contribute to the total and that
  the same artifact is not counted twice.
- Prove that a missing or unreadable required artifact fails closed.
- Prove that overflow evidence reports inline, referenced, total, allowed, and
  per-artifact byte weights.
- Prove that a stricter project override lowers the effective limit and cannot
  raise it.
- Prove that repair-room calculation reserves the required referenced weight.
- Keep prompt-template and evidence-schema assertions at their existing unit
  seams where the additive fields change those contracts.

## Out of Scope

- Changing planner, explorer, evaluator, cleaner, hardener, remediator, or
  guardian budgets.
- Treating behavior count as a deliverability threshold.
- A contract-lock gate for pair size or behavior count.
- Automatically splitting a slice.
- Asking the planner to shorten required behavior or evidence.
- Summarizing, truncating, or dropping authoritative artifacts to fit.
- Predicting provider token counts or bounding agent-chosen reads after
  dispatch.
- Shipping the separate #161 CLI and configuration surface for budget
  overrides.
- Reversing the generator pair-by-reference transport change.

## Dependencies and Sequencing

Land the generator pair-by-reference fix in #270 first. This PRD then makes the
two required referenced files consume generator budget and replaces the
generator's 65,536-byte inline ceiling with the 98,304-byte required-input
ceiling.

This work follows `docs/PRODUCT.md` principles 3 and 5: frame agents with only
the context they need, and turn observed failures into measured evidence. Its
source decision is `.kiro/specs/generator-required-input-budget/intent.md`.
