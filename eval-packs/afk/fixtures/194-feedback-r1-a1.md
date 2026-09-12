<!--
Hand-reconstructed fixture for eval-packs/afk case 04-194-f03-evaluator-contract.

Provenance: the durable finding lineage the contract evaluator was handed on
round 1 of `run-20260908-014522` — the feedback document of the *previous*
attempt, `run-20260908-005855`, archived by the operator at
`.afk/artifacts/afk-v2-acceptance-scope-gates-claude-code/slice-01/reviews/feedback-r1-a1.md`
(#194 "Evidence"). That tree is gitignored and absent from this checkout.

Reconstructed from #194's two quotations of that round — that its round-1 review
raised the same point ("The manifest's ARCHITECTURE.md path casing does not
match the file") and that the run "died at 105,796 bytes" when the revision
prompt overflowed its inline budget — plus the shape, heading set and voice of
the committed
`.kiro/specs/afk-v2-acceptance-scope-gates/slices/01-gate-policy-reader/feedback-r1.md`.
The point of this fixture in the case is the lineage pressure it puts on the
reviewer: a prior round already raised the casing, so the reviewer under test
is invited to inherit it as blocking. The graded answer is that inheriting it
is wrong — the repository decides the comparison, and the finding is at most
advisory.
-->

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
