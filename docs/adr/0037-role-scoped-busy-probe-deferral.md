# Busy-probe idle-kill deferral is role-scoped

Narrows ADR 0021, which wired the busy probe into every invocation
unconditionally.

## Failure mode

In the PRD 1 run (`afk-v2-evidence-backbone`, codex), slice #77's
planner ran 31.9 minutes. It went silent for its full 180 s idle
timeout nine times, and each time the busy probe deferred the kill
because 10–14 spawned processes were live (`idle-deferral` warns in
`events.jsonl`). A planner writes a contract; it has no business
running a test suite — yet its own spawned processes kept it alive
through nine idle windows. That single invocation set the wave's
Phase A barrier and delayed the sibling slice's generator by 26
minutes.

ADR 0021 built the probe for one distinction — "silent but working"
vs. "silent and hung" — where "working" meant a generator's
legitimately long test suite. Applied to every role, the probe turned
into the opposite of a bound: any role that spawns processes it
shouldn't earns deferrals it shouldn't have.

## Decision — deferral is opt-in per invocation

`InvokeOptions` gains `deferIdleKillWhenBusy` (default `false`). The
invocation runtime creates the busy probe and wires `shouldDefer` /
`onDefer` into the idle watcher only when the flag is set; otherwise
the idle timeout kills unconditionally, exactly the pre-ADR-0021
behavior.

The orchestrator sets the flag for the two roles whose long-running
commands the probe was built for:

- **generator** — TDD loops against real test suites.
- **evaluator-qa** — runs the full suite with piped output (both the
  deterministic and shared-preview stages).

Explorer, planner, evaluator-contract, and guardian invocations get no
probe: they hit the plain idle timeout (provider default 180 s — the
per-role idle timeouts themselves are unchanged). Their prompts already
forbid or never suggest running suites; `prompts/planner.md` now states
the prohibition explicitly, but the mechanical bound is what holds.

## Why this stays safe

- The wall-clock ceiling still bounds opted-in roles (ADR 0019), so a
  hung spawned command cannot defer forever — unchanged from ADR 0021.
- A fast role that legitimately shells out to something brief is
  unaffected: sub-180 s commands finish inside the idle window.
- The failure posture for opted-out roles is the strictly older, better
  understood one: silence past the timeout is a kill.

## What stays untouched

- `src/busy-probe.ts` and `src/idle-watcher.ts` — same shapes; only who
  wires them together changes.
- The `idle-deferral` warn event and its `afk status` surfacing — they
  now simply only occur for opted-in roles.
- Per-role idle timeouts (ADR 0008) and the kiro progress filter
  (ADR 0016).
