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

# Stop condition

Stop after the affected contract sections, matching manifest entries, and any
required response are rewritten in place. Preserve every unaffected behavior,
scope term, migration declaration, gate binding, and stable ID exactly. If the
specification contradicts itself (including a recorded ADR), is silent on a
load-bearing decision, or declares the decision as a risk, stop and report that
conflict. Decide and record all other details.

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

## contract.md

```markdown
{{CURRENT_CONTRACT}}
```

## acceptance-manifest.json

```json
{{CURRENT_ACCEPTANCE_MANIFEST}}
```

# Routed OPEN findings

{{OPEN_FINDINGS}}

# Control-plane situation

{{CONTROL_SITUATION}}

# Executable gate catalog

```text
{{BASE_GATE_CATALOG}}
```

# Migration reservation

{{MIGRATION_RESERVATION}}

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

The contract and manifest retain the initial template's public artifact
contracts: exact matching file scope and migration count, stable behavior
anchors, version-2 behavior bindings, explicit non-goals, Given/When/Then test
scenarios, and scope-local Definition of done.
