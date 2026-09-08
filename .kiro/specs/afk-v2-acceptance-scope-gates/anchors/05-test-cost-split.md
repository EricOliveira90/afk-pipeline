# Code anchors — slice 05 (#86), Test cost split and caching

Verified against `integration/pre-prd4` on 2026-09-08. Read this before writing
the contract.

## The `gatePolicy.cost` shape — settled, do not escalate

Recorded 2026-09-08 after this slice's planner escalated `LOAD_BEARING_SILENCE`
on it. The answer is a **hybrid**, not either option the planner offered: records
only where a consuming project must express its own rules, plain scalars and
arrays elsewhere, and AFK's own gate metadata in code.

```json
{
  "cost": {
    "cheapThresholdMs": 120000,
    "environmentSensitive": ["test:budgets"],
    "cacheEnabled": true,
    "relatedTests": { "command": "pnpm", "args": ["exec", "vitest", "run"] },
    "skipDetectors": [
      { "id": "vitest-ts",
        "testGlobs": ["**/*.test.ts"],
        "patterns": ["describe\.skip", "it\.skip", "test\.skip",
                     "it\.todo", "test\.todo",
                     "describe\.only", "it\.only", "test\.only"] }
    ]
  }
}
```

- `cheapThresholdMs`: number, default `120000` (D18's own figure).
- `environmentSensitive`: array of gate IDs (D16). `test:budgets` is the first
  declared member.
- `cacheEnabled`: boolean. D17 already fixes the cache *key* — gate ID, resolved
  command and args, and tree ID — so config needs only on/off.
- `relatedTests`: one declared command that receives the changed paths. Config,
  because it is project-specific.
- `skipDetectors`: **records** of `id`, `testGlobs`, `patterns`. Records here and
  nowhere else, because D7 explicitly says a project on another runner "declares
  its own detector" — a name-only list could not honour that. AFK ships
  `vitest-ts` as the default; with neither a declared detector nor a waiver the
  gate fails closed, which is plan item 17's stated and accepted failure mode.
- **`expectedCostMs` and gate prerequisites are code in `src/base-gates.ts`, not
  config.** D18 derives the verification command from required gates whose
  `expectedCostMs` is at or below the threshold; those are AFK's own gates, and a
  consuming project does not author AFK's gate catalog. This follows D1's rule
  that the association between a class and what it covers is code.

This is not a contradiction of D1's "named arrays, not rule records": that
decision was about `protectedPaths` and `riskClasses`, and its stated reason was
that D6 cites the dotted path `gatePolicy.protectedPaths.testGlobs`, which a
record array would leave unresolvable. No such citation constrains `cost`, and D7
affirmatively requires project-declared detector patterns.

## What already exists

- **`test:budgets` is not a gate today.** `BASE_GATE_IDS` is exactly
  `["typecheck", "lint", "tests"]` and no `src/` file references the budgets
  script. You must **add** it as a gate as well as mark it environment-sensitive.
  It stays blocking for a plain developer `pnpm test` — a `package.json` concern,
  not a gate concern.
- **`environmentSensitive` is mostly achievable via `required: false`.**
  `declaration.required` is read in exactly four places:
  `src/candidate-gate-phase.ts:86` and `:169`, `src/candidate-gate-policy.ts:51-53`
  and `:74`. Line 169's `(!declaration.required || result.status === "PASS")`
  already gives D16's "executes, records its real status, neither blocks nor
  enters the repair failure set". Do not add a parallel exclusion path; the
  advisory section in `run-summary.md` is the genuinely new part.
- **Nothing sets `expectedCostMs` on any `GateDeclaration` today.** You are the
  first, in `src/base-gates.ts`.
- `src/logger.ts:394` — the run-summary is one template literal with
  `## Base Gates`, `## Dependency Holds`, `## Adopted Slices`. Your section and
  the advisory block are new `## ` blocks there; there is no per-slice machinery.
- **#84's validator refuses an unknown `gatePolicy` member**, so adding `cost`
  means widening its known-key set in `src/gate-policy.ts`.
- **D18 corrects `AGENTS.md` and `CLAUDE.md`.** Note the two disagree today:
  `CLAUDE.md`'s self-run section omits `typecheck` from the command while
  `AGENTS.md` requires it. Fix both.

## Size discipline — a hard budget

Keep `contract.md` plus `acceptance-manifest.json` under **20,000 bytes
combined** (#196: a revision round inlines both pairs, so a larger pair makes
round 2 unreachable). Use the repository's tracked casing for every declared path.
