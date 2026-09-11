# An ID match is corroborated before it resolves identity

Date: 2026-09-11
Issues: #240, #247

Amends ADR 0057 decision 1 and its 2026-09-06 amendment, whose
identity-resolution rule — stable ID first, fingerprint second, and on a
collision the stable ID goes to the claimant whose ID equals the prior
`stableId` — gave a bare ID match authority it cannot carry. ADR 0057's
order-independence, one-to-one and durability invariants are unchanged and
still asserted; `findingFingerprint` and `guardianFindingFingerprint` are
unchanged, so every fingerprint already persisted in run state stays valid.

## Failure mode

ID-first resolution guards "same obligation, renamed ID" and not its
inverse, "same ID, different obligation" — which is exactly what a fresh
round or a restart-from-base produces the moment the low IDs it numbers from
are already spent. It cost real work twice:

- **#240** — slice #132 reran from base, the evaluator renumbered from
  `F-01`, and two brand-new blockers landing on spent `RESOLVED` numbers
  folded on as `REOPENED` with `occurrences: 3`. The non-progress detector
  called `OSCILLATION` and killed negotiation at round 1 of 2, forfeiting the
  round that existed to fix those two findings.
- **#247** — five guardian notes across two PRD 4 waves were skipped as
  already filed against unrelated obligations that merely shared their stable
  ID, so they shipped unfixed and unfiled, against #174's "filed exactly
  once". They are now #242–#246, filed by hand.

ADR 0057's amendment reasoned about the *collision* case, where two claimants
make "a known ID match always retains the prior stable identity"
unsatisfiable, and priced three alternatives against relaxing it there. The
sole-claimant case was left at bare ID precedence deliberately, and that is
the case both defects took.

## Decision — the amended rule

An ID match resolves identity only when it is corroborated: the content
fingerprint agrees, **or** the prior identity is still live in the same
numbering (`idMatchIsCorroborated`, `src/guardian-convergence.ts:54`).
Otherwise the claimant mints a suffixed identity (`F-03-2`, `P-01-2`) and
keeps its provided ID as `currentId`.

This replaces bare ID precedence at every site that resolved identity, the
collision tiebreak included — a claim is corroborated *before* it reaches the
tiebreak, so ADR 0057's amendment now reads: when neither fingerprint
matches and no prior is live, no claimant inherits the prior `stableId`.
Minting rather than reusing the bare ID is the other half of #247, where a
fresh round's `P-01` absorbed #216's title and clear condition because
`foldGuardianLedger` keys on `guardian + stableId`, last-wins.

For non-progress the discriminator is `occurrences`: a lineage's own fold
counter only grows while an identity is carried forward, so a **drop** proves
the stable ID was renumbered rather than continued. That is drift-tolerant —
it does not weaken A-B-A detection the way comparing text would — and it
also protects history persisted by a pre-fix build.

## Decision — the asymmetry between the two lineages is deliberate

Contract lineage keeps the liveness clause. Guardian lineage does not: its
sites pass `priorIsLive: false`, reducing the rule to "the fingerprint must
agree". Do not simplify this to one uniform rule; each half is measured on
the recorded PRD 4 corpus.

- **Contract needs liveness.** Within one negotiation the evaluator restates
  a live finding's `expected` and `clearCondition` freely as the round moves
  — **32 of 43** same-ID continuations rewrote one or the other, `RESOLVED`
  restatements included. Requiring an exact fingerprint there (what both
  issues proposed) would turn every `OPEN → RESOLVED` fold into a fresh entry
  and collapse `REPEATED` detection. A live prior therefore keeps ID
  precedence; only a terminal one demands the fingerprint, and the defect
  always presents as a fresh finding landing on a terminal number.
- **Guardians have no liveness signal and need none.** A guardian note is
  closed by ceasing to be reported, not by a terminal disposition. Of **35**
  same-ID guardian continuations, the **7** whose fingerprint changed are all
  this defect — there is no legitimate drifted-restatement population to
  protect.

## Consequences

- A reused-ID architect finding that used to block now ships as a filed
  note. A minted identity has no prior lineage, so ADR 0057 decision 3's
  round-aware rubric denies it blocking authority. This is #172's decided
  policy — new findings in later rounds report but do not block — applied
  correctly for the first time, not a loosening. The old behaviour blocked by
  inheriting an unrelated entry's status, which is the defect, not a
  safeguard being given up.
- A note that reuses a spent stable ID is now filed rather than skipped, so
  #174's "filed exactly once" holds per obligation instead of per ID.
- The P-03 and QA-05 acceptance wording still describes ID authority as ADR
  0057 first recorded it. This ADR is the amendment of record; that wording
  is superseded where it conflicts.

## Verification

Behaviour ships with this ADR's branch (`fix/240-247-finding-identity`), one
test per site, each reproducing the recorded case: slice #132's F-03/F-04 for
the fresh-on-spent fold and for ID precedence while the prior is live; round
4's `P-01` against #216's obligation for minting and for rejoining its own
lineage when a drifted fingerprint reverts; the note that became #242 for
filing; and A-B-A both across and within a continuous fold counter for
`OSCILLATION`. Five existing fixtures that encoded the ID-authority reading
were re-fixtured to carry a matching fingerprint, which is what each was
actually about.
