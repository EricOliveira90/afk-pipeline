/**
 * The committed eval packs, asserted as data (#263).
 *
 * Two packs live in this repository: `eval-packs/afk/`, nine hand-reconstructed
 * cases built from AFK's own recorded failures, and
 * `eval-packs/fixtures/consumer-governance/`, the one-case pack that shows a
 * consumer what a pack of its own looks like.
 *
 * **The AFK pack is read and asserted, never dispatched** (B-10). A dispatch
 * costs a model call even against a stub, and the stub could only ever agree
 * with itself; the value of these cases is the material they carry, which a
 * read checks completely. Only the consumer pack is dispatched, and only to
 * `buildEvalStubProvider`, because B-09 is about the runner's `MATCH` /
 * `MISMATCH` bookkeeping rather than about any case's content.
 *
 * A seeded `fromFile` payload is copied byte-for-byte into the case's scratch
 * directory and the prompt orders the role to read it, so anything the fixture
 * says about the case reaches the role under test. The fixture-byte assertions
 * below are what keeps that channel clean: provenance belongs in the case's
 * `source` member or in `eval-packs/afk/README.md`, both of which the role never
 * reads.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EVAL_DEPS,
  type EvalCliDeps,
  runEvalCli,
} from "./eval-command.js";
import {
  type EvalCase,
  type EvalPack,
  readEvalPack,
  validateEvalCase,
} from "./eval-pack.js";
import { readEvalReport } from "./eval-report.js";
import {
  buildEvalStubProvider,
  evalCaseDocument,
  writeEvalGuardianReview,
  writeEvalPackDir,
} from "./eval.fixtures.js";
import { rmDirWithRetry } from "./test-support.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The AFK pack, as a repo-relative POSIX path — the string B-10 forbids in a
 * dispatch. It reaches `readEvalPack` and nothing else in this file. */
const AFK_PACK = "eval-packs/afk";
const AFK_PACK_DIR = join(REPO_ROOT, "eval-packs", "afk");
const CONSUMER_PACK_DIR = join(
  REPO_ROOT,
  "eval-packs",
  "fixtures",
  "consumer-governance",
);
const REFUSED_FIXTURE_DIR = join(
  REPO_ROOT,
  "eval-packs",
  "fixtures",
  "refused",
);

/** PRD 4's committed verdict artifacts, which are where B-05 took `expected`. */
const PRD4_SLICES = join(
  REPO_ROOT,
  ".kiro",
  "specs",
  "afk-v2-acceptance-scope-gates",
  "slices",
);

const AFK_CASE_FILES = [
  "01-192-pre-restart-1-planner.json",
  "02-192-pre-restart-2-planner.json",
  "03-192-final-planner.json",
  "04-194-f03-evaluator-contract.json",
  "05-120-candidate-typecheck-evaluator-qa.json",
  "06-prd4-contract-a.json",
  "07-prd4-contract-b.json",
  "08-prd4-qa-a.json",
  "09-prd4-qa-b.json",
];

/** The seven members a case file carries, in `CASE_KEYS` order. */
const CASE_KEYS = [
  "version",
  "id",
  "role",
  "source",
  "prompt",
  "files",
  "expected",
];

/** `expected` is a per-role union; the assertions here read it as the record
 * the JSON literally carries. */
const expectedOf = (value: EvalCase): Record<string, string> =>
  value.expected as unknown as Record<string, string>;

/** Whitespace is layout, not content: the README wraps a `source` across lines
 * and indents the continuations, so containment is checked on one line. */
const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

const afkPack = (): EvalPack => readEvalPack(AFK_PACK_DIR);

/**
 * Statements a seeded fixture must not carry, whichever case seeds it: the
 * pack's own bookkeeping, a claim about the file's part in an eval, or a
 * prescription of what the graded role should do. Each pattern is written to
 * match the disclosure without matching the reconstructed document's own
 * vocabulary — a committed PRD 4 contract says "the exact tree the gates graded"
 * and carries a `**Lock-Provenance:**` line, so these anchor on the noun and on
 * the line start.
 */
