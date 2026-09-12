# Contract review — slice 01, Gate policy reader (round 1)

The contract does not lock yet. The behaviors are testable and the scope is
small, but two findings are open, one of them blocking.

## Why this contract is testable

Each behavior names an entry point, an input, and a result a reader can compute
without running the code, and the three exports each carry a success path rather
than only rejections: `parseGatePolicy` returns prd.md D1's example deep-equal,
`matchesGlob` declares its pairs with the expected boolean spelled out, and
`loadGatePolicy` is asserted over a `mkdtempSync` directory and again over this
repository's committed config. The static facts are assertions rather than
reviewer inspection, which is what makes them producible by the gates the
behaviors list.

## Why the scope is evidence-backed and feasible

Five files, no migrations and no new dependency. The two recorded calls are the
right shape: `parseJsonWithUniqueKeys` exists in `src/json-scan.ts` and is
already used by `src/acceptance-manifest.ts`, and keeping the unknown-key check
local avoids exporting `requireExactKeys` from a file this slice must not touch.

## Findings

**F-01 — BLOCKING — the manifest's `ARCHITECTURE.md` path casing does not match
the file.** The manifest's `fileScope` declares `architecture.md`; the contract
and B-16 both say `ARCHITECTURE.md`, which is the repository's tracked casing and
the value of `architectureDoc` in `afk.config.json`. Declare the tracked casing
in `fileScope`.

**F-02 — ADVISORY — B-03's `protectedPaths` defaults are only half pinned.**
B-03's text promises that omitting *either* member returns the documented
baseline, but the declared cases cover only the `testGlobs`-omitted half. Add a
reduced policy whose `protectedPaths` supplies `testGlobs` and omits
`gatePolicyPaths`, or narrow B-03's wording to what the cases cover.

## Verdict

REVISE. F-01 must be answered before the pair locks.
