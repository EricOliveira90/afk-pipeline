# Parser contracts declare regression surfaces; gate evidence may trigger only a pre-edit revision

**Status:** Accepted
**Date:** 2026-09-07

Issue #183 exposed two different failures that must not share one permissive
remedy. A slice changed the accepted language of the guardian-review parser
without declaring the shared fixtures that encoded the old language; the
generator's narrow verification stayed green, and the full deterministic gate
found the missing fixture work only after implementation. ADR 0052 already
allows a focused scope revision when the generator stops before an undeclared
edit, while ADR 0048 allows an after-the-fact amendment only when an independent
QA evaluator has judged the existing work and explicitly names
`SCOPE_AMENDMENT` as its remedy.

## Decision

**A slice contract that changes a parser's accepted input language must declare
its regression surface.** The contract and acceptance manifest identify:

- at least one newly accepted input;
- relevant rejected or boundary input that must remain rejected; and
- the owning fixture area when the repository's established harness is
  fixture-backed, including the concrete existing fixture paths expected to
  change or explicit authorization to add fixtures in that area.

Inline parser tests remain valid when they are the established harness. A
literal fixture path is therefore not universally mandatory; concrete
regression evidence is.

**An orchestrator-run deterministic gate failure may warrant a focused scope
revision for behavior the locked contract already decided.** The next generator
receives the gate ID, evidence artifact and failing test context. If satisfying
that evidence requires an undeclared path, the generator may request the
ordinary focused revision and must stop before editing that path. The revision
records the gate evidence that warranted it and remains additive, bounded and
contract-evaluator-reviewed under ADRs 0050–0052.

**Gate evidence never legalizes an existing out-of-scope edit.** ADR 0052's
full-tree cleanliness check still refuses the revision when the worktree
already contains any undeclared change. A failing gate proves the candidate is
not acceptable; it does not prove that an undeclared edit is correct. Only the
independent QA finding defined by ADR 0048 can authorize an after-the-fact scope
amendment, and only under that ADR's validation rules.

**A discovery that changes intended behavior is not a scope repair.** If the
gate exposes an unresolved public interface, data format, security posture,
acceptance criterion or other load-bearing behavior decision, the slice
escalates for a human decision instead of revising scope.

## Consequences

- Contract evaluation rejects parser-language changes whose regression evidence
  or established fixture surface is missing.
- A late deterministic failure can recover without granting the generator
  authority to launder an undeclared edit.
- The three scope doors stay distinct by warrant: generator discovery before
  edit (ADR 0052), gate-evidenced discovery before edit (this ADR), and
  evaluator-judged amendment after edit (ADR 0048).
- PRD 4's file-scope gate must preserve this distinction when it returns
  structured gate evidence to a generator round.

## Examples

- A parser starts requiring a structured findings block, but the contract names
  no guardian-review fixtures: contract evaluation rejects the incomplete
  regression surface.
- A full deterministic gate fails in an existing fixture file outside the
  locked scope; the generator has not edited that file: the gate evidence may
  support a focused revision before the fixture edit.
- The generator edits an undeclared fixture and then cites the failing gate:
  the revision is refused because the out-of-scope edit already exists.
- The gate reveals ambiguity about whether malformed input should be accepted:
  the slice escalates because the missing fact is behavior, not file scope.
