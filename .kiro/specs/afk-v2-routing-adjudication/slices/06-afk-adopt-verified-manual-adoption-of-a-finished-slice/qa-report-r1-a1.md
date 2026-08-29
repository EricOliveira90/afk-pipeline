# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness
- Sanity commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: FAIL
- Preservation check: FAIL

`pnpm install --frozen-lockfile` passed. Typecheck and full tests were skipped under the supplied authorization: gate attempt `b45b9505-4412-4b27-bc6b-ebdebd83947d` records PASS for `pnpm run typecheck` and `pnpm run test`, and its tree ID matches `HEAD^{tree}` at `03882754f666185b3f1f4e89cbe19a9e0014ddf5`.

## Pass 2: Quality & Craft
- Convention compliance: NOT RUN
- Code quality: NOT RUN
- Test quality: NOT RUN

Pass 2 was not run because Pass 1 is not clean.

## Resolved findings
- none

## Findings
### Finding 1 — Missing reason value is parsed as another option
**Severity:** Blocker
**Pass:** 1
**Evidence:** `node --import tsx src/afk.ts adopt demo 129 --branch missing --reason --adopter QA` reached Git resolution and returned `Adoption refused: Feature branch not found: feat/demo`. `src/adopt-command.ts:61-80` accepts `--adopter` as the value of `--reason`.
**What the contract expected:** “Given a missing, empty, or whitespace-only reason ... it is refused, no merge occurs, no adoption record is written, and neither branch nor run state changes.”
**What I observed:** A syntactically missing reason passes validation instead of being refused before Git work.

### Finding 2 — Verified-tip check and feature update are not atomic
**Severity:** Blocker
**Pass:** 1
**Evidence:** `src/adopt-command.ts:251-266` checks branch tips and then separately calls `mergeSliceBranch`. A feature-ref update in that window makes the merge operate on an unverified tip. The tree mismatch at lines 273-278 refuses only after the merge has moved the feature ref, with no rollback.
**What the contract expected:** “Only after every gate passes does the feature ref move once” to the verified candidate merge tree.
**What I observed:** A concurrent update can install an unverified merge and then produce an unsuccessful command result.

### Finding 3 — Ordinary summary rendering changes
**Severity:** Blocker
**Pass:** 1
**Evidence:** `src/logger.ts:299-301` makes `adoptionSection` empty without adoptions, but line 329 still interpolates it on a dedicated line. Compared with `git show 8186ee1:src/logger.ts`, ordinary summaries gain one newline.
**What the contract expected:** “Given a run with no adopted slices ... both output locations retain their current rendering.”
**What I observed:** Every no-adoption summary has byte-level whitespace drift.

### Finding 4 — Necessary lifecycle file is undeclared
**Severity:** Blocker
**Pass:** 1
**Evidence:** `git diff --name-status 8186ee1...HEAD` reports `M src/slice-lifecycle.ts`; the locked file list omits it. The change is necessary to carry adoption metadata into restored PASS lifecycle records.
**What the contract expected:** Necessary implementation files are declared by the locked contract.
**What I observed:** The contract needs a `SCOPE_AMENDMENT` for `src/slice-lifecycle.ts`; removing the change would break required provenance reporting.
