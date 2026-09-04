# Objective

Define one small, executable slice contract for GH issue #{{GH_ISSUE}}.
Write the acceptance bar the generator implements and the evaluator grades.
Do not implement or verify the slice.

# Write boundary

Write only:

- `{{SLICE_DIR}}/contract.md`
- `{{SLICE_DIR}}/acceptance-manifest.json`

Do not write `contract-response.json` in this initial round.

# Stop condition

Stop after both required artifacts are rewritten in place with matching scope,
migration count, behavior IDs, and gate bindings. If the specification
contradicts itself (including a recorded ADR), is silent on a load-bearing
decision, or declares the decision as a risk, stop and report that conflict.
Decide and record all other details in the contract.

# Contract rules

- Seed `**Status:** NEGOTIATING`. Only the orchestrator may write `LOCKED`.
- Preserve existing behavior unless the issue explicitly authorizes a change.
- Keep the contract concise and rewrite it in place; never append negotiation
  history or evaluator prose.
- A prohibition on implementation edits must still
  allow the planner and evaluator to write their required contract, manifest,
  response, review, and feedback artifacts.
- Use exact repository-relative file paths, one per bullet. They must match the
  manifest file scope.
- Write `## Migration requirements` with exactly
  `- New migration files: N`, matching the reservation and manifest.
- Every `### In scope` and `### Existing behavior to preserve` bullet starts
  with one unique stable anchor such as `[behavior:B-01]` or
  `[behavior:P-01]`. No other contract text uses that anchor form.
- Keep an unchanged behavior ID stable across rewrites.
- Bind every manifest behavior to one or more executable gate IDs from the
  supplied catalog.
- Keep Definition of done scope-local. Do not add whole-repository criteria.
- Copy every ADR citation the contract actually relies on into the relevant
  contract statement. Never inline a full ADR body.
- You may open a full ADR from the worktree only when its indexed title
  plausibly governs this slice.

# Slice request

Parent PRD: `{{SPECS_DIR}}/prd.md`

{{SLICE_BODY}}

# Explorer evidence map

{{EXPLORER_CONTEXT}}

# Executable gate catalog

```text
{{BASE_GATE_CATALOG}}
```

# Migration reservation

{{MIGRATION_RESERVATION}}

# Repository context

{{REPOSITORY_CONTEXT}}

# Required output contract

Rewrite `{{SLICE_DIR}}/contract.md` with this shape:

```markdown
# Slice Contract — <slice name>

**Parent PRD:** {{SPECS_DIR}}/prd.md
**GH issue:** #{{GH_ISSUE}}
**Status:** NEGOTIATING
**Negotiation round:** {{ROUND}}

## Scope lock
<one paragraph: the end-to-end behavior this slice delivers>

### In scope
- [behavior:B-01] <specific, verifiable behavior with source citation>

### Non-goals (explicit out-of-scope)
- <related work this slice does not do>

### Existing behavior to preserve
- [behavior:P-01] <affordance — file:symbol with source citation>

### Changes to existing behavior (only if the issue asks for it)
- <authorized change with source citation>
- OR write "None"

## Files expected to change
- <exact repo-relative path>

## Migration requirements
- New migration files: <count>

## New patterns / deps / schema (if any)
- <new item>
- OR write "None — uses existing patterns"

## Test plan
- Given <precondition>, when <action>, then <observable result>

## Definition of done
- [ ] <scope-local verifiable statement>
```

Rewrite `{{SLICE_DIR}}/acceptance-manifest.json` with exactly the version-2
shape below. Include one entry for every contract behavior anchor and no
others. Every string is non-blank; `gateIds` is non-empty and distinct.

```json
{
  "version": 2,
  "fileScope": {
    "kind": "paths",
    "paths": ["exact/repo-relative/file.ts"]
  },
  "migrationCount": 0,
  "behaviors": [
    {
      "id": "B-01",
      "source": "GH #123 AC1",
      "given": "the precondition",
      "when": "the action",
      "then": "the expected outcome",
      "observableResult": "what a verifier sees",
      "preservation": false,
      "gateIds": ["tests"]
    }
  ]
}
```

Use a non-empty exact `paths` array, or
`{"kind":"no-repository-changes"}` with migration count zero. Never use
placeholders, globs, absolute paths, directories, or `.` / `..` segments.
