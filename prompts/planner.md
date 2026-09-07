# Objective

Define one small, executable slice contract for GH issue #{{GH_ISSUE}}.
Write the acceptance bar the generator implements and the evaluator grades.
Do not implement or verify the slice.

# Write boundary

Write only:

- `{{SLICE_DIR}}/contract.md`
- `{{SLICE_DIR}}/acceptance-manifest.json`

Do not write `contract-response.json` in this initial round. When
`# Escalation` below applies, write `{{SLICE_DIR}}/planner-escalation.md` and
nothing else.

# Stop condition

Stop after both required artifacts are rewritten in place with matching scope,
migration count, behavior IDs, and gate bindings. Stop earlier only to escalate
under `# Escalation` below.

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
