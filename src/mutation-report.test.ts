/**
 * Unit seam for the report-only mutation step (#303).
 *
 * Every assertion here is a pure function over a value: the report parser over
 * inlined fixture JSON, the classifier over its three inputs, the eligibility
 * predicate over a `ChangeSummary`, and the bounded-await helper over an
 * injected clock. No mutation tool runs, no report file is committed, and no
 * pipeline is spawned — per AGENTS.md's placement rule and the PRD's own
 * verification seam ("unit seams only; no spawned pipeline scenario and no real
 * mutation tool in tests").
 *
 * Two assertions here read source text rather than importing it: the
 * orchestrator call-order pin (B-07) and the ARCHITECTURE.md row (B-08). Both
 * are facts about *where* something is written, which no runtime assertion can
 * observe without spawning a run.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeSummary, ChangeSummaryFile } from "./change-summary.js";
import {
  MUTATION_REPORT_HEADING,
  MUTATION_STEP_BOUND_MS,
  awaitMutationStepWithinBound,
  classifyMutationStep,
  formatMutationReportLines,
  isMutationEligibleSource,
  mutationEligibleSources,
  parseMutationReport,
  readMutationReport,
  runMutationStep,
  type MutationStepOutcome,
} from "./mutation-report.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "afk-mutation-"));
  roots.push(root);
  return root;
}

/**
 * A mutation-testing-elements report as StrykerJS and its peers emit it,
 * inlined rather than committed: an on-disk fixture would be a second thing to
 * keep in step with the parser, and this slice adds no fixture files.
 */
const REPORT = {
  schemaVersion: "1",
  thresholds: { high: 80, low: 60 },
  files: {
    "src/cart.ts": {
      language: "typescript",
      source: "export const total = (n: number) => n * 2;\n",
      mutants: [
        {
          id: "1",
          mutatorName: "ArithmeticOperator",
          replacement: "n / 2",
          status: "Survived",
          location: { start: { line: 1, column: 36 }, end: { line: 1, column: 41 } },
        },
        {
          id: "2",
          mutatorName: "BlockStatement",
          status: "Killed",
          location: { start: { line: 1, column: 1 }, end: { line: 1, column: 42 } },
        },
        {
          id: "3",
          mutatorName: "ConditionalExpression",
          status: "NoCoverage",
          location: { start: { line: 1, column: 8 }, end: { line: 1, column: 13 } },
        },
      ],
    },
    "src/checkout.ts": {
      language: "typescript",
      source: "export const fee = 3;\n",
      mutants: [
        {
          id: "4",
          mutatorName: "EqualityOperator",
          status: "Timeout",
          location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } },
        },
        {
          id: "5",
          mutatorName: "StringLiteral",
          status: "Survived",
          location: { start: { line: 1, column: 20 }, end: { line: 1, column: 21 } },
        },
      ],
    },
  },
} as const;

const SURVIVOR_1 = {
  id: "1",
  file: "src/cart.ts",
  mutator: "ArithmeticOperator",
  position: { startLine: 1, startColumn: 36, endLine: 1, endColumn: 41 },
};
const SURVIVOR_5 = {
  id: "5",
  file: "src/checkout.ts",
  mutator: "StringLiteral",
  position: { startLine: 1, startColumn: 20, endLine: 1, endColumn: 21 },
};

function file(overrides: Partial<ChangeSummaryFile>): ChangeSummaryFile {
  return { path: "src/a.ts", status: "M", insertions: 1, deletions: 0, ...overrides };
}

function summary(files: ChangeSummaryFile[]): ChangeSummary {
  return {
    version: 1,
    fromRef: "main",
    toRef: "HEAD",
    commits: [],
    files,
    totals: { files: files.length, insertions: 0, deletions: 0, binaryFiles: 0 },
  } as ChangeSummary;
}

