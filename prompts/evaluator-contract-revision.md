# Objective

Judge whether the revised contract pair resolves the evaluator's prior OPEN
findings without introducing a new revision-caused gap. Judge the contract; do
not implement the slice or change its contract pair.

# Write boundary

Write only:

- `{{SLICE_DIR}}/{{CONTRACT_REVIEW_FILE}}`
- `{{SLICE_DIR}}/feedback-r{{ROUND}}.md`

# Stop condition

Stop after both review artifacts are written. An unreviewable revision is a
`REVISE` verdict with a BLOCKING finding; there is no third verdict.

# Revised contract pair

The pair under review is in your working tree. Read both files in full before
you judge anything:

- `{{SLICE_DIR}}/contract.md`
- `{{SLICE_DIR}}/{{ACCEPTANCE_MANIFEST_FILE}}`

They are not inlined below. Everything this revision *changed* is reproduced
verbatim under "Exact revision evidence", which is the only text a fresh
finding may cite.

# Prior OPEN findings

{{PRIOR_OPEN_FINDINGS}}

# Durable finding lineage

Every finding below is still open in this slice's durable lineage, including any
inherited from an earlier attempt. Reuse each ID exactly and give it a current
state; a review that omits one is refused.

{{DURABLE_FINDING_LINEAGE}}

# Planner response

```json
{{PLANNER_RESPONSE}}
```

# Exact revision evidence

Every region this revision changed, per artifact, with the prior and revised
text quoted exactly after CRLF/LF normalization. An insertion shows prior text
as `""`; a deletion shows revised text as `""`. Unchanged text is not
reproduced: a fresh finding about unchanged text is invalid, so this block is
the citable surface of the round.

{{REVISION_CONTEXT}}

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

# Revision judgment

For each prior OPEN finding, independently judge whether its clear-condition is
met:

- `UNRESOLVED` stays `OPEN`.
- `CONDITION_MET` becomes `RESOLVED` only when the condition is actually met;
  otherwise it stays `OPEN`.
- `CONTESTED` becomes `CONTESTED` when you hold the finding or `WITHDRAWN` when
  the planner's evidence changes your judgment.

Keep familiar finding IDs and use `revisionCitation: null` for them. Every
fresh finding must be `OPEN` and must use this exact citation object:

```json
"revisionCitation": {
  "artifact": "contract.md",
  "before": "exact text from the prior artifact",
  "after": "exact text from the revised artifact"
}
```

`artifact` must be exactly `contract.md` or `acceptance-manifest.json`.
At least one of `before` and `after` must be non-empty. For an insertion, copy
`before: ""`; for a deletion, copy `after: ""`. Every non-empty side must be
exact normalized text from that artifact changed by this revision, and the two
sides must differ. A fresh finding about unchanged text is invalid. Copy both
strings from the same region in "Exact revision evidence". A citation assembled
from the files themselves is refused unless it happens to land on changed text.

Limit any fresh judgment to gate aptness, scenario honesty, evidence-backed
scope, blocking UNKNOWNs, single-session feasibility, and explicit non-goals.

# Canonical review artifacts

Write `{{SLICE_DIR}}/{{CONTRACT_REVIEW_FILE}}` with exactly this version-2
shape:

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
- Include every routed prior finding exactly once with its current state.
- Never reactivate a terminal finding.
- Never report gap counts.

Write `{{SLICE_DIR}}/feedback-r{{ROUND}}.md` as a human-readable companion
without control fields, verdict markers, or gap counts.
