# Probe-as-Evidence

A probe result is not promoted to first-class gate evidence.

## Why this is out of scope

PRD 4 story 9 was deferred in the plan debate. ADR 0059 then settled the
narrower question that actually blocked runs — a busy-probe deferral requires
an open command — without needing the probe to become evidence. That is
`docs/PRODUCT.md` principle 2 working as intended: the mechanism was narrowed
rather than promoted.

Gate evidence is the record a later actor reasons from. A probe is a
point-in-time observation of the *host*, not a property of the tree being
judged. Recording it as gate evidence invites exactly the stale-record class
plan §1 catalogues: all six defects found by running AFK on itself were "the
pipeline records or classifies something that misleads the next actor." A
probe result that was true when taken and false when read is that shape by
construction.

## Re-open trigger

A refusal occurs that gate evidence cannot explain and a probe result would
have — twice.

## Prior requests

- #200: "Deferred: probe-as-evidence (#72 story 9)"
