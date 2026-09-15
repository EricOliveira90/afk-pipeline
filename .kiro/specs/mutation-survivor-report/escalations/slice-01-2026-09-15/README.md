# Slice 01 (#303) negotiation record — 2026-09-15

Two escalations, one day apart, for two different reasons. These are the verbatim
artifacts of the second, copied here because the run directories they came from
live under `.afk/`, which is gitignored: a citation into `.afk/` rots the moment
the next run overwrites it or the host changes.

**Run 1 (`run-20260914-103939`, 6m43s)** stopped at planner round 1 with
`LOAD_BEARING_SILENCE`, asking which config surface declares the mutation command
and the report path. That was answered in #303's body and in `prd.md` — an
optional `mutationReport: { command, reportPath }` member of the PRD dir's
`afk.json`, validated and returned by `parseAfkManifest` and read before any agent
dispatch. Nothing here is about that decision; it worked. Run 2's planner wrote a
contract instead of escalating.

**Run 2 (`run-20260915-062408`)** ran all three negotiation rounds and converged
on everything except one late finding. It is worth reading as a case where the
round budget, not the disagreement, ended the negotiation: round 1 raised four
blocking findings, round 2 cleared three and raised one fresh finding (F-07),
which earned a third round under the final-contract-response rule, and round 3
cleared F-07 and raised one more (F-08) with no rounds left.

| File | What it is |
|---|---|
| `feedback-r1.md` | Round 1 — four blocking findings, including the run-state version bump against `src/eval-boundary.test.ts`'s pinned literal and the ARCHITECTURE.md row's cap |
| `feedback-r2.md` | Round 2 — three cleared, F-07 fresh |
| `feedback-r3.md` | Round 3 — F-07 cleared, **F-08** fresh and unresolved. This is the one the ticket now answers |
| `contract-review-r3.json` | The same round as structured findings |
| `contract-negotiation-outcome.json` | The negotiation's terminal record |
| `stuck.md` | The park record the escalation produced |

**F-08's substance, because it is a real defect in the design as declared and not
a disagreement:** the step is started before the guardian fork and awaited on the
guardian-rejection exit, but that await carried no deadline — the flat 30-minute
bound sat on the rejoin exit only. And the step derives its file scope from the
change-summary builder before the command is spawned, so a guardian rejecting in
that window hits a `terminate` that is a no-op (nothing is registered yet), the
gate blocks the rejection for the whole unbounded mutation run, and the spawned
process is registered after the only quiesce that path performs. That is the state
ADR 0020 and ADR 0035 exist to prevent. The answer — bound every exit, close the
pre-spawn window with an abandonment check before the seam invocation, and observe
the window in `src/ship-gate.test.ts` — is recorded in #303's body under
"Concurrency with the guardians".

Nothing here is input to a slice. The planner and explorer read `prd.md`,
`issues.md` and the ticket bodies; this directory is history for a human.