describe("[behavior:#303:B-08] the report parser", () => {
  it("[behavior:#303:B-08] returns every survivor's identity, file, position and mutator", () => {
    const read = parseMutationReport(JSON.stringify(REPORT));
    expect(read).toEqual({ status: "PARSED", survivors: [SURVIVOR_1, SURVIVOR_5] });
  });

  it("[behavior:#303:B-08] returns only survivors: a killed or uncovered mutant is a decided fact", () => {
    const read = parseMutationReport(JSON.stringify(REPORT));
    expect(read.status).toBe("PARSED");
    if (read.status !== "PARSED") return;
    // Killed (2), NoCoverage (3) and Timeout (4) are all absent. A report-only
    // step reports blind spots; it has nothing to say about a mutant the suite
    // already answered, and a kill *count* is exactly the number this PRD
    // refuses to publish (ADR 0071).
    expect(read.survivors.map((survivor) => survivor.id)).toEqual(["1", "5"]);
  });

  it("[behavior:#303:B-08] reports zero survivors as a parse, not as an absent report", () => {
    const clean = {
      files: {
        "src/cart.ts": {
          mutants: [{ id: "1", mutatorName: "X", status: "Killed", location: {} }],
        },
      },
    };
    expect(parseMutationReport(JSON.stringify(clean))).toEqual({
      status: "PARSED",
      survivors: [],
    });
  });

  it.each([
    ["not JSON at all", "{ this is not json", /not valid JSON/],
    ["a JSON array", "[]", /must be a JSON object/],
    ["a JSON scalar", "42", /must be a JSON object/],
    ["no files member", "{}", /must hold a files object/],
    [
      "a non-object file entry",
      JSON.stringify({ files: { "src/a.ts": "nope" } }),
      /entry for src\/a\.ts must be an object/,
    ],
    [
      "a file entry with no mutants array",
      JSON.stringify({ files: { "src/a.ts": { mutants: {} } } }),
      /must hold a mutants array/,
    ],
    [
      "a survivor with no id",
      JSON.stringify({
        files: {
          "src/a.ts": {
            mutants: [
              {
                mutatorName: "X",
                status: "Survived",
                location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
              },
            ],
          },
        },
      }),
      /without an id, mutator and location/,
    ],
    [
      "a survivor with no location",
      JSON.stringify({
        files: { "src/a.ts": { mutants: [{ id: "1", mutatorName: "X", status: "Survived" }] } },
      }),
      /without an id, mutator and location/,
    ],
  ])(
    "[behavior:#303:B-08] degrades the whole report for %s rather than shortening the list",
    (_label, text: string, detail: RegExp) => {
      const read = parseMutationReport(text);
      expect(read.status).toBe("MALFORMED");
      if (read.status !== "MALFORMED") return;
      expect(read.detail).toMatch(detail);
    },
  );

  it("[behavior:#303:B-08] never throws, whatever it is handed", () => {
    // The parser runs inside a report-only step. A throw would travel up a path
    // whose whole promise is that it cannot change any outcome.
    for (const text of ["", "null", "true", '{"files":null}', "\u0000"]) {
      expect(() => parseMutationReport(text)).not.toThrow();
    }
  });

  it("[behavior:#303:B-08] reads the declared file, and calls a missing one unreadable", () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "mutation.json"), JSON.stringify(REPORT));
    expect(readMutationReport(cwd, "mutation.json")).toEqual({
      status: "PARSED",
      survivors: [SURVIVOR_1, SURVIVOR_5],
    });
    const missing = readMutationReport(cwd, "reports/absent.json");
    expect(missing.status).toBe("UNREADABLE");
  });

  it("[behavior:#303:B-08] is documented as a ship-path internal, not a new architecture row", () => {
    const architecture = readFileSync("ARCHITECTURE.md", "utf-8");
    const shipRows = architecture
      .split("\n")
      .filter((line) => line.startsWith("| Ship path |"));
    expect(shipRows).toHaveLength(1);
    // The step is reached through `src/ship-gate.ts`; nothing outside the ship
    // path imports it, so it is an internal of that row rather than a seam of
    // its own (the hub rule: new behavior is a new module with one call site).
    expect(shipRows[0]).toContain("`src/mutation-report.ts`");
    expect(shipRows[0]).toContain("`src/ship-gate.ts`");
    // The 150-line cap is the envelope budget the explorer and planner read.
    expect(architecture).toContain("Cap: 150 lines.");
    // Count lines the way `wc -l` does: a trailing newline closes the last line
    // rather than opening an empty one, so drop that one empty tail element and
    // nothing else.
    const lines = architecture.split("\n");
    const lineCount = lines.at(-1) === "" ? lines.length - 1 : lines.length;
    expect(lineCount).toBeLessThanOrEqual(150);
  });
});

