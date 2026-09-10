# Work That Only Matters Once Cleaner/Hardener Default On

Two deferred blocks share one gate: the hardener and mutation machinery
(PRD 5 stories 9–15 and 19), and final-evaluator code attribution
(PRD 4 story 15).

## Why this is out of scope

Plan §3 item 8 makes cleaner and hardener **default off** until PRD 5
story 17 produces ROI evidence. Everything above is machinery for, or
bookkeeping about, roles that do not run:

- **Attribution** has nothing to attribute while no cleaner or hardener edits
  reach the tree. PRD 4 story 13 already makes the final evaluator free while
  they are off, so the cost the attribution would explain is not being paid.
- **Mutation testing** is the most expensive thing PRD 5 could add, against
  the least evidence. Plan §6 records it as "deferred outright rather than
  left untested" — a decision about honesty, not just cost. A mutation suite
  nobody trusts is worse than none.

`docs/PRODUCT.md` principle 5 governs: defaults change because a run produced
ROI evidence, not because a debate was persuasive. Building the dependent
work first would be paying carry cost on a bet not yet placed.

PRD 5 keeps stories 3, 4, 5, 16, 17 and 20 — including story 17, the
experiment that decides this. The run that produces the evidence is PRD 5's
own.

## Re-open trigger

PRD 5 story 17's ROI evidence lands positive and cleaner or hardener defaults
on. Then both blocks re-enter together — attribution is only meaningful once
there is something to attribute.

## Prior requests

- #201: "Deferred: final-evaluator code attribution (#72 story 15)"
- #202: "Deferred: hardener and mutation machinery (#73 stories 9-15, 19)"
