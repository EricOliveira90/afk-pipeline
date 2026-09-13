# PRD 4 excerpt — `afk-v2-acceptance-scope-gates/prd.md` @ `93bf6bd`

### D1 — the gate policy lives in `afk.config.json`, and slice 01 builds its reader

`afk.config.json` (repo root, plan §3c policy 2) gains one optional
top-level `gatePolicy` object. Absent, every consumer falls back to
today's derived baseline catalog in `src/base-gates.ts`, so a consuming
project with no policy keeps current behavior — that is #85's "works with
the derived baseline catalog when no quality policy exists".

A new module `src/gate-policy.ts` reads and validates it. Ownership is
split so that one slice creates the module and two extend it:

| Key | Owner | Contents |
|---|---|---|
| `version` (required, `1`), `protectedPaths`, `riskClasses` | slice 01 (#84) | protected gate-policy paths, test globs, catalog-declared escalation risk classes |
| `acceptance` | slice 02 (#85) | the behavior-ID gate command and its match-count matcher |
| `cost` | slice 05 (#86) | cheapness threshold, related-test selection, prerequisites, `environmentSensitive` members, cache settings, skip detectors |

*Test fired: load-bearing silence about a data format.* Consequence:
**slices 02 and 05 are blocked by slice 01**, correcting both tickets'
former "none within this PRD".

### D5 — a protected-change waiver is an operator launch input

The waiver record lives in the PRD directory's `afk.json` as
`protectedChangeWaivers`, an array of
`{ riskClass, path, author, reason }`. It is read once at launch from
`--prd-dir`, alongside `selectedSlices` and `migrationPrefixes`. An agent
never writes one: a waiver that appears only in a candidate tree is not a
waiver, because the gate compares against the launch-time snapshot.

**Slice 01 must extend the manifest parser, not only read the key.**
`parseAfkManifest` (`src/afk-manifest.ts`) builds its result from four known
fields and rejects no unknown key, so `protectedChangeWaivers` in an `afk.json`
today is accepted and then silently discarded — including the one this PRD
pre-records. `AfkManifest`, `parseAfkManifest` and `trimUnclaimedMigrationPrefixes`
(which rebuilds the manifest from the parsed fields and would drop the array on
any rewrite) are therefore slice 01's, and an unknown `riskClass` must fail
closed at launch rather than at a park.

The `riskClass` vocabulary is an operator decision, settled here so no planner
spends a dispatch on it: slice 01 declares the literal strings
`gate-policy` (for `afk.config.json` and `suite-budgets.json`),
`deleted-test` and `skipped-test`. `gate-policy` is the class the pre-recorded
waiver in this directory's `afk.json` uses, and the two must match exactly.
Contract file scope never implies a waiver (plan §3d item 17). Each
applied waiver's four fields are recorded in gate evidence and
`run-summary.md`; an unwaived protected change parks the slice through
PRD 2's park-and-continue machinery with its risk class and exact path.

*Test fired: load-bearing silence about a security posture.* The whole
point of the gate is that the actor being constrained cannot author its
own exemption.

### D6 — deleted-test detection

A path matching `gatePolicy.protectedPaths.testGlobs` that exists on the
comparison base and not in the candidate tree is a deletion. Absent
policy, AFK's TypeScript/Vitest default glob `**/*.test.ts` applies. A
deletion fails closed naming the exact path unless a D5 waiver covers it.