describe("[behavior:#303:B-09] the step classifier", () => {
  it("[behavior:#303:B-09] reports the survivors when the command ran and the report parsed", () => {
    expect(
      classifyMutationStep({
        exit: { status: "OK" },
        report: { status: "PARSED", survivors: [SURVIVOR_1] },
        deadline: "INSIDE",
      }),
    ).toEqual({ status: "MUTATION_REPORTED", survivors: [SURVIVOR_1] });
  });

  it("[behavior:#303:B-09] reports an empty survivor list as an answer, not as a non-run", () => {
    expect(
      classifyMutationStep({
        exit: { status: "OK" },
        report: { status: "PARSED", survivors: [] },
        deadline: "INSIDE",
      }),
    ).toEqual({ status: "MUTATION_REPORTED", survivors: [] });
  });

  it.each([
    [
      "the bound was reached",
      {
        exit: { status: "OK" } as const,
        report: { status: "PARSED" as const, survivors: [SURVIVOR_1] },
        deadline: "REACHED" as const,
      },
      "BOUND_REACHED",
    ],
    [
      "the command failed",
      {
        exit: { status: "FAILED" as const, detail: "exit 1" },
        deadline: "INSIDE" as const,
      },
      "COMMAND_FAILED",
    ],
    [
      "the report could not be read",
      {
        exit: { status: "OK" } as const,
        report: { status: "UNREADABLE" as const, detail: "ENOENT" },
        deadline: "INSIDE" as const,
      },
      "REPORT_UNREADABLE",
    ],
    [
      "no report was read at all",
      { exit: { status: "OK" } as const, deadline: "INSIDE" as const },
      "REPORT_UNREADABLE",
    ],
    [
      "the report did not parse",
      {
        exit: { status: "OK" } as const,
        report: { status: "MALFORMED" as const, detail: "no files object" },
        deadline: "INSIDE" as const,
      },
      "REPORT_MALFORMED",
    ],
  ])(
    "[behavior:#303:B-09] says the step did not run, and why, when %s",
    (_label, input: Parameters<typeof classifyMutationStep>[0], reason: string) => {
      expect(classifyMutationStep(input)).toEqual({
        status: "MUTATION_NOT_RUN",
        reason,
      });
    },
  );

  it("[behavior:#303:B-09] prefers the deadline over a report a cut run happened to leave behind", () => {
    // A run terminated at the bound may have written a partial report. Reading
    // it as an answer would publish "these are the survivors" from a suite that
    // never finished — the one dishonest outcome this classifier can produce.
    expect(
      classifyMutationStep({
        exit: { status: "FAILED", detail: "killed" },
        report: { status: "PARSED", survivors: [SURVIVOR_1, SURVIVOR_5] },
        deadline: "REACHED",
      }),
    ).toEqual({ status: "MUTATION_NOT_RUN", reason: "BOUND_REACHED" });
  });
});

