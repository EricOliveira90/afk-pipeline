# Contract feedback — round 2 (Prompt recorder, #264)

The round-1 findings are all answered, and the central one is answered well.
What sends the pair back is smaller and mechanical: two things this revision
did to the artifacts themselves.

## The round-1 findings

**The wiring seam (F-01) is fixed, and fixed at the right altitude.** Making
`providerForRun(inner, recordPrompts?)` an exported value instead of three
inline conditionals turns an obligation that only `typecheck` could "prove"
into two assertions that actually fail when the wiring is wrong. The unit test
fails if `providerForRun` returns `inner` for a flagged argv or fails to write
the sibling record; the source assertion in `src/cli-entries.test.ts` fails
both when an entry drops the wrap and when it wraps unconditionally. That is
the pair of failure modes the finding named, and neither host file needs a new
spawned pipeline, so P-05 is untouched. B-06's "no provider was wrapped" half
now rests on reference equality rather than on an absence that would have held
regardless.

**The test-host question (F-02) is settled, and the new file is defensible.**
`src/cli-entries.test.ts` is not in the PRD's file-scope map, but that map says
in as many words that it "does not list test files" and leaves S3's unit-test
layout to the slice (`prd.md:689-690`, `prd.md:699-704`), so declaring it is
the planner's call rather than a scope discovery. Likewise `providerForRun` as
a second export: D32's closed export table does not name this module.

**The `logStream.path` claim (F-03) checks out.** `src/agent-provider.ts:1`
imports `WriteStream` from `node:fs`, `:36` declares `logStream?: WriteStream`,
and this repo's installed `@types/node@22.19.19` declares `path: string |
Buffer` as a required member of `class WriteStream` (`fs.d.ts:528`). So
`String(options.logStream.path)` resolves with `src/agent-provider.ts`
untouched, and the non-goal now says that explicitly instead of leaving it
inferred. B-10 states the no-`.log`-suffix outcome as skip-and-continue with no
invented name, and explains why the branch is unreachable from production.

**The parser surface (F-04) now binds both halves.** `--record-prompt` and
`--record-prompts=false` are pinned as non-accepting, in `src/cli-options.test.ts`
— the established inline harness for this parser, so no fixture area is
implicated. Recording *why* silence beats a refusal (every existing boolean
flag at `:239-241` rejects nothing) is the right way to close that question
rather than escalating it.

**The over-claimed gates (F-05) are separated cleanly.** Both preservation
behaviors now say which half a gate produces and which half a human reads off
the diff, and the wall-clock claim is gone with ADR 0063 cited for why it could
never have been gate evidence.

## What this round introduced

**The manifest's `fileScope` lost the two doc paths.** The revision rewrote
`"CONTEXT.md"` / `"ARCHITECTURE.md"` as `"context.md"` / `"architecture.md"`.
Those files are `CONTEXT.md` and `ARCHITECTURE.md` on disk in this worktree.
The prior pair had them right, so this is a regression, and it is not cosmetic
here: this contract deliberately makes `fileScope` the enforcement surface —
P-01 and P-04 both argue from absence ("those paths are absent from the
manifest fileScope, so any edit is a scope violation"). Under that reading the
two edits B-09 requires are no longer declared. On a case-insensitive Windows
filesystem the mismatch may pass unnoticed locally and then read as an
out-of-scope edit under an exact-string check or a case-sensitive checkout.
Restore the original casing; the contract's "Files expected to change" list
already has it.

**B-10 exists only in `contract.md`.** The new behavior has an in-scope bullet,
a test-plan line (the `…/guardian-review.txt` stream) and a Definition-of-done
checkbox, but the manifest's `behaviors` array still runs B-01…B-09 and
P-01…P-05. So B-10 has no `gateIds`, is not selectable by
`acceptance:behaviors --testNamePattern B-10`, and nothing in the machine-read
half of the pair requires its test to exist — the fallback branch could ship
unwritten with every gate green. That is worth fixing precisely because B-10 is
the behavior carrying the derived-path failure mode raised last round: the
prose settles it, and the manifest should too. Add the entry with
`src/prompt-recorder.test.ts` as its host and `tests` plus
`acceptance:behaviors` as its gates.

Neither item asks for new design work. Fix the two casing entries, add the
B-10 manifest entry, and the pair is done.
