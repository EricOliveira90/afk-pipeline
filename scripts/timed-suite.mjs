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
 * The three `clean-failed` runs that verified this say both halves of that
 * at once. Untraced: 23.5s. Traced: 39.6s and 30.9s — and **203 git
 * processes both times**. The seconds moved 28% between two runs of one
 * unchanged tree; the count did not move at all.
 *
 * The count is not free either, and the cost lands on the seconds: with
 * trace2 on, git walks the Windows process ancestry at startup, which a
 * microbench puts at ~70ms per process on the dev machine of record (`git
 * status` 108ms plain against 180ms traced, and the same 180ms with an
 * event file, EVENT_BRIEF or EVENT_NESTING=0 — so it is the walk, not the
 * I/O). Against 203 processes that predicts ~14s, and the two traced runs
 * came in +16.1s and +7.4s on a host too noisy to pin it closer. So read a
 * traced run's seconds as high against `suite-budgets.json`, evenly across
 * the chain, which the check attributes as host load and warns about:
 * compare counts against traced runs and seconds against untraced ones.
 * `suite-budgets.json`'s `_comment` carries the same warning for whoever
 * reads a red chain.
 *
 * Usage: node scripts/timed-suite.mjs <suite-name> <command> [args...]
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
const traceDir = mkdtempSync(join(tmpdir(), `afk-suite-trace-${suite}-`));

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
    { stdio: "inherit", env: { ...process.env, GIT_TRACE2_EVENT: traceDir } },
  );
  // Stop the clock before reading the traces: counting thousands of files is
  // seconds of its own and none of it is the suite's cost.
  seconds = (Date.now() - startedAt) / 1000;
  gitProcesses = countGitProcesses(traceDir);
} finally {
  rmSync(traceDir, { recursive: true, force: true });
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
