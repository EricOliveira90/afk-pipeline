# Objective

Revise the current slice contract for GH issue #{{GH_ISSUE}}. Resolve only the
routed OPEN findings and the separate control-plane situation supplied below.
Do not implement or verify the slice.

# Write boundary

Rewrite only:

- `{{SLICE_DIR}}/contract.md`
- `{{SLICE_DIR}}/acceptance-manifest.json`
- `{{SLICE_DIR}}/contract-response.json` only when the response instructions
  below require it

When `# Escalation` below applies, write
`{{SLICE_DIR}}/planner-escalation.md` and nothing else.

# Stop condition

Stop after the affected contract sections, matching manifest entries, and any
required response are rewritten in place. Preserve every unaffected behavior,
scope term, migration declaration, gate binding, and stable ID exactly. Stop
earlier only to escalate under `# Escalation` below.

# Escalation

Decide and record, without asking, when the call is inside this slice's
contract, reversible before merge, or a gap-fill nothing else will build on.
Record the decision in the contract statement it governs and move on; a
mechanical detail is never an escalation.

Escalate only when one of these three tests fires. They take precedence: a
test that fires still fires when the call would otherwise read as inside this
slice's contract or reversible before merge.

1. **Spec contradiction** — the correct contract needs a behavior the
   specification states differently. A recorded ADR counts as specification:
   escalate rather than silently overriding one.
2. **Load-bearing silence** — the specification says nothing and the choice
   creates something others will build on: a public interface, a data format,
   or a security posture.
3. **Declared risk class** — the decision falls in a declared risk class
   (schema history, auth, deletion of tests or gates, destructive git), or the
   specification declares this decision a risk.

To escalate, write `{{SLICE_DIR}}/planner-escalation.md` as exactly one JSON
object — one line, no prose and no code fence — and stop:

`{"version":1,"criterion":"LOAD_BEARING_SILENCE","decision":"the one decision a human must make","options":["the first candidate answer","the second candidate answer"],"citation":"the PRD or issue line, ADR id, or risk class the test fired on"}`

`criterion` is exactly one of `SPEC_CONTRADICTION`, `LOAD_BEARING_SILENCE`,
`DECLARED_RISK_CLASS`. `options` lists at least two candidate answers. Every
string is non-blank.

That file is the whole report. Write it *instead of* the contract pair: when
you escalate, do not write or edit `{{SLICE_DIR}}/contract.md` and do not write
`{{SLICE_DIR}}/acceptance-manifest.json`, because writing either one reports a
failed round instead of your question. The pipeline stops this slice's
negotiation, reports the request, and spends no further planner round.

The existence of a routed review finding, or of a human adjudication, is not
itself one of these tests — resolve it. Escalate only if the revision it asks
for requires a decision that fires test 1, 2, or 3.

# Revision rules

- Keep `**Status:** NEGOTIATING`. Only the orchestrator may write `LOCKED`.
- Revise only sections and manifest behavior entries affected by the routed
  finding IDs or the control-plane situation.
- Do not append negotiation history, findings, response tables, or evaluator
  prose to `contract.md`.
- Preserve the exact file scope unless the control-plane situation explicitly
  requires an additive scope change or a human adjudication authorizes another
  result.
- Keep unchanged behavior IDs stable.
- Keep Definition of done scope-local.
- Copy relied-on ADR citations into the relevant contract statements; never
  inline full ADR bodies.
- For every routed finding, choose exactly one response position:
  `UNRESOLVED`, `CONDITION_MET`, or `CONTESTED`.
- Use `CONTESTED` only when you dispute the finding and can provide concrete,
  non-blank evidence. Do not silently treat a contested condition as met.
- `CONDITION_MET` also requires concrete, non-blank evidence.

# Current contract pair

Parent PRD: `{{SPECS_DIR}}/prd.md`

The pair you are revising is in your working tree. Open and read both files in
full before you revise anything:

- `{{SLICE_DIR}}/contract.md`
- `{{SLICE_DIR}}/acceptance-manifest.json`

They are not inlined below. Do not revise until you have read both files: a
revision written from memory of an earlier round, or from the findings alone,
rewrites terms the findings never touched.

# Routed OPEN findings

{{OPEN_FINDINGS}}

# Relevant resolved history

This history is preservation context only. Do not respond to these IDs or add
them to `contract-response.json`.

{{RESOLVED_HISTORY}}

# Control-plane situation

{{CONTROL_SITUATION}}

# Executable gate catalog

```text
{{BASE_GATE_CATALOG}}
```

# Migration reservation

{{MIGRATION_RESERVATION}}

# Repository context

{{REPOSITORY_CONTEXT}}

# Contract response instructions

{{CONTRACT_RESPONSE_INSTRUCTIONS}}

When a response is required, write exactly this version-1 shape with one entry
per routed finding ID and no others:

```json
{
  "version": 1,
  "round": {{ROUND}},
  "responses": [
    {
      "findingId": "F-01",
      "position": "UNRESOLVED",
      "evidence": ""
    }
  ]
}
```

`round` is the number {{ROUND}} exactly, not the count of rounds you have seen
and not the next one: a response declaring any other round is refused.

The contract and manifest retain the initial template's public artifact
contracts: exact matching file scope and migration count, stable behavior
anchors, version-2 behavior bindings, explicit non-goals, Given/When/Then test
scenarios, and scope-local Definition of done.
