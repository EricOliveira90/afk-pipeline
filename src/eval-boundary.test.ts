/**
 * Source-level boundary tests: the eval harness stays a leaf.
 *
 * These read `src/` and the two docs as text rather than importing them,
 * because the property under test is *what a module is allowed to import* —
 * a fact about specifiers, which no runtime assertion can see. A production
 * module that grows `import { runEvalCli }` compiles and passes every other
 * test in this repository; only this file fails.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVENTS_SCHEMA_VERSION } from "./run-events.js";
import { RUN_STATE_VERSION } from "./run-state.js";

const SRC = "src";

/** The four modules this slice adds, as file names under `src/`. */
const EVAL_MODULES = [
  "eval-pack.ts",
  "eval-compare.ts",
  "eval-report.ts",
  "eval-command.ts",
];

const CLI_ENTRIES = ["afk.ts", "afk-claude.ts", "afk-codex.ts"];

/**
 * This slice's declared write boundary, verbatim from the locked contract.
 * P-02 asserts the six production parsers are absent from it: the harness
 * consumes them and never edits them.
 */
const DECLARED_FILE_SCOPE = [
  "src/eval-pack.ts",
  "src/eval-compare.ts",
  "src/eval-report.ts",
  "src/eval-command.ts",
  "src/eval.fixtures.ts",
  "src/afk.ts",
  "src/afk-claude.ts",
  "src/afk-codex.ts",
  "src/eval-pack.test.ts",
  "src/eval-compare.test.ts",
  "src/eval-report.test.ts",
  "src/eval-command.test.ts",
  "src/eval-boundary.test.ts",
  "eval-packs/fixtures/refused/01-unknown-member.json",
  "CONTEXT.md",
  "ARCHITECTURE.md",
];

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