describe("[behavior:#303:B-10] mutation-eligible file scope", () => {
  it("[behavior:#303:B-10] keeps changed source files and drops what cannot carry a mutant", () => {
    const files = [
      file({ path: "src/cart.ts", status: "M" }),
      file({ path: "src/added.tsx", status: "A" }),
      file({ path: "scripts/tool.mjs", status: "M" }),
      file({ path: "src/legacy.cjs", status: "M" }),
      file({ path: "src/plain.js", status: "M" }),
      file({ path: "src/gone.ts", status: "D" }),
      file({ path: "src/types.d.ts", status: "M" }),
      file({ path: "src/cart.test.ts", status: "M" }),
      file({ path: "src/cart.spec.tsx", status: "M" }),
      file({ path: "src/data.fixtures.ts", status: "M" }),
      file({ path: "ARCHITECTURE.md", status: "M" }),
      file({ path: "afk.config.json", status: "M" }),
      file({ path: "prompts/cleaner.md", status: "A" }),
    ];
    expect(mutationEligibleSources(summary(files))).toEqual([
      "src/cart.ts",
      "src/added.tsx",
      "scripts/tool.mjs",
      "src/legacy.cjs",
      "src/plain.js",
    ]);
  });

  it("[behavior:#303:B-10] drops a deleted file however git spells the status", () => {
    // Mutating a file that no longer exists is a guaranteed tool error, and the
    // step's failure would be reported as though the suite were weak.
    for (const status of ["D", "DD", "D "]) {
      expect(isMutationEligibleSource(file({ path: "src/gone.ts", status }))).toBe(
        false,
      );
    }
    // Everything else still has a file at the reported path — a rename reports
    // its destination — so it stays in scope.
    for (const status of ["R100", "A", "M", "T", "C075"]) {
      expect(isMutationEligibleSource(file({ path: "src/here.ts", status }))).toBe(
        true,
      );
    }
  });

  it("[behavior:#303:B-10] hands the command one separator, whichever one git reported", () => {
    expect(
      mutationEligibleSources(summary([file({ path: "src\\deep\\cart.ts" })])),
    ).toEqual(["src/deep/cart.ts"]);
  });

  it("[behavior:#303:B-10] derives the scope from the one change-summary builder, never a second producer", () => {
    // The seam rule for `src/change-summary.ts`: a new consumer binds the two
    // refs, it does not re-implement the diff. This module names the builder
    // and declares no walk of its own.
    const source = readFileSync(join("src", "mutation-report.ts"), "utf-8");
    expect(source).toContain('from "./change-summary.js"');
    expect(source).toContain("buildChangeSummary(");
    expect(source).not.toMatch(/["'`]diff --name-status|--numstat/);
  });
});

describe("[behavior:#303:B-11] runMutationStep", () => {
  it("[behavior:#303:B-11] invokes the declared command over the derived scope, then reads the report file", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "mutation.json"), JSON.stringify(REPORT));
    const mutationRun = vi.fn(async () => "stryker: 47% score, 12 mutants\n");

    const outcome = await runMutationStep({
      cwd,
      fromRef: "main",
      toRef: "HEAD",
      config: { command: "pnpm run mutate", reportPath: "mutation.json" },
      isAbandoned: () => false,
      mutationRun,
      mutationScope: async () => ["src/cart.ts", "src/checkout.ts"],
    });

    expect(mutationRun).toHaveBeenCalledTimes(1);
    expect(mutationRun.mock.calls[0]).toEqual([
      "pnpm run mutate",
      ["src/cart.ts", "src/checkout.ts"],
      { cwd, encoding: "utf-8" },
    ]);
    // The seam returned prose carrying a score; the outcome carries the file's
    // survivors. The report *file* is the source of results, never stdout.
    expect(outcome).toEqual({
      status: "MUTATION_REPORTED",
      survivors: [SURVIVOR_1, SURVIVOR_5],
    });
  });

  it("[behavior:#303:B-11] never invokes the command once the caller has abandoned the step", async () => {
    const cwd = tempDir();
    const mutationRun = vi.fn(async () => "");

    const outcome = await runMutationStep({
      cwd,
      fromRef: "main",
      toRef: "HEAD",
      config: { command: "pnpm run mutate", reportPath: "mutation.json" },
      isAbandoned: () => true,
      mutationRun,
      mutationScope: async () => ["src/cart.ts"],
    });

    // No process, and nothing to publish: an abandoned step is a step that did
    // not happen, not a `MUTATION_NOT_RUN` the summary would explain.
    expect(mutationRun).not.toHaveBeenCalled();
    expect(outcome).toBeUndefined();
  });

  it("[behavior:#303:B-11] reads the abandonment flag with no await between the check and the spawn", () => {
    // The flag is set by a caller running concurrently, so any `await` between
    // reading it and spawning is a window in which a spawn happens after the
    // decision not to spawn. Asserted at the source, because the gap it guards
    // against is a scheduling fact no value can expose.
    const source = readFileSync(join("src", "mutation-report.ts"), "utf-8");
    const checkedAt = source.indexOf("if (args.isAbandoned()) return undefined;");
    const invokedAt = source.indexOf("started = run(args.config.command");
    expect(checkedAt).toBeGreaterThan(-1);
    expect(invokedAt).toBeGreaterThan(checkedAt);
    expect(source.slice(checkedAt, invokedAt)).not.toContain("await");
  });

  it("[behavior:#303:B-11] says the command failed when the command failed, and reads no report", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "mutation.json"), JSON.stringify(REPORT));

    expect(
      await runMutationStep({
        cwd,
        fromRef: "main",
        toRef: "HEAD",
        config: { command: "pnpm run mutate", reportPath: "mutation.json" },
        isAbandoned: () => false,
        mutationRun: async () => {
          throw new Error("exited with code 1");
        },
        mutationScope: async () => ["src/cart.ts"],
      }),
      // A report on disk from an earlier run must not be reported as this run's
      // answer once the command that should have rewritten it failed.
    ).toEqual({ status: "MUTATION_NOT_RUN", reason: "COMMAND_FAILED" });
  });

  it("[behavior:#303:B-11] treats a runner that throws synchronously as a failed command", async () => {
    expect(
      await runMutationStep({
        cwd: tempDir(),
        fromRef: "main",
        toRef: "HEAD",
        config: { command: "pnpm run mutate", reportPath: "mutation.json" },
        isAbandoned: () => false,
        mutationRun: () => {
          throw new Error("spawn ENOENT");
        },
        mutationScope: async () => ["src/cart.ts"],
      }),
    ).toEqual({ status: "MUTATION_NOT_RUN", reason: "COMMAND_FAILED" });
  });

  it("[behavior:#303:B-11] says the report was unreadable when the command wrote nothing", async () => {
    expect(
      await runMutationStep({
        cwd: tempDir(),
        fromRef: "main",
        toRef: "HEAD",
        config: { command: "pnpm run mutate", reportPath: "reports/mutation.json" },
        isAbandoned: () => false,
        mutationRun: async () => "done",
        mutationScope: async () => ["src/cart.ts"],
      }),
    ).toEqual({ status: "MUTATION_NOT_RUN", reason: "REPORT_UNREADABLE" });
  });
});

