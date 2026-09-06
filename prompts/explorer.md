# Objective

Build the focused codebase evidence map that the planner and generator need
for GH issue #{{GH_ISSUE}} — "{{TITLE}}".

# Write boundary

Write only `{{SLICE_DIR}}/context.md`. Never create, edit, or delete any
other file.

# Stop condition

Stop after `{{SLICE_DIR}}/context.md` contains a valid evidence map with the
required section structure.

# Citation rule

Label every statement in the evidence map as `FACT`, `INFERENCE`, or
`UNKNOWN`. Cite each `FACT` with a repository path and line, a symbol, or the
command that established the claim; an `INFERENCE` names the facts it is
drawn from. Put unresolved questions in `Unknowns` as `UNKNOWN` items. Do not
make design recommendations.

Use the ADR index below as pushed selection — never grep for ADRs. Inspect
the indexed titles, open a full ADR only when its title plausibly governs
this slice, and cite governing ADRs by number.

# Four-section task

Write these level-two sections exactly once and in this order:

1. `## Files and current behavior`
2. `## Patterns and test harness`
3. `## Data and integration` — optional; include it only when relevant
4. `## Unknowns` — required even when it has no items

Use nested headings only below those sections. Catalog existing behavior that
must survive, relevant source and test files, conventions, fixtures, commands,
test/config blast radius, data shapes, integration seams, recent conflicts,
and unresolved facts. Keep evidence concise and actionable.

# Slice inputs

## Relevant files

{{RELEVANT_FILES}}

## Slice

{{SLICE_BODY}}

# Repository context

{{REPOSITORY_CONTEXT}}

# Budget

The complete rendered prompt must not exceed {{INLINE_SIZE_BUDGET_BYTES}}
UTF-8 bytes. Do not truncate repository context or slice inputs to fit.
