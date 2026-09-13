#!/usr/bin/env node
/**
 * Runs one test suite and records how long it took and how many git
 * processes it spawned, for `scripts/check-suite-budgets.mjs`.
 *
 * Wall clock is the metric on purpose. Vitest's JSON reporter times only
 * test bodies, and the consolidated suites deliberately do their spawning
 * in `beforeAll` — budgeting the reporter's number would hand out hook
 * time for free, which is the whole cost we are trying to hold down.
 *
 * But wall clock is also a measurement of the host, which is why
 * `suite-budgets.json` is mostly a history of overruns that turned out to
 * be Defender, or a resident agent session, or msedgewebview2. The git
 * process count is the other half: the suites are ~95% synchronous git
 * spawns by wall clock, and the count of them is exact, repeatable and
 * indifferent to how busy the machine is. A count that rises with the test
 * total flat is a cost the diff added, wherever the seconds happened to
 * land that afternoon.
 *
 * The count is exact and it repeats: 203 for `clean-failed` across four
 * traced runs spanning 21.9-39.6s, 1365 for `resume-integration` across
 * two. The seconds moved 80%; neither count moved at all.
 *
 * It is not free, so it is opt-in — set `AFK_SUITE_GIT_TRACE=1` on the runs
 * you are pricing a change with. trace2 makes git walk the Windows process
 * ancestry at startup, and paired interleaved alone-runs on a quiet host
 * put that at ~41ms per process, which on these suites is 60-70% of their
 * wall clock:
 *
 *   suite                trace off        trace on          processes
 *   clean-failed         13.9 / 13.1s     22.6 / 22.6s            203
 *   resume-integration   83.0 / 95.1s    141.1 / 148.8s          1365
 *
 * So nothing sets the variable for you, `pnpm test` included. The AFK gates
 * and the pre-ship sanity gate would pay 60% for a number none of them
 * reads, and `test:ratchet` compares seconds against `suite-budgets.json`:
 * a traced chain reads high *unevenly*, because the tax tracks each suite's
 * git count rather than its seconds, which is precisely the mis-attribution
 * ADR 0063 built the check to avoid. Read seconds off untraced runs and
 * counts off traced ones; §5.3 of the speedup analysis already prescribes
 * an alone-run pair per change, which is where the variable belongs.
 *
 * An event *directory* (one trace file per process) and a single appended
 * event *file* measured the same — 22.6s against 22.1s on `clean-failed`,
 * inside the noise — so the per-process file create is not the cost and the
 * directory form stays: it is the one git documents as safe for concurrent
 * processes.
 *
 * Usage: node scripts/timed-suite.mjs <suite-name> <command> [args...]
 *        AFK_SUITE_GIT_TRACE=1 node scripts/timed-suite.mjs … (adds the count)
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [suite, command, ...args] = process.argv.slice(2);
if (suite === undefined || command !== "vitest") {
  console.error(
    "usage: node scripts/timed-suite.mjs <suite-name> vitest [args...]",
  );
  process.exit(2);
}

/**
 * How many git processes wrote a trace into `dir`, or null if the traces
 * could not be read.
 *
 * `GIT_TRACE2_EVENT` pointed at a directory makes every git process write
 * its own file there, opening it with one `"event":"start"` record — so the
 * count of those records is the count of git processes, including the git
 * spawned by a child node or pnpm, because the variable is inherited all
 * the way down. Counting records rather than files is deliberate: a process
 * killed mid-write (the cancellation scenarios do that on purpose) can
 * leave a file behind that no `start` record belongs to.
 *
 * Never throws. A count is a measurement, and losing it must not lose the
 * suite's exit code.
 */
function countGitProcesses(dir) {
  try {
    let started = 0;
    for (const entry of readdirSync(dir)) {
      const trace = readFileSync(join(dir, entry), "utf-8");
      started += (trace.match(/"event":"start"/g) ?? []).length;
    }
    return started;
  } catch {
    return null;
  }
}

// Outside the repo on purpose: a heavy suite writes one trace file per git
// process — thousands of them — and a run killed before the cleanup below
// must not leave them anywhere `git add` can see.
const traceDir = /^(1|true|on)$/i.test(process.env.AFK_SUITE_GIT_TRACE ?? "")
  ? mkdtempSync(join(tmpdir(), `afk-suite-trace-${suite}-`))
  : null;

// Run vitest's ESM entry directly rather than the `.cmd` shim: no shell
// means the glob arguments reach vitest exactly as written, instead of
// being brace-expanded on the way through.
const startedAt = Date.now();
let result;
let seconds;
let gitProcesses = null;
try {
  result = spawnSync(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", ...args],
    {
      stdio: "inherit",
      env:
        traceDir === null
          ? process.env
          : { ...process.env, GIT_TRACE2_EVENT: traceDir },
    },
  );
  // Stop the clock before reading the traces: counting thousands of files is
  // seconds of its own and none of it is the suite's cost.
  seconds = (Date.now() - startedAt) / 1000;
  if (traceDir !== null) gitProcesses = countGitProcesses(traceDir);
} finally {
  if (traceDir !== null) rmSync(traceDir, { recursive: true, force: true });
}

const dir = ".vitest-reports";
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, `${suite}.json`),
  `${JSON.stringify(
    {
      suite,
      seconds,
      // Absent when the traces could not be read — the check treats a record
      // without the field as one that simply predates it.
      ...(gitProcesses === null ? {} : { gitProcesses }),
      exitCode: result.status ?? 1,
      // So the check can tell one `pnpm test` from timings left over
      // across several ad-hoc runs.
      finishedAt: Date.now(),
    },
    null,
    2,
  )}\n`,
  "utf-8",
);

console.log(
  `[suite-time] ${suite}: ${seconds.toFixed(1)}s` +
    (gitProcesses === null
      ? ""
      : `, ${gitProcesses} git process${gitProcesses === 1 ? "" : "es"}`),
);
process.exit(result.status ?? 1);
