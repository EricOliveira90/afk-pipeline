# Objective

Accept or reject the proposed slice contract using only the declared evidence
below. Judge the contract; do not implement the slice or change its contract
pair.

# Write boundary

Write only:

- `{{SLICE_DIR}}/{{CONTRACT_REVIEW_FILE}}`
- `{{SLICE_DIR}}/feedback-r{{ROUND}}.md`

# Stop condition

Stop after both review artifacts are written. An unreviewable contract is a
`REVISE` verdict with a BLOCKING finding; there is no third verdict.

# Proposed contract

```markdown
{{PROPOSED_CONTRACT}}
```

# Acceptance manifest

```json
{{ACCEPTANCE_MANIFEST}}
```

# Durable finding lineage

Findings a previous attempt at this slice left open. This is round 1 of a fresh
negotiation, but these IDs are not new: reuse each one exactly and give it a
current state. A review that omits one is refused and the slice cannot proceed.
When the contract now meets a finding's clear-condition, say so with state
`RESOLVED`; when your own evidence retires it, use `WITHDRAWN`.

{{DURABLE_FINDING_LINEAGE}}

# Control-plane situation

{{CONTROL_SITUATION}}

# Executable gate catalog

```text
{{BASE_GATE_CATALOG}}
```

# Explorer behavior and preservation evidence

The explorer evidence map's behavior and preservation sections plus its
unresolved unknowns. Its "Patterns and test harness" and "Data and
integration" sections are deliberately withheld from this review.

{{EXPLORER_CONTEXT}}

# Judgment boundary

Limit judgment to:

1. Gate aptness: each behavior's gate can produce relevant evidence.
2. Scenario honesty: each Given/When/Then and observable result faithfully
   represents its same-ID contract obligation.
3. Evidence-backed scope: declared files and preservation terms fit the
   explorer's repository evidence.
4. Blocking UNKNOWNs: only unknowns that prevent a reliable lock become
   BLOCKING findings.
5. Single-session feasibility: one generator session can deliver the slice.
6. Explicit non-goals: related work outside the slice is named.

Do not re-run deterministic manifest checks or invent style findings outside
this judgment boundary.

# Canonical review artifacts

Write `{{SLICE_DIR}}/{{CONTRACT_REVIEW_FILE}}` with exactly this version-2
shape. Every fresh finding is `OPEN`. A finding carried in from the durable
lineage above takes the state your judgment gives it. Either way this round uses
`revisionCitation: null`, because no revision has happened yet.

```json
{
  "version": 2,
  "verdict": "REVISE",
  "findings": [
    {
      "id": "F-01",
      "severity": "BLOCKING",
      "behaviorIds": ["B-02"],
      "evidence": "\"quoted offending text\"",
      "expected": "what the contract must establish",
      "observed": "what it establishes instead",
      "clearCondition": "the observable change that resolves the finding",
      "state": "OPEN",
      "revisionCitation": null
    }
  ]
}
```

- Exactly one verdict: `ACCEPT` or `REVISE`.
- `ACCEPT` requires zero active BLOCKING findings.
- `REVISE` requires at least one active BLOCKING finding.
- `severity` is exactly `BLOCKING` or `ADVISORY`. There is no third severity;
  anything else makes the artifact malformed.
- `state` is exactly one of `OPEN`, `RESOLVED`, `CONTESTED`, `WITHDRAWN`.
- Every finding has a stable ID and a concrete `clearCondition`.
- Use `behaviorIds: []` only for a whole-contract finding.
- Never report gap counts.

Write `{{SLICE_DIR}}/feedback-r{{ROUND}}.md` as a human-readable companion
without control fields, verdict markers, or gap counts. On ACCEPT, explain why
the contract is testable, evidence-backed, and feasible.

Types are checked strictly: a number where a string belongs, including inside
`behaviorIds`, makes the artifact malformed and fails the slice. On later
reviews, disposition every routed planner response exactly once:

- `UNRESOLVED` stays `OPEN`.
- `CONDITION_MET` becomes `RESOLVED` only when its clear-condition is met.
- `CONTESTED` becomes `CONTESTED` or `WITHDRAWN` based on your independent
  evidence.
- Familiar IDs use `revisionCitation: null`; fresh IDs are `OPEN` and cite
  exact changed contract or manifest excerpts.