describe("[behavior:#303:B-12] the bounded wait", () => {
  const never = (): Promise<MutationStepOutcome | undefined> => new Promise(() => {});

  it("[behavior:#303:B-12] fixes the bound at thirty minutes, in the module that waits", () => {
    // Flat and not configurable in this PRD: a tunable bound is a number to
    // optimize, and a bound an operator can raise becomes a gate by accident
    // (ADR 0063). It lives beside the helper so no caller can pass its own.
    expect(MUTATION_STEP_BOUND_MS).toBe(30 * 60 * 1000);
    expect(readFileSync(join("src", "mutation-report.ts"), "utf-8")).toContain(
      "export const MUTATION_STEP_BOUND_MS",
    );
    // No caller carries a deadline of its own, and no option names one: the
    // ship gate hands the helper an origin, never a duration.
    const shipGate = readFileSync(join("src", "ship-gate.ts"), "utf-8");
    expect(shipGate).not.toContain("30 * 60 * 1000");
    expect(shipGate).not.toMatch(/MUTATION_STEP_BOUND_MS[,;)\s]*=/);
    for (const name of ["src/cli-options.ts", "src/orchestrator.ts"]) {
      expect(readFileSync(name, "utf-8")).not.toMatch(/mutationBound|mutationTimeout/);
    }
  });

  it("[behavior:#303:B-12] returns the step's own outcome when it settles inside the bound", async () => {
    const terminate = vi.fn(async () => {});
    const outcome = await awaitMutationStepWithinBound({
      step: Promise.resolve<MutationStepOutcome>({
        status: "MUTATION_REPORTED",
        survivors: [SURVIVOR_1],
      }),
      origin: 1_000,
      now: () => 1_000,
      delay: never as unknown as (ms: number) => Promise<void>,
      terminate,
    });
    expect(outcome).toEqual({ status: "MUTATION_REPORTED", survivors: [SURVIVOR_1] });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("[behavior:#303:B-12] terminates and reports BOUND_REACHED when the deadline passes first", async () => {
    const terminate = vi.fn(async () => {});
    const outcome = await awaitMutationStepWithinBound({
      step: never(),
      origin: 5_000,
      now: () => 5_000,
      delay: async (ms) => {
        // The helper asks for exactly the time left, not the whole bound.
        expect(ms).toBe(MUTATION_STEP_BOUND_MS);
      },
      terminate,
    });
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: "MUTATION_NOT_RUN", reason: "BOUND_REACHED" });
  });

  it("[behavior:#303:B-12] measures the deadline from the origin it was given, not from when it was called", async () => {
    const delay = vi.fn(async () => {});
    const terminate = vi.fn(async () => {});
    await awaitMutationStepWithinBound({
      step: never(),
      origin: 1_000,
      now: () => 1_000 + 10 * 60 * 1000,
      delay,
      terminate,
    });
    // Twenty of the thirty minutes are left: an exit that captures its own
    // origin cannot hand the step a fresh full bound.
    expect(delay).toHaveBeenCalledWith(20 * 60 * 1000);
  });

  it("[behavior:#303:B-12] terminates without waiting at all when the bound is already spent", async () => {
    const delay = vi.fn(async () => {});
    const terminate = vi.fn(async () => {});
    const outcome = await awaitMutationStepWithinBound({
      step: never(),
      origin: 0,
      now: () => MUTATION_STEP_BOUND_MS + 1,
      delay,
      terminate,
    });
    expect(delay).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: "MUTATION_NOT_RUN", reason: "BOUND_REACHED" });
  });

  it("[behavior:#303:B-12] still reports BOUND_REACHED when termination itself fails", async () => {
    // A failed quiesce is the worktree teardown's problem to report; it must not
    // replace this exit's reason or throw into a report-only path.
    const outcome = await awaitMutationStepWithinBound({
      step: never(),
      origin: 0,
      now: () => MUTATION_STEP_BOUND_MS,
      delay: async () => {},
      terminate: () => {
        throw new Error("quiesce failed");
      },
    });
    expect(outcome).toEqual({ status: "MUTATION_NOT_RUN", reason: "BOUND_REACHED" });
  });

  it("[behavior:#303:B-12] swallows a step rejection instead of propagating it", async () => {
    // Every caller of this helper is on a path that owns its own reason — a
    // guardian's rethrow, or a gate result. A step rejection must not become it.
    const outcome = await awaitMutationStepWithinBound({
      step: Promise.reject(new Error("step blew up")),
      origin: 0,
      now: () => 0,
      delay: never as unknown as (ms: number) => Promise<void>,
      terminate: async () => {},
    });
    expect(outcome).toBeUndefined();
  });

  it("[behavior:#303:B-12] terminates through the one quiesce path, with no kill of its own", () => {
    const source = readFileSync(join("src", "mutation-report.ts"), "utf-8");
    // ADR 0020/0035: a detached post-exit process is refused by design, and the
    // registry is how teardown finds the child. A second kill path here would
    // be a process the worktree teardown never sees.
    expect(source).toContain("registerWorktreeProcess(");
    expect(source).not.toContain("kill-tree.js");
    expect(source).not.toContain("process.kill(");
  });
});

