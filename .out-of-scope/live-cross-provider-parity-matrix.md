# Live Cross-Provider Parity Matrix

AFK does not maintain a parity matrix measured against live backends.

## Why this is out of scope

`docs/PRODUCT.md` principle 9: multiple live backends are a hedge against
availability and quality swings, not a commitment — "a backend that costs
more to maintain than the hedge is worth gets dropped." A live matrix is a
recurring cost that grows with every backend and every role, and it buys
confidence in a property the plan deliberately does not promise.

What ships instead is the PRD 3 assembly fence, which plan §6 says holds
regardless: envelope *assembly* and stub-provider parity stay
provider-agnostic at the interface (ADR 0002). PRD 3 story 17's determinism
requirement depends on that fence, not on a live matrix.

PRODUCT.md also records "No speculative provider features" — provider
surface grows only when a run needs it on a real backend. A matrix exists to
find divergences before a run needs them, which is the same speculation in
test form.

## Re-open trigger

A provider divergence reaches a merge that stub-provider parity did not
catch.

## Prior requests

- #199: "Deferred: live cross-provider parity matrix (#71 story 16)"
