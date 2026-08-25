# The generator's verification command is its own decision

Splits one decision into two. ADR 0012 keeps everything it decided: the
sanity command set is the single source for what the pre-ship gate runs
and what the QA evaluator is told to run. What changes is that the
generator's local verification command stops being drawn from that same
answer.

## Failure mode

The generator is told to run tests with `{{TEST_COMMAND}}` verbatim
(`prompts/generator.md`), and that placeholder resolved to the consumer
project's own test script — `test:run`, else `test`, else `pnpm test`.
On a repo whose suite takes 20+ minutes, that charges a whole-suite run
to every edit cycle in the loop.

Measured in the PRD 1 run (`afk-v2-evidence-backbone-codex`,
`run-20260825-113321`): slice #75's generator round made 103 shell
calls, 25 of them test runs and 8 typecheck, and spent roughly 75 of its
105 minutes inside test processes. It hit its bound and was killed with
the slice fully implemented and committed, before it ever handed off to
QA. ADR 0036 removed the bound that did the killing; this ADR removes
the reason it got there.

The mismatch is that one string was answering two different questions.
The gate asks "what proves this slice is shippable" and wants the whole
suite. The generator asks "what tells me this edit was wrong" and wants
the fastest signal that would catch it. A single resolver forced the
second question to accept the first question's answer.

## Decision — `resolveGeneratorTestCommand`, `--test-command`

The generator's verification command resolves through
`resolveGeneratorTestCommand(cwd, override)` in `preship.ts`:
the explicit `--test-command` override, else the project's test script,
else `pnpm test`. Passing nothing reproduces the old resolution exactly,
so default behaviour is unchanged for every existing consumer.

It lives beside `resolveSanityPlan` deliberately — the two resolvers are
the two answers, and a reader who finds one should see the other.

## Decision — the whole-suite guarantee moves per-checkpoint, not away

An override narrows what the generator runs between edits. It does not
narrow what has to pass before a slice ships:

- `resolveSanityPlan` still owns what the pre-ship sanity gate executes
  and what the QA evaluator is told to run (ADR 0012). Neither reads the
  override.
- The QA prompt no longer receives the generator's command at all. It
  previously took it as an informational `{{TEST_COMMAND}}`, which was
  harmless while the two were the same string and misleading once they
  could differ — QA would be shown a fast subset beside a full sanity
  list under an instruction not to run the tests twice.

So the full suite still runs, once per checkpoint (post-merge gate, QA
evaluator) instead of once per edit. A slice that only passes a subset
fails at the gate exactly as before.

## Why not lower the sanity gate instead

Considered: let `--test-command` narrow the gate too, so an operator
configures one command and everything uses it. Rejected — that is the
drift ADR 0012 exists to prevent, and it is the expensive direction of
the trade: a fast generator loop costs nothing if the checkpoint is
still whole-suite, while a fast checkpoint means slices ship on
unverified code.

## What stays untouched

- The sanity command set, the pre-ship gate, and the QA evaluator's
  instructions (ADR 0012, ADR 0033).
- `resolveTestCommand`, still the shared script-discovery step both
  resolvers build on.
- All invocation bounds (ADR 0007, 0019, 0036, 0037).