describe("[behavior:#303:B-07] the launch refusal runs before any agent is dispatched", () => {
  it("[behavior:#303:B-07] sits inside the manifest fail-closed block, ahead of state, preflight and the first wave", () => {
    // Fail closed at zero tokens: the refusal is a source-order fact about the
    // one call site, and pinning it here keeps the seam out of the spawned
    // orchestrator suites (a new spawned scenario is the last resort).
    const source = readFileSync(join("src", "orchestrator.ts"), "utf-8");
    const scopeAt = source.indexOf("assertWithinManifestScope({");
    const refusalAt = source.indexOf("refuseUndeclaredMutationReport({");
    const stateAt = source.indexOf("const initialized = updateRunState(");
    const preflightAt = source.indexOf("runLaunchPreflight(");
    const waveAt = source.indexOf("runWave(");

    expect(scopeAt).toBeGreaterThan(-1);
    expect(scopeAt).toBeLessThan(refusalAt);
    expect(refusalAt).toBeLessThan(stateAt);
    expect(stateAt).toBeLessThan(preflightAt);
    expect(preflightAt).toBeLessThan(waveAt);
    // The reason is thrown, not journaled and continued: a run that asked for
    // the report and cannot produce it must not look like a run with no
    // survivors.
    expect(source).toContain("if (undeclaredMutationReport) throw new Error(");
  });
});

