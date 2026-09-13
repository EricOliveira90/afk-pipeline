# Contract review — Prompt recorder (round 3)

Both findings routed into this round are resolved, and this revision introduced
nothing new. The contract pair is ready to implement.

## F-06 — fileScope casing for the two doc paths

Resolved. `fileScope` now reads `"CONTEXT.md"` and `"ARCHITECTURE.md"`, which is
what the repository actually calls those files: the worktree's root markdown
files are `AGENTS.md`, `ARCHITECTURE.md`, `CLAUDE.md`, `CONTEXT.md`, `README.md`,
and `git ls-files` reports the same five names — so the strings a case-sensitive
CI checkout would materialize are the strings the manifest declares. No
remaining `fileScope` entry differs in case from its on-disk name.

That matters more than casing usually does, because this slice makes `fileScope`
the enforcement surface: `P-01` and `P-04` both prove preservation by absence
("those paths are absent from the manifest fileScope, so any edit is a scope
violation"). An argument by absence only holds when the present entries are
exact, and now they are. The two `given` clauses the revision also touched
tighten that link usefully rather than just restating it — `B-09`'s records that
both paths are declared in scope under the names they carry on disk, and
`P-04`'s records that the only root-level entries are `CONTEXT.md` and
`ARCHITECTURE.md`, which is what puts `AGENTS.md` and `CLAUDE.md` outside scope
without relying on the reader to compare two lists.

## F-07 — B-10 missing from the acceptance surface

Resolved. The manifest's behavior set is now `B-01`–`B-10` plus `P-01`–`P-05`,
and the new `B-10` entry sits between `B-09` and `P-01` with its own
given/when/then rather than a cross-reference: a present `logStream` whose
`String(path)` yields no `.prompt.md` sibling writes no file, throws nothing,
invents no fallback record name, and resolves to the inner result exactly as
`B-05`'s absent stream does.

The entry is selectable and enforced. Its `observableResult` names
`src/prompt-recorder.test.ts` and describes the concrete assertion — open a
`logStream` on a temp `…/guardian-review.txt`, invoke, assert the directory
gained no file and the promise resolved to the inner result — and its `gateIds`
are `typecheck`, `tests` and `acceptance:behaviors`, all executable in the
catalog. So `acceptance:behaviors --testNamePattern B-10` selects a real test,
and the derived-path branch can no longer ship unwritten with every gate green.
The entry lines up with all three places the contract already carried `B-10`:
the in-scope bullet, the `guardian-review.txt` test-plan line, and the
Definition-of-done checkbox.

## On the rest of the revision

The only other change is the negotiation-round bump in `contract.md`. Nothing
this revision touched weakens a behavior that was previously settled, and the
`B-10` entry's disjunctive `given` — a path not ending in `.log`, *or* a `path`
member absent at runtime — is honest about testing the first shape only. That is
the right call and not a gap worth holding: `node:fs`'s `WriteStream` declares
`path` as always present, so the second shape is unreachable both from
production (every call site's stream comes from `RunJournal.agentLog`) and from
a typed test without a cast. The contract says so in the `B-10` bullet, and it
covers the observable consequence — write nothing, throw nothing — with the case
a test can actually construct.
