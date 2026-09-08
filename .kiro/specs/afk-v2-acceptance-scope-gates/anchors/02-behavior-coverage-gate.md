# Code anchors — slice 02 (#85), Behavior coverage gate

Verified against `integration/pre-prd4` on 2026-09-08. Read this before writing
the contract.

## The `gatePolicy.acceptance` shape — settled, do not escalate

Recorded 2026-09-08 after this slice's planner escalated `LOAD_BEARING_SILENCE`
on it. D1's table named the contents and D8 fixed only the no-policy baseline
command; nothing fixed the member JSON, and nothing in `src/` does command
templating today.

```json
{
  "acceptance": {
    "command": "pnpm",
    "args": ["exec", "vitest", "run", "--reporter=json",
             "--testNamePattern", "{behaviorId}"],
    "matcher": "vitest-json"
  }
}
```

- **`{behaviorId}` is a literal placeholder token** that must appear at least once
  inside `args`, and is replaced per behavior. A declared `acceptance` whose
  `args` carry no placeholder **refuses the launch, naming the key**.
- `matcher` is the literal `"vitest-json"`; any other value refuses the launch
  naming the missing matcher, per D8. `vitest-json` parses `numTotalTests`: zero
  is FAIL, one or more all-passing is PASS. No stdout or stderr prose is parsed.
- The derived baseline (no `gatePolicy` present) is this same shape with the
  project's vitest binary, which is what D8 already specifies.

Rejected: appending the behavior ID as a trailing argument, because it forces
every declared command to end at its test-name-filter flag and breaks silently
when it does not. Also rejected: a single `commandTemplate` string split on
whitespace, because it cannot express an argument containing a space.

## What already exists

- `src/acceptance-manifest.ts` is already `version: 2` and each behavior already
  carries a non-empty `gateIds: string[]` (validated at lines 146–155). Bind
  `acceptance:behaviors` by putting that gate ID in a behavior's existing
  `gateIds` — the binding mechanism exists. **The manifest stays at version 2.**
- **Nothing in `src/` parses vitest JSON** — zero non-test matches for
  `numTotalTests` or `reporter=json`. You write the first matcher. Keep it a pure
  function over already-parsed JSON so it is unit-testable without spawning
  vitest (AGENTS.md's ladder).
- `GateDeclaration.id` is a bare `string`, so a colon in `acceptance:behaviors`
  needs no change. Existing ids: `typecheck`, `lint`, `tests`, plus `scope`
  (#195) and `feedback-integrity` (#193).
- **#84's validator refuses an unknown `gatePolicy` member**, so adding
  `acceptance` means widening its known-key set in `src/gate-policy.ts`, not just
  reading a new key. #84 is merged into your base.

## Size discipline — a hard budget

Keep `contract.md` plus `acceptance-manifest.json` under **20,000 bytes
combined**. A revision round's evaluator prompt inlines *both* the original and
the revised pair, so a larger pair makes round 2 structurally unreachable against
the 65,536-byte inline budget and the slice dies at `CONFIGURATION` rather than on
its merits (#196). Use the repository's tracked casing for every declared path.