describe("[behavior:#303:B-14] the one shared report text", () => {
  it("[behavior:#303:B-14] lists each survivor with its identity, location and mutator", () => {
    expect(
      formatMutationReportLines({
        status: "MUTATION_REPORTED",
        survivors: [SURVIVOR_1, SURVIVOR_5],
      }),
    ).toEqual([
      "- `1` src/cart.ts:1:36 — ArithmeticOperator",
      "- `5` src/checkout.ts:1:20 — StringLiteral",
    ]);
  });

  it("[behavior:#303:B-14] says so explicitly when nothing survived", () => {
    // Silence would be indistinguishable from a step that never ran, which is
    // the one thing this report exists to disambiguate.
    expect(
      formatMutationReportLines({ status: "MUTATION_REPORTED", survivors: [] }),
    ).toEqual(["- No surviving mutants in the changed source files."]);
  });

  it("[behavior:#303:B-14] names the reason, and that nothing was gated, when the step did not run", () => {
    const lines = formatMutationReportLines({
      status: "MUTATION_NOT_RUN",
      reason: "BOUND_REACHED",
      survivors: [],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("BOUND_REACHED");
    expect(lines[0]).toContain("ADR 0063");
    expect(MUTATION_REPORT_HEADING).toContain("never blocking");
  });

  it("[behavior:#303:B-14] states the reason is missing rather than naming one the run never observed", () => {
    // `reason` is optional on both the `mutation-step` event payload and the
    // persisted record, so a reasonless not-run report is reachable from disk.
    // Substituting a concrete reason here would put a diagnosis in the run
    // summary and the PR body that nothing in the run ever produced.
    const lines = formatMutationReportLines({
      status: "MUTATION_NOT_RUN",
      survivors: [],
    });
    expect(lines).toHaveLength(1);
    for (const reason of [
      "BOUND_REACHED",
      "COMMAND_FAILED",
      "REPORT_UNREADABLE",
      "REPORT_MALFORMED",
    ]) {
      expect(lines[0]).not.toContain(reason);
    }
    expect(lines[0]).toContain("not recorded");
    expect(lines[0]).toContain("ADR 0063");
  });
});

describe("[behavior:#303:B-17] ADR 0071", () => {
  const adr = () =>
    readFileSync(
      join("docs", "adr", "0071-report-only-mutation-survivor-step.md"),
      "utf-8",
    );

  it.each([
    ["## Context"],
    ["## Decision"],
    ["## Consequences"],
    ["### Decisions file schema"],
    ["### Trust ladder"],
    ["### Refusals"],
  ])("[behavior:#303:B-17] records the section %s", (heading: string) => {
    expect(adr()).toContain(heading);
  });

  it.each([["SwarmForge"], ["Martin"]])(
    "[behavior:#303:B-17] attributes the provenance to %s",
    (name: string) => {
      // The refusals below are inherited arguments, not this repo's inventions;
      // an ADR that drops the provenance invites a later slice to re-derive them.
      expect(adr()).toContain(name);
    },
  );

  it.each([
    ["mutant identity"],
    ["consequence"],
    ["containment"],
    ["KILL"],
    ["ACCEPT"],
    ["reasoning"],
  ])("[behavior:#303:B-17] records the decisions-file field %s", (field: string) => {
    expect(adr()).toContain(field);
  });

  it.each([["version: 1"], ["parseAfkManifest"]])(
    "[behavior:#303:B-17] records the version regime as %s",
    (literal: string) => {
      expect(adr()).toContain(literal);
    },
  );

  it.each([
    ["no blocking mutation gate"],
    ["no kill-rate or score threshold"],
    ["no generator-loop mutation"],
    ["no hardener role"],
    ["no automated survivor-killing"],
  ])("[behavior:#303:B-17] records the refusal: %s", (refusal: string) => {
    // Each is a killing argument, recorded so a later slice reopening one has to
    // argue against a record rather than fill a silence.
    expect(adr()).toContain(refusal);
  });
});
