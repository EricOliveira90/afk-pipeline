# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness
- Sanity commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: FAIL

## Pass 2: Quality & Craft
- Convention compliance: NOT RUN
- Code quality: NOT RUN
- Test quality: NOT RUN

## Resolved findings
- none

## Findings
### Finding 1 - Gate output can survive checkpoint restoration and affect the next gate
**Severity:** Major
**Pass:** 1
**Evidence:** `src/gate-runner.ts:518-527` restores with `git reset --hard` and `git clean -fdx`, then checks only `HEAD`'s tree ID. In an isolated temporary repository, creating an untracked nested Git repository as gate output, running the same `git clean -fdx`, and testing the path printed `NESTED_REPOSITORY_SURVIVED`. Git intentionally preserves nested repositories unless clean receives a second `-f`; the unchanged root `HEAD` tree therefore cannot detect the leftover directory. The full `pnpm test` suite has no scenario for this case and passed despite the reproduced leak.
**What the contract expected:** "After each successful generator invocation, AFK creates and identifies an immutable candidate checkpoint before any base gate starts; later working-tree edits cannot affect gate input or evidence."
**What I observed:** A gate can create an untracked nested repository that remains in the detached checkpoint after restoration. Every later gate runs with that extra directory present while its result is still keyed to the original checkpoint tree ID, so gate input is neither exact nor isolated.
