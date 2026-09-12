# The learning-proposal schema is AFK-canonical and lands by hand

Date: 2026-09-12
Issues: #152 (PRD 7 parent), #74 (PRD 6 parent); rumo-app #809

Plan §3d item 19 has PRD 6 write `learning-proposals.json` on the second
exact occurrence of a stable finding class, and says the shape is shared
with rumo-app's Close learning pass. Until now the plan made that shape a
PRD 7 deliverable and had PRD 6 wait on PRD 7 for it. This ADR records the
schema itself, who owns it, how it is exported and how it changes - and that
it is a hand-landed module on `main`, not a slice of either PRD
(`docs/specs/afk-v2-plan-debate.md` §7, ruling R1).

## Failure mode

Two repositories writing "the same" JSON from prose descriptions drift
silently: the independent review of PRD 7's decision inventory
(`.kiro/specs/afk-v2-agent-eval-harness/decisions-review.md`, H3) found that
rumo-app #809 shipped a tested findings **ledger** and a prose **proposal
requirement**, but no proposal file, template or schema - while AFK's plan
said PRD 7 would "define" a schema that rumo-app was in turn waiting on. Left
there, the first writer on either side would have fixed the format by
accident, and the second would have had to match a shape nobody decided.
The plan also put this cross-repo format on the critical path of the
critical path (PRD 6 waited on PRD 7 for it) although it shares no code,
concept or test with the eval runner.

## Decision 1: version 1 is five required fields

`src/learning-proposal.ts` defines `LearningProposalsFile`
`{ version: 1, proposals: LearningProposal[] }`, where each proposal is:

| Field | Type | Rule |
|---|---|---|
| `findingClass` | string | kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`), the same identifier rumo-app's ledger keys on |
| `occurrenceCount` | integer | at least 2, and equal to `occurrences.length` |
| `occurrences` | string[] | at least two non-blank links (issue, PR, artifact or ledger entry) - the evidence for "second occurrence" |
| `targetAsset` | string | a repo-relative path when the target is a file; otherwise a stable token such as `skill:<name>`, `gate:<id>`, `eval-scenario` |
| `proposedChange` | string | a unified diff when the target is a file; prose otherwise |

All five are required; no other field is permitted at either level. The set
is item 19's four (class, count, target asset, proposed diff) plus
provenance, and every field is fillable from a rumo-app ledger entry plus
the `post-merge-cleanup` skill's five prose items - which was the one
cross-repo constraint that survived the review (`decisions-review.md` D26).
Ledger-only fields (`validation`, `date`, `prdSlug`, `disposition`) are
deliberately absent: they describe an occurrence, not a proposal, and each
extra field is a permanent coordination cost. `targetAsset` is a free
string rather than an enum because nobody routes on it mechanically in v1
and an enum neither repository fully uses is speculative surface (D27).

`parseLearningProposals(text | value, source)` mirrors `parseAfkManifest`
(ADR 0034): the first defect throws with the source name in the message,
and nothing is skipped. It refuses invalid JSON, an unsupported `version`,
unknown fields, missing or blank required fields, a non-integer or sub-2
count, fewer than two links, a non-kebab class, and a count that disagrees
with the number of links. The last rule is a refusal rather than a
derivation because the count and the links describe one fact: deriving the
count would silently accept a mis-tallied ledger, and trusting the count
would accept a proposal whose evidence is missing.

## Decision 2: AFK owns the canonical definition and exports it

`package.json` exports `./learning-proposal` (`dist/learning-proposal.js`
plus its `.d.ts`), exactly as `./afk-manifest`. rumo-app already pins
`afk-pipeline` by commit and imports `afk-manifest` from it
(`scripts/lib/afk-scope.mjs`), so the consumer runs AFK's validator rather
than reimplementing the rules (`decisions.md` D30). The alternative -
publishing the schema as prose and letting each repo validate its own -
guarantees the drift this ADR exists to prevent.

## Decision 3: a bump is an AFK commit, and a consumer refuses the unknown

`LEARNING_PROPOSAL_VERSION` is the version the module writes;
`SUPPORTED_LEARNING_PROPOSAL_VERSIONS` is what a reader in this process
accepts. Changing the field set is an AFK commit that bumps the constant,
extends or replaces the supported list, and files an issue in each
consuming repository naming the field change. A consumer picks the change up
when it moves its pinned `afk-pipeline` commit; until then it keeps the
version it was built against. A reader that meets a version outside its
supported list refuses the document (`docs/PRODUCT.md`, fail closed). No
paired change in the other repository is required before an AFK bump
merges: the pin is the coordination point, and the issue is the notice.

## Decision 4: rumo-app's ledger stays as shipped

Only the proposal is shared (`decisions.md` D28). rumo-app's Markdown
findings ledger, its `findings-ledger.test.ts` and the
`post-merge-cleanup` skill are unchanged; the skill writes a
`learning-proposals.json` in this shape when it reaches count 2 (D25). No
Markdown renderer is owed to rumo-app in v1.

## Consequences

- PRD 6 depends on PRD 4 only; the plan's §2, §4 and §6 are amended in
  `docs/prd7-rescope`. Item 19's writer imports this module and adds no
  second definition.
- PRD 7 no longer carries the schema, and its `intent.md` success measure 5
  moves here: the ledger-shaped fixture in `src/learning-proposal.test.ts`
  is that measure's test.
- `CONTEXT.md` gains **Learning proposal**; `ARCHITECTURE.md`'s "Manifest
  and claims" row names the module as a public seam.
- The mechanism is already used cross-repo once (ADR 0034), so this adds a
  second entry point and no new machinery.

## Considered alternatives

- **Keep the schema as PRD 7 slice 1** (`decisions.md` D37). Correct if the
  schema had to be negotiated in a run; it does not - it is a JSON shape, a
  validator, an export and a glossary entry, smaller than one round's
  overhead, which is plan §5's own rule for doing work by hand.
- **Markdown canonical**, matching rumo-app's ledger format. Rejected: the
  ledger and the proposal are different artifacts, item 19 already names
  `learning-proposals.json`, and rumo-app's own story 12 says its proposal
  should match AFK's output shape.
- **`{ type, path }` or an enum for `targetAsset`**. Rejected for v1 as
  routing surface nobody consumes; a token convention is enough for a human
  reader, and an enum can be introduced by a version bump when a consumer
  routes on it.
- **Derive `occurrenceCount` from `occurrences`.** Rejected; see Decision 1.

## Verification

`src/learning-proposal.test.ts` - unit tests only, per `AGENTS.md`'s
placement ladder: a valid document from text and from a value, the
ledger-shaped five-field fixture, every refusal above with its message, and
first-defect-stops behaviour with the failing index named. `pnpm build`
emits `dist/learning-proposal.js` and `.d.ts`, and the `./learning-proposal`
export resolves from a consumer the same way `./afk-manifest` does.