const FIXTURE_DISCLOSURES: readonly { why: string; pattern: RegExp }[] = [
  { why: "an HTML comment", pattern: /<!--/ },
  { why: "a path inside the eval pack", pattern: /eval-packs\//i },
  { why: "the words eval case, eval fixture or eval pack", pattern: /eval (?:case|fixture|pack)/i },
  { why: "the word hand-reconstructed or hand-authored", pattern: /hand-(?:reconstructed|authored)/i },
  { why: "a claim that the file is a reconstruction", pattern: /reconstruct/i },
  { why: "a \"fixture for\" attribution", pattern: /fixture for/i },
  { why: "a Provenance: block", pattern: /^provenance:/im },
  {
    why: "a statement of the expected or graded answer",
    pattern: /(?:expected|graded) (?:artifact|verdict|outcome|answer)/i,
  },
  {
    why: "a prescription of what the graded role should do",
    pattern: /\b(?:planner|reviewer|evaluator|role|agent|model) should(?: not)?\b/i,
  },
];

/**
 * `expected` values whose bare token is itself the disclosure. `ESCALATION`,
 * `CONTRACT` and `ACCEPT` are words the seeded documents never use; `PASS`,
 * `FAIL` and `NONE` are gate-outcome vocabulary a real PRD 4 contract uses on
 * nearly every page, so for those the check is the verdict-declaration shapes
 * below and not the token.
 */
const BARE_TOKEN_VALUES = new Set(["ESCALATION", "CONTRACT", "ACCEPT", "REVISE"]);

/** The shapes that would state `value` as this case's graded answer. */
const verdictDeclarations = (value: string): RegExp[] => [
  new RegExp(`\\*\\*(?:Verdict|Failure class)[:*\\s]*\\W{0,3}${value}\\b`, "i"),
  new RegExp(`"(?:verdict|failureClass|artifact|outcome)"\\s*:\\s*"${value}"`, "i"),
  new RegExp(
    `(?:verdict|outcome|artifact|answer)\\W{1,4}(?:is|was|should be)\\W{1,4}${value}\\b`,
    "i",
  ),
];

/** The `fromFile` payloads a case seeds, read as the bytes the role receives. */
const seededFixtures = (one: EvalCase): { target: string; text: string }[] =>
  Object.values(one.files)
    .filter((content): content is { fromFile: string } => typeof content !== "string")
    .map((content) => ({
      target: content.fromFile,
      text: readFileSync(join(AFK_PACK_DIR, ...content.fromFile.split("/")), "utf-8"),
    }));

const afkCaseDocuments = (): { name: string; value: unknown }[] =>
  AFK_CASE_FILES.map((name) => ({
    name,
    value: JSON.parse(readFileSync(join(AFK_PACK_DIR, name), "utf-8")) as unknown,
  }));

describe("the committed eval packs", () => {
  it("B-01 holds exactly nine AFK case files whose 01-…09- prefixes are the declared order", () => {
    const names = readdirSync(AFK_PACK_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name);

    expect(names.sort()).toEqual(AFK_CASE_FILES);
    expect(afkPack().cases).toHaveLength(9);
    expect(afkPack().cases.map((one) => one.id)).toEqual([
      "192-pre-restart-1-planner",
      "192-pre-restart-2-planner",
      "192-final-planner",
      "194-f03-evaluator-contract",
      "120-candidate-typecheck-evaluator-qa",
      "prd4-contract-a",
      "prd4-contract-b",
      "prd4-qa-a",
      "prd4-qa-b",
    ]);
  });

  it("B-01 gives every AFK case file exactly the seven CASE_KEYS members and no other", () => {
    for (const { name, value } of afkCaseDocuments()) {
      expect(Object.keys(value as Record<string, unknown>).sort()).toEqual(
        [...CASE_KEYS].sort(),
      );
      // The reader is the authority on the shape, not this list.
      expect(() => validateEvalCase(value, name)).not.toThrow();
    }
  });

  it("B-01 resolves eval-packs/afk through readEvalPack without refusal, fromFile targets included", () => {
    const pack = afkPack();

    expect(pack.version).toBe(1);
    expect(pack.dir).toBe(AFK_PACK_DIR);
    for (const one of pack.cases) {
      for (const content of Object.values(one.files)) {
        if (typeof content === "string") continue;
        expect(
          existsSync(join(AFK_PACK_DIR, ...content.fromFile.split("/"))),
        ).toBe(true);
        expect(content.fromFile.startsWith("fixtures/")).toBe(true);
      }
    }
  });

  it("B-02 reconstructs #192's three planner escalations as ESCALATION, ESCALATION, CONTRACT in declared order", () => {
    const [first, second, third] = afkPack().cases;

    for (const one of [first, second, third]) {
      expect(one!.role).toBe("planner");
      expect(one!.source).toContain(
        ".afk/artifacts/afk-v2-acceptance-scope-gates-codex/slice-01/",
      );
      expect(one!.source).toContain("planner-escalation.md");
      expect(one!.source).toContain("#192");
    }
    expect(expectedOf(first!)).toEqual({ artifact: "ESCALATION" });
    expect(expectedOf(second!)).toEqual({ artifact: "ESCALATION" });
    expect(expectedOf(third!)).toEqual({ artifact: "CONTRACT" });
  });

  it("B-02 seeds each #192 planner case with that escalation's context, the PRD 4 excerpt and the #84 body", () => {
    for (const one of afkPack().cases.slice(0, 3)) {
      const targets = Object.values(one.files).map((content) =>
        typeof content === "string" ? "" : content.fromFile,
      );
      expect(targets).toContain("fixtures/192-prd4-excerpt.md");
      expect(targets).toContain("fixtures/192-issue-84.md");
      expect(
        targets.some((target) => target.startsWith("fixtures/192-context-")),
      ).toBe(true);
    }
  });

  it("B-03 reconstructs #194's round-1 F-03 case as one evaluator-contract case expecting ACCEPT", () => {
    const one = afkPack().cases[3]!;

    expect(one.id).toBe("194-f03-evaluator-contract");
    expect(one.role).toBe("evaluator-contract");
    expect(expectedOf(one)).toEqual({ verdict: "ACCEPT" });
    expect(one.prompt).toContain("# File-scope path semantics");
    expect(one.prompt).toMatch(
      /case-only spelling difference cannot be a BLOCKING finding/,
    );
    expect(one.source).toContain("contract-review-r1-a1.json");
    expect(one.source).toContain("#194");
    // One case from #194, not two: the second run's archived inputs are absent.
    const from194 = afkPack().cases.filter((other) =>
      other.source.includes("#194"),
    );
    expect(from194).toHaveLength(1);
  });

  it("B-04 carries #120's candidate typecheck failure as FAIL / IMPLEMENTATION over an inline project", () => {
    const one = afkPack().cases[4]!;

    expect(one.role).toBe("evaluator-qa");
    expect(expectedOf(one)).toEqual({
      verdict: "FAIL",
      failureClass: "IMPLEMENTATION",
    });
    expect(one.source).toContain("#120");
    expect(one.source).toContain(
      "docs/adr/0041-uncertain-classification-picks-the-branch-that-cannot-loop.md",
    );
    expect(one.source).toContain("AGENTS.md:74-77");
    // Inline only: the project the candidate failed to compile is the case.
    for (const content of Object.values(one.files)) {
      expect(typeof content).toBe("string");
    }
  });

  it("B-05 takes each PRD 4 case's expected from that slice's committed verdict artifact", () => {
    const cases = afkPack().cases;
    const rows = [
      {
        one: cases[5]!,
        slice: "02-behavior-coverage-gate",
        artifact: "contract-review.json",
        role: "evaluator-contract",
      },
      {
        one: cases[6]!,
        slice: "05-test-cost-split-and-caching",
        artifact: "contract-review.json",
        role: "evaluator-contract",
      },
      {
        one: cases[7]!,
        slice: "03-candidate-evaluator-isolation",
        artifact: "qa-review.json",
        role: "evaluator-qa",
      },
      {
        one: cases[8]!,
        slice: "08-file-scope-gate",
        artifact: "qa-review.json",
        role: "evaluator-qa",
      },
    ];

    for (const row of rows) {
      expect(row.one.role).toBe(row.role);
      expect(row.one.source).toContain(
        `.kiro/specs/afk-v2-acceptance-scope-gates/slices/${row.slice}/${row.artifact}`,
      );
      const recorded = JSON.parse(
        readFileSync(join(PRD4_SLICES, row.slice, row.artifact), "utf-8"),
      ) as { verdict: string; failureClass?: string };
      const expectedValue = expectedOf(row.one);
      expect(expectedValue.verdict).toBe(recorded.verdict);
      if (row.role === "evaluator-qa") {
        expect(expectedValue.failureClass).toBe(recorded.failureClass);
      }
    }
    // At most one case of either role per PRD 4 slice, and one role per slice.
    const slices = rows.map((row) => row.slice);
    expect(new Set(slices).size).toBe(slices.length);
  });

  it("B-05 marks each PRD 4 case with confirmed-by: dbd6fdc and cites no absent .afk/artifacts review", () => {
    for (const one of afkPack().cases.slice(5)) {
      expect(one.source).toContain("confirmed-by: dbd6fdc");
      expect(one.source).not.toContain(".afk/artifacts");
      const target =
        one.role === "evaluator-contract"
          ? "contract-review.json"
          : "qa-review.json";
      expect(one.source).toMatch(
        new RegExp(
          `\\.kiro/specs/afk-v2-acceptance-scope-gates/slices/[^\\s,]*${target.replace(".", "\\.")}`,
        ),
      );
    }
  });

  it("B-06 gives every AFK case a hand-reconstructed source citing only the four D2 sources, with unique ids", () => {
    const pack = afkPack();
    const cited = (source: string): boolean =>
      source.includes("#192") ||
      source.includes("#194") ||
      source.includes("#120") ||
      source.includes(
        ".kiro/specs/afk-v2-acceptance-scope-gates/slices/",
      );

    for (const one of pack.cases) {
      expect(one.source.trim()).not.toBe("");
      expect(one.source).toContain("hand-reconstructed");
      expect(cited(one.source)).toBe(true);
    }
    expect(new Set(pack.cases.map((one) => one.id)).size).toBe(9);
  });

  it("B-06 validates every AFK case's expected against its own role under EXPECTED_SHAPE", () => {
    // The reader validates `expected` against `role`, so a case whose pair the
    // role's parser could never produce never reaches a dispatch.
    for (const { name, value } of afkCaseDocuments()) {
      const document = value as Record<string, unknown>;
      expect(() =>
        validateEvalCase({ ...document, role: "evaluator-final" }, name),
      ).toThrow(/expected/);
    }
    expect(afkPack().cases.map((one) => one.role)).toEqual([
      "planner",
      "planner",
      "planner",
      "evaluator-contract",
      "evaluator-qa",
      "evaluator-contract",
      "evaluator-contract",
      "evaluator-qa",
      "evaluator-qa",
    ]);
  });

  it("B-02 B-03 B-05 seed no fixture that names its eval case or states that case's answer", () => {
    const scanned = new Set<string>();

    for (const one of afkPack().cases) {
      for (const { target, text } of seededFixtures(one)) {
        scanned.add(target);
        for (const { why, pattern } of FIXTURE_DISCLOSURES) {
          expect(pattern.test(text), `${target} (seeded by ${one.id}) carries ${why}`).toBe(
            false,
          );
        }
        for (const value of Object.values(expectedOf(one))) {
          const patterns = BARE_TOKEN_VALUES.has(value)
            ? [new RegExp(`\\b${value}\\b`), ...verdictDeclarations(value)]
            : verdictDeclarations(value);
          for (const pattern of patterns) {
            expect(
              pattern.test(text),
              `${target} states ${one.id}'s expected ${value}`,
            ).toBe(false);
          }
        }
      }
    }
    // Every committed fixture is seeded by some case, so the scan above covered
    // the whole directory rather than a subset of it.
    expect([...scanned].sort()).toEqual(
      readdirSync(join(AFK_PACK_DIR, "fixtures"))
        .map((name) => `fixtures/${name}`)
        .sort(),
    );
  });

  it("B-02 B-03 B-05 give each seeded fixture bytes that open as the reconstructed document itself", () => {
    for (const one of afkPack().cases) {
      for (const { target, text } of seededFixtures(one)) {
        // The first line, whichever line ending the checkout gave the file.
        const first = text.split("\n")[0]!.trimEnd();
        expect(first, `${target} opens as its own document`).toMatch(
          target.endsWith(".json") ? /^\{$/ : /^# \S/,
        );
      }
    }
  });

  it("B-06 records fixture provenance in the source member and the README, where the role never reads it", () => {
    const readme = readFileSync(join(AFK_PACK_DIR, "README.md"), "utf-8");

    for (const one of afkPack().cases) {
      for (const { target } of seededFixtures(one)) {
        const name = target.slice("fixtures/".length);
        expect(readme, `README.md records ${name}'s provenance`).toContain(name);
      }
      expect(one.source).toContain("hand-reconstructed");
    }

    // The scan is discriminating: the header this pack used to carry inside the
    // fixture bytes trips it on every count that mattered.
    const planted = [
      "<!--",
      "Hand-reconstructed fixture for eval-packs/afk case 03-192-final-planner.",
      "The expected artifact for this case is therefore a CONTRACT: the",
      "planner should decide the dialect and record it, not escalate.",
      "-->",
    ].join("\n");
    const tripped = FIXTURE_DISCLOSURES.filter(({ pattern }) => pattern.test(planted));
    expect(tripped.length).toBeGreaterThanOrEqual(6);
    expect(new RegExp("\\bCONTRACT\\b").test(planted)).toBe(true);
  });

  it("B-07 indexes every case in eval-packs/afk/README.md in declared order with its role, source, expected and the operator command", () => {
    const readme = readFileSync(join(AFK_PACK_DIR, "README.md"), "utf-8");
    const oneLine = collapse(readme);

    expect(readme).toContain("afk-claude eval --pack eval-packs/afk");
    let cursor = -1;
    for (const one of afkPack().cases) {
      const at = oneLine.indexOf(one.id, cursor);
      expect(at, `README.md names ${one.id} after the case before it`).toBeGreaterThan(cursor);
      cursor = at;
      expect(oneLine).toContain(`**role:** \`${one.role}\``);
      expect(oneLine).toContain(
        `**expected:** \`${JSON.stringify(one.expected)}\``,
      );
      expect(oneLine).toContain(collapse(one.source));
    }
    // A README is not a case: the *.json-only scan never picked it up.
    expect(afkPack().cases.map((one) => one.id)).not.toContain("README");
  });

  it("B-08 resolves the consumer-governance pack as one pm case expecting FIX-BEFORE-SHIP over a PRODUCT.md", () => {
    const pack = readEvalPack(CONSUMER_PACK_DIR);

    expect(pack.cases).toHaveLength(1);
    const one = pack.cases[0]!;
    expect(one.role).toBe("pm");
    expect(expectedOf(one)).toEqual({ outcome: "FIX-BEFORE-SHIP" });
    expect(
      Object.keys(one.files).some((key) => key.endsWith("PRODUCT.md")),
    ).toBe(true);
    expect(readdirSync(CONSUMER_PACK_DIR)).toEqual(["01-pm-governance.json"]);
  });

  describe("B-09 the consumer pack dispatched to the eval stub", () => {
    const tempDirs: string[] = [];
    const scratchDirs: string[] = [];

    /** A fixed clock, so the run directory name is deterministic. */
    const FROZEN = new Date("2026-09-12T10:00:00.000Z");
    const RUN_DIR_NAME = "eval-20260912-100000";

    const deps = (): EvalCliDeps => ({
      now: () => FROZEN,
      mkScratchDir: (id) => {
        const dir = DEFAULT_EVAL_DEPS.mkScratchDir(id);
        scratchDirs.push(dir);
        return dir;
      },
      stdout: () => {},
    });

    /** A repo root of its own, so the default `--out` writes nowhere real. */
    const repoRoot = (): string => {
      const dir = mkdtempSync(join(tmpdir(), "afk-eval-packs-repo-"));
      tempDirs.push(dir);
      return dir;
    };

    afterEach(() => {
      for (const dir of scratchDirs.splice(0)) rmDirWithRetry(dir);
      for (const dir of tempDirs.splice(0)) rmDirWithRetry(dir);
    });

    const dispatch = async (
      outcome: "FIX-BEFORE-SHIP" | "SHIP",
    ): Promise<string> => {
      const root = repoRoot();
      const { provider } = buildEvalStubProvider([
        { write: (cwd) => writeEvalGuardianReview(cwd, "pm", outcome) },
      ]);

      const result = await runEvalCli(
        ["--pack", CONSUMER_PACK_DIR],
        root,
        provider,
        deps(),
      );

      const report = readEvalReport(
        join(root, ".afk", "eval", RUN_DIR_NAME, "report.json"),
      );
      expect(report.status).toBe("COMPLETE");
      // A MISMATCH is data, not a failure: the run exits 0 either way.
      expect(result.exitCode).toBe(0);
      return report.cases[0]!.outcome;
    };

    it("B-09 records MATCH in report.json when the stub writes review-pm.md with FIX-BEFORE-SHIP", async () => {
      expect(await dispatch("FIX-BEFORE-SHIP")).toBe("MATCH");
    });

    it("B-09 records MISMATCH in report.json when the stub writes SHIP instead", async () => {
      expect(await dispatch("SHIP")).toBe("MISMATCH");
    });
  });

  it("B-10 dispatches eval-packs/afk from no test under src/, this file included", () => {
    const testFiles = readdirSync(join(REPO_ROOT, "src"))
      .filter((name) => name.endsWith(".test.ts"))
      .sort();
    expect(testFiles).toContain("eval-packs.test.ts");

    for (const name of testFiles) {
      const text = readFileSync(join(REPO_ROOT, "src", name), "utf-8");
      for (const args of dispatchArguments(text)) {
        expect(args, `${name} dispatches ${AFK_PACK}`).not.toContain(AFK_PACK);
        expect(args, `${name} dispatches AFK_PACK`).not.toContain("AFK_PACK");
      }
    }
    // The constant exists and reaches only the reader, which spends no call.
    expect(AFK_PACK).toBe("eval-packs/afk");
  });

  it("P-01 keeps readEvalPack's refusal behavior: an unknown top-level member is named and refused", () => {
    const dir = writeEvalPackDir(
      {
        "01-case.json": { ...evalCaseDocument(), notes: "not a case member" },
      },
      "afk-eval-packs-refusal-",
    );
    try {
      expect(() => readEvalPack(dir)).toThrow(
        /declares the unknown top-level member "notes"/,
      );
      expect(() => validateEvalCase({ id: "only-an-id" }, "01-case.json")).toThrow(
        /is missing the top-level member "version"/,
      );
    } finally {
      rmDirWithRetry(dir);
    }
  });

  it("P-02 leaves eval-packs/fixtures/refused/01-unknown-member.json refused for its notes member", () => {
    const document = JSON.parse(
      readFileSync(join(REFUSED_FIXTURE_DIR, "01-unknown-member.json"), "utf-8"),
    ) as Record<string, unknown>;

    expect(Object.keys(document)).toContain("notes");
    expect(() => readEvalPack(REFUSED_FIXTURE_DIR)).toThrow(
      /declares the unknown top-level member "notes"/,
    );
  });

  it("P-03 leaves the CONTEXT.md eval vocabulary and the ARCHITECTURE.md Agent eval row as slice 01 wrote them", () => {
    const architecture = readFileSync(join(REPO_ROOT, "ARCHITECTURE.md"), "utf-8");
    const context = readFileSync(join(REPO_ROOT, "CONTEXT.md"), "utf-8");

    expect(architecture).toContain(
      "`afk eval`: replay a scenario pack against a live model, report only — never gates (PRD 7, #262)",
    );
    for (const entry of [
      "**Scenario pack**:",
      "**Eval case**:",
      "**Eval outcome**:",
      "**Prompt record**:",
    ]) {
      expect(context).toContain(entry);
    }
    expect(context).toContain("The raw material for an eval case's `prompt`.");
  });
});

/**
 * Every `runEvalCli(` argument list in a test file, matched by parentheses so a
 * pack path spelled across lines is still inside the text B-10 inspects.
 */
function dispatchArguments(text: string): string[] {
  const found: string[] = [];
  const call = "runEvalCli(";
  let at = text.indexOf(call);
  while (at !== -1) {
    let depth = 0;
    let end = at + call.length - 1;
    for (; end < text.length; end += 1) {
      const char = text[end];
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    found.push(text.slice(at + call.length, end));
    at = text.indexOf(call, end);
  }
  return found;
}