function srcFileNames(): string[] {
  return readdirSync(SRC)
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

/** Every module specifier in an `import ... from "x"` / `export ... from "x"`. */
function importSpecifiers(text: string): string[] {
  return [...text.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("the eval harness is a leaf", () => {
  /**
   * Every `src/*.ts` that is neither a test nor a fixtures module, minus the
   * four eval modules and the three CLI entries — the entries being the one
   * place production is *supposed* to reach the runner. `src/eval.fixtures.ts`
   * is excluded by the `*.fixtures.ts` rule: it imports `./eval-pack.js` by
   * design, being the harness's own test support.
   */
  const scanned = srcFileNames().filter(
    (name) =>
      !name.endsWith(".test.ts") &&
      !name.endsWith(".fixtures.ts") &&
      !EVAL_MODULES.includes(name) &&
      !CLI_ENTRIES.includes(name),
  );

  it("B-27 finds no production module importing an eval module", () => {
    const offenders = scanned.filter((name) =>
      importSpecifiers(read(join(SRC, name))).some((specifier) =>
        /\.\/eval-(pack|compare|report|command)\.js/.test(specifier),
      ),
    );

    expect(offenders).toEqual([]);
    // The evidence is only evidence if the scanned set is the stated one.
    expect(scanned.length).toBeGreaterThan(20);
    for (const name of [
      "orchestrator.ts",
      "wave.ts",
      "ship-gate.ts",
      "preship.ts",
      "gate-runner.ts",
      "base-gates.ts",
      "candidate-gate-phase.ts",
      "post-qa-gates.ts",
    ]) {
      expect(scanned).toContain(name);
    }
    expect(scanned).not.toContain("eval.fixtures.ts");
  });

  it("P-05 finds no eval module importing the run-evidence machinery, and leaves both schema versions alone", () => {
    const forbidden = [
      "./run-events.js",
      "./run-journal.js",
      "./run-state.js",
      "./run-identity.js",
      "./git.js",
      "./logger.js",
    ];
    const offenders: string[] = [];
    for (const name of EVAL_MODULES) {
      for (const specifier of importSpecifiers(read(join(SRC, name)))) {
        if (forbidden.includes(specifier)) offenders.push(`${name} -> ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
    // An eval run writes no event and no state, so neither schema moved.
    expect(EVENTS_SCHEMA_VERSION).toBe(1);
    expect(RUN_STATE_VERSION).toBe(5);
  });

  it("P-02 consumes the six production parsers and re-implements none", () => {
    const parsers: Array<[string, string]> = [
      ["./contract-review.js", "parseContractReview"],
      ["./qa-review.js", "parseQAReview"],
      ["./final-evaluation.js", "parseFinalReview"],
      ["./artifacts.js", "parseGuardianReview"],
      ["./planner-escalation.js", "readPlannerEscalation"],
      ["./acceptance-manifest.js", "parseAcceptanceManifest"],
    ];
    const compare = read(join(SRC, "eval-compare.ts"));
    const specifiers = importSpecifiers(compare);

    for (const [module, parser] of parsers) {
      expect(specifiers).toContain(module);
      expect(compare).toContain(parser);
      // No eval module declares its own function of that name.
      for (const name of EVAL_MODULES) {
        expect(read(join(SRC, name))).not.toMatch(
          new RegExp(`(function|const|let)\\s+${parser}\\b`),
        );
      }
      // And none of the six is a file this slice may write.
      expect(DECLARED_FILE_SCOPE).not.toContain(
        `src/${module.replace("./", "").replace(".js", ".ts")}`,
      );
    }
  });
});

describe("the CLI entries keep their existing branches", () => {
  const entryBranches: Array<[string, string[]]> = [
    ["afk.ts", ["status", "stop", "clean-failed", "adopt"]],
    ["afk-claude.ts", ["stop", "clean-failed"]],
    ["afk-codex.ts", ["stop", "clean-failed"]],
  ];

  it("P-01 dispatches every bare token in source order, then parsePipelineRuntimeOptions, then one runPipeline", () => {
    for (const [name, tokens] of entryBranches) {
      const text = read(join(SRC, name));
      const positions = tokens.map((token) =>
        text.indexOf(`args[0] === "${token}"`),
      );

      for (const [index, position] of positions.entries()) {
        expect(position, `${name} ${tokens[index]}`).toBeGreaterThan(-1);
        if (index > 0) {
          expect(position).toBeGreaterThan(positions[index - 1] ?? -1);
        }
      }
      // The eval branch is added before the runtime options are parsed, so the
      // runtime parser still runs after every bare-token branch.
      const parsedAt = text.indexOf("parsePipelineRuntimeOptions(args)");
      expect(parsedAt).toBeGreaterThan(positions[positions.length - 1] ?? -1);
      expect(text.indexOf(`args[0] === "eval"`)).toBeLessThan(parsedAt);
      expect(text.match(/\brunPipeline\(/g) ?? []).toHaveLength(1);
    }
  });
});

describe("pnpm test never dispatches a live model", () => {
  it("P-03 keeps the vitest include array at src/**/*.test.ts and every pack outside src/", () => {
    const config = read("vitest.config.ts");
    const include = /include:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? "";

    expect(
      include
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ""),
    ).toEqual(['"src/**/*.test.ts"']);

    // A pack case file is a `*.json` inside the pack directory; none lives
    // under `src/`, so no collected test file can be one.
    const jsonUnderSrc: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (entry.endsWith(".json")) jsonUnderSrc.push(path);
      }
    };
    walk(SRC);
    expect(jsonUnderSrc).toEqual([]);
  });

  it("B-29 dispatches every runEvalCli call site to the fixtures stub provider", () => {
    const callers = srcFileNames().filter(
      (name) => name.endsWith(".test.ts") && read(join(SRC, name)).includes("runEvalCli"),
    );

    expect(callers).toContain("eval-command.test.ts");
    for (const name of callers) {
      const text = read(join(SRC, name));
      expect(
        importSpecifiers(text).filter((specifier) =>
          /^\.\/(claude|codex|kiro)\.js$/.test(specifier),
        ),
        name,
      ).toEqual([]);
      // The stub is the only provider constructor any of them names.
      const constructors = [
        ...new Set([...text.matchAll(/\bbuild\w*Provider\b/g)].map((m) => m[0])),
      ];
      expect(constructors, name).toEqual(["buildEvalStubProvider"]);
    }
  });
});

describe("the documentation entries", () => {
  /**
   * Assembled rather than written, because this file is itself a
   * `src/eval-*.ts` member of the set B-30 scans: spelling the term here
   * would falsify the very rule under test.
   */
  const BANNED_TERM = `${"dispo"}${"sition"}`;

  const NEW_TERMS = ["Envelope", "Scenario pack", "Eval case", "Eval outcome"];

  /** One entry's text: its `**Term**:` heading through the blank line after. */
  function entryBody(section: string, term: string): string {
    const start = section.indexOf(`**${term}**:`);
    expect(start, term).toBeGreaterThan(-1);
    const end = section.indexOf("\n\n", start);
    return section.slice(start, end === -1 ? undefined : end);
  }

  it("B-30 adds the four Pipeline concepts entries, keeps Prompt record, and names no guardian finding key", () => {
    const context = read("CONTEXT.md");
    const conceptsAt = context.indexOf("### Pipeline concepts");
    expect(conceptsAt).toBeGreaterThan(-1);
    const section = context.slice(conceptsAt);

    for (const term of NEW_TERMS) {
      const body = entryBody(section, term);
      const lines = body.split("\n");
      // Heading, at least one line of prose, and the `_Avoid_` line.
      expect(lines.length, term).toBeGreaterThanOrEqual(3);
      expect(lines[1], term).not.toBe("");
      expect(body, term).toContain("\n_Avoid_: ");
      expect(body.toLowerCase(), term).not.toContain(BANNED_TERM);
    }

    // The already-merged entry is present and its body is untouched.
    const promptRecord = entryBody(section, "Prompt record");
    expect(promptRecord).toContain(
      "`slice-<NN>-<role>[-r<N>].prompt.md` file `--record-prompts` writes beside",
    );
    expect(promptRecord).toContain(
      '_Avoid_: "prompt log", "transcript", "envelope dump"',
    );

    // And the eval modules do not name the guardian finding key either.
    const evalSources = srcFileNames().filter((name) =>
      name.startsWith("eval-"),
    );
    expect(evalSources.length).toBeGreaterThan(4);
    for (const name of evalSources) {
      expect(read(join(SRC, name)).toLowerCase(), name).not.toContain(
        BANNED_TERM,
      );
    }
  });

  it("B-31 adds exactly one Agent eval row to the ARCHITECTURE.md module table, under the 150-line cap", () => {
    const lines = read("ARCHITECTURE.md").replace(/\n$/, "").split(/\r?\n/);
    const rows = lines.filter((line) => line.startsWith("| Agent eval |"));

    expect(rows).toHaveLength(1);
    const cells = (rows[0] ?? "").split("|").map((cell) => cell.trim());
    expect(cells[1]).toBe("Agent eval");
    expect(cells[3]).toBe("`src/eval-command.ts`");
    expect(cells[4]).toBe(
      "`src/eval-pack.ts`, `src/eval-compare.ts`, `src/eval-report.ts`",
    );
    expect(lines.length).toBeLessThanOrEqual(150);
  });
});
