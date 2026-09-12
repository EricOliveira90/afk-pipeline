# Generator required-input budget

## Intent

Prevent a generator agent invocation from receiving an unbounded required
context while allowing the large, demonstrated slices that current providers
can complete.

The existing 65,536-byte generator limit measures only the assembled inline
prompt. A contract or acceptance manifest that travels by worktree path counts
as zero bytes even when the prompt requires the generator to read that file in
full. That fixes prompt preparation, but it does not control the context load
that the budget exists to limit.

## Evidence

- PRD 5 slice #87 locked successfully, then failed before generator dispatch
  because its assembled prompt was 72,040 bytes against the 65,536-byte limit.
- The prompt contained a 34,593-byte generator contract view and a
  29,377-byte acceptance manifest.
- The preserved pair contains 24 behavior IDs. Nothing in negotiation or
  contract evaluation found the slice undeliverable.
- PRD 7 slice #262 completed 36 behavior IDs in one generator round. A useful
  generator limit must therefore permit more required input than the current
  65,536-byte inline threshold.
- ADR 0062 and ADR 0066 move contract pairs to worktree references and retain
  the 65,536-byte limit. That decision solves inline prompt growth but does not
  count required file reads.

## Decision

1. The generator has a 96 KiB required-input budget.
2. Required-input size includes:
   - the assembled inline generator prompt; and
   - the byte size of each required artifact that travels by worktree
     reference and that the generator must read.
3. The same artifact is counted once. Content already present inline is not
   counted again as referenced content.
4. Worktree references remain valid transport. They do not make required
   context free.
5. Project overrides remain stricter-only. They can lower the 96 KiB generator
   budget but cannot raise it.
6. Other role budgets and semantics do not change.
7. When required generator input exceeds 96 KiB, prompt preparation fails
   closed with separate inline and referenced byte totals and a per-artifact
   breakdown. AFK does not silently omit or truncate the locked slice contract,
   acceptance manifest, or unresolved findings.
8. The operator then removes real duplication or splits the slice into two or
   more smaller slices. AFK does not use a behavior-count threshold and does
   not ask the planner to shorten required behavior.

This decision supersedes only ADR 0062 and ADR 0066's implication that moving
required content to a worktree reference resolves the budget concern. Their
by-reference transport and evidence rules remain valid.

## Scope

- Define and enforce the generator required-input measurement.
- Raise the generator's default limit from 65,536 bytes to 98,304 bytes.
- Include required referenced artifact bytes in generator evidence and
  configuration failures.
- Preserve current generator initial and repair envelope behavior, including
  stricter overrides and bounded repair evidence.
- Add an ADR that records the new budget meaning and its relationship to ADR
  0062 and ADR 0066.

## Out of scope

- Changing planner, explorer, evaluator, cleaner, hardener, remediator, or
  guardian budgets.
- A behavior-count limit.
- Automatic slice splitting.
- Automatic summarization of authoritative artifacts.
- Provider-specific context-window calculations.
- Shipping the separate #161 CLI or AFK manifest budget setters.

## Verification seam

Use the existing context-envelope unit seam. A generator envelope must report
and enforce one required-input total from inline bytes plus required referenced
artifact bytes. Tests must cover initial and repair envelopes, exact-boundary
pass, one-byte-over refusal, no double counting, per-artifact diagnostics, and
stricter overrides. Do not add a spawned pipeline scenario.
