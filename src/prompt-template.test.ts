import { describe, it, expect } from "vitest";
import { renderPrompt } from "./prompt-template.js";
import { parseQAReview } from "./qa-review.js";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

describe("renderPrompt", () => {
  it("substitutes placeholders for the explorer template", () => {
    const out = renderPrompt("explorer", {
      GH_ISSUE: "42",
      TITLE: "Contact list",
      SLICE_DIR: ".kiro/specs/contacts/slices/01-foo",
      SLICE_BODY: "Implement the contact list component",
      RELEVANT_FILES: "src/app.ts\nsrc/util.ts",
    });
    expect(out).toContain("#42");
    expect(out).toContain('"Contact list"');
    expect(out).toContain(".kiro/specs/contacts/slices/01-foo/context.md");
  });

  it("supports numeric values and empty-string conditionals", () => {
    const out = renderPrompt("planner", {
      GH_ISSUE: "1",
      SPECS_DIR: "specs",
      SLICE_DIR: "specs/slices/01",
      ROUND: 2,
      REVISION_NOTE: "",
      RELEVANT_FILES: "",
      SLICE_BODY: "Local issue body",
      MIGRATION_RESERVATION: "No claim yet",
      BASE_GATE_CATALOG: "- tests: pnpm run test:run",
      CONTRACT_RESPONSE_NOTE: "Write contract-response.json",
    });
    expect(out).toContain("**Negotiation round:** 2");
    expect(out).not.toContain("{{");
  });

  it("throws on missing placeholder values", () => {
    expect(() =>
      renderPrompt("explorer", {
        GH_ISSUE: "1",
        TITLE: "x",
        SLICE_BODY: "body",
        RELEVANT_FILES: "",
      } as never),
    ).toThrow(/SLICE_DIR/);
  });

  it("throws on extra unused args", () => {
    expect(() =>
      renderPrompt("evaluator-qa", {
        SLICE_DIR: "x",
        RELEVANT_FILES: "",
        SANITY_COMMANDS: "",
        BASE_GATE_AUTHORIZATION: "",
        SIBLING_HANDOFFS: "(none)",
        QA_SCOPE: "deterministic",
        REPORT_PATH: "d/qa-report.md",
        UNRESOLVED_FINDINGS: "(none)",
        COMMAND_TIMEOUT_SECONDS: 600,
        HEARTBEAT_SECONDS: 30,
        EXTRA: "y",
      }),
    ).toThrow(/EXTRA/);
  });

  /**
   * The QA evaluator is told the sanity command set and nothing else, so
   * a narrowed `--test-command` cannot reach it (ADR 0038). The template
   * is what enforces that: re-adding `{{TEST_COMMAND}}` to the QA prompt
   * makes the orchestrator's own render call — which passes no such arg —
   * throw at run time, and this case fails first.
   */
  it("refuses to hand the QA prompt the generator's test command", () => {
    expect(() =>
      renderPrompt("evaluator-qa", {
        SLICE_DIR: "x",
        RELEVANT_FILES: "",
        SANITY_COMMANDS: "pnpm run typecheck",
        BASE_GATE_AUTHORIZATION: "",
        SIBLING_HANDOFFS: "(none)",
        QA_SCOPE: "deterministic",
        REPORT_PATH: "d/qa-report.md",
        UNRESOLVED_FINDINGS: "(none)",
        COMMAND_TIMEOUT_SECONDS: 600,
        HEARTBEAT_SECONDS: 30,
        TEST_COMMAND: "pnpm test:fast",
      }),
    ).toThrow(/TEST_COMMAND/);
  });

  it("requires canonical QA artifacts and structured retry inputs", () => {
    const evaluatorPrompt = renderPrompt("evaluator-qa", {
      SLICE_DIR: "x",
      RELEVANT_FILES: "",
      SANITY_COMMANDS: "",
      BASE_GATE_AUTHORIZATION: "",
      SIBLING_HANDOFFS: "(none)",
      QA_SCOPE: "deterministic",
      REPORT_PATH: "x/qa-report.md",
      UNRESOLVED_FINDINGS: "(none)",
      COMMAND_TIMEOUT_SECONDS: 600,
      HEARTBEAT_SECONDS: 30,
    });
    expect(evaluatorPrompt).toContain("qa-review.json");
    expect(evaluatorPrompt).toContain("uat-review.json");
    expect(evaluatorPrompt).toContain('"version": 2');
    expect(evaluatorPrompt).toContain('"failureClass"');
    expect(evaluatorPrompt).toContain('"infrastructureEvidence"');
    expect(evaluatorPrompt).toContain('"clearCondition"');
    expect(evaluatorPrompt).toContain('"state"');
    // The remedy decides who clears a finding, so the prompt has to name
    // both the field and the case that needs it (#112).
    expect(evaluatorPrompt).toContain('"remedy"');
    expect(evaluatorPrompt).toContain('"amendmentPaths"');
    expect(evaluatorPrompt).toContain("SCOPE_AMENDMENT");
    expect(evaluatorPrompt).toMatch(/Markdown.+does not control/s);
    const canonicalExample = /```json\r?\n([\s\S]*?)\r?\n```/.exec(
      evaluatorPrompt,
    )?.[1];
    expect(canonicalExample).toBeDefined();
    expect(() =>
      parseQAReview(canonicalExample!, "evaluator QA prompt example"),
    ).not.toThrow();

    const evaluatorPersona = readFileSync(
      new URL("../agents/evaluator.md", import.meta.url),
      "utf-8",
    );
    expect(evaluatorPersona).toContain("qa-review.json");
    expect(evaluatorPersona).toContain("uat-review.json");
    expect(evaluatorPersona).toContain('"failureClass"');

    const generatorPersona = readFileSync(
      new URL("../agents/generator.md", import.meta.url),
      "utf-8",
    );
    expect(generatorPersona).toContain("routed unresolved findings");
    expect(generatorPersona).not.toContain(
      "`qa-report.md` in the current slice folder IF this is a retry round",
    );
  });

  /**
   * #82 AC3: the shared resume template is what a STUCK repair round now
   * reads, so the "don't touch the diagnosis" rule has to live in it. The
   * orchestrator restores the bytes regardless, but a generator told to
   * treat the file as read-only never makes it do the work.
   */
  it("tells the shared resume template to read stuck.md and leave it alone", () => {
    const resumeTemplate = readFileSync(
      new URL("../prompts/generator-resume.md", import.meta.url),
      "utf-8",
    );
    const requiredReading = resumeTemplate.match(
      /^# Required reading\r?\n([\s\S]*?)(?=^# |\Z)/m,
    )?.[1];
    expect(requiredReading).toContain("{{SLICE_DIR}}/stuck.md");
    const invariants = resumeTemplate.match(
      /^# Invariants\r?\n([\s\S]*?)(?=^# |\Z)/m,
    )?.[1];
    expect(invariants).toContain("{{SLICE_DIR}}/stuck.md");
    expect(invariants).toMatch(/never delete, move,\s+rewrite, or edit it/i);
  });

  it("gives every generator invocation the canonical scope-escalation contract", () => {
    const sources = [
      new URL("../agents/generator.md", import.meta.url),
      new URL("../prompts/generator.md", import.meta.url),
      new URL("../prompts/generator-resume.md", import.meta.url),
    ];
    const escalationSections = sources.map((source) => {
      const content = readFileSync(source, "utf-8");
      const section = content.match(
        /^# Scope escalation\r?\n([\s\S]*?)(?=^# |\Z)/m,
      );
      expect(section, source.pathname).not.toBeNull();
      return section![1]!.trim();
    });

    expect(new Set(escalationSections)).toHaveLength(1);
    expect(escalationSections[0]).toContain(
      "a cited finding's correct fix requires an undeclared file path",
    );
    expect(escalationSections[0]).toContain(
      "Stop before making the undeclared edit",
    );
    expect(escalationSections[0]).toContain(
      '{"version":1,"findingIds":["F-01"],"paths":["src/file.ts"],"reason":"why the cited fix requires the paths"}',
    );
    expect(escalationSections[0]).toMatch(
      /contains no fields other than `version`, `findingIds`, `paths`,\s+and `reason`/,
    );
  });

  it("loads all eight pipeline templates", () => {
    expect(renderPrompt("explorer", { GH_ISSUE: "1", TITLE: "t", SLICE_DIR: "d", SLICE_BODY: "b", RELEVANT_FILES: "" })).toBeTruthy();
    expect(
      renderPrompt("planner", {
        GH_ISSUE: "1",
        SPECS_DIR: "s",
        SLICE_DIR: "d",
        ROUND: 1,
        REVISION_NOTE: "",
        RELEVANT_FILES: "",
        SLICE_BODY: "Fetch with gh",
        MIGRATION_RESERVATION: "No claim yet",
        BASE_GATE_CATALOG: "- tests: pnpm run test:run",
        CONTRACT_RESPONSE_NOTE: "Do not write contract-response.json",
      }),
    ).toContain("- tests: pnpm run test:run");
    expect(
      renderPrompt("evaluator-contract", {
        SPECS_DIR: "s",
        SLICE_DIR: "d",
        ROUND: 1,
        RELEVANT_FILES: "",
        PREVIOUS_REVIEW_NOTE: "No previous round.",
        ACCEPTANCE_MANIFEST: '{"version":2}',
        BASE_GATE_CATALOG: "- tests: pnpm run test",
        CONTRACT_REVIEW_FILE: "contract-review.json",
        PLANNER_RESPONSE: "(first review round; no planner response)",
        REVISION_CONTEXT: "(first review round; no prior revision)",
      }),
    ).toContain("- tests: pnpm run test");
    expect(renderPrompt("generator", { SLICE_DIR: "d", RETRY_NOTE: "", RELEVANT_FILES: "", SIBLING_HANDOFFS: "(none)", TEST_COMMAND: "pnpm test", MIGRATION_RESERVATION: "none" })).toBeTruthy();
    expect(renderPrompt("evaluator-qa", { SLICE_DIR: "d", RELEVANT_FILES: "", SIBLING_HANDOFFS: "(none)", SANITY_COMMANDS: "", BASE_GATE_AUTHORIZATION: "", QA_SCOPE: "deterministic", REPORT_PATH: "d/qa-report.md", UNRESOLVED_FINDINGS: "(none)", COMMAND_TIMEOUT_SECONDS: 600, HEARTBEAT_SECONDS: 30 })).toBeTruthy();
    expect(renderPrompt("generator-resume", {
      SLICE_DIR: "d",
      RELEVANT_FILES: "",
      SIBLING_HANDOFFS: "(none)",
      TEST_COMMAND: "pnpm test",
      COMMITS_AHEAD: 1,
      COMMIT_LOG: "abc123 feat: work",
      WORKTREE_STATE: "preserved state",
      BASE_REFRESH_NOTE: "base refreshed",
      STUCK_NOTE: "",
      UNRESOLVED_FINDINGS: "(none)",
      HANDOFF_NOTE: "",
      MIGRATION_RESERVATION: "none",
    })).toBeTruthy();
    expect(renderPrompt("architect-review", { SPECS_DIR: "s", RELEVANT_FILES: "" })).toBeTruthy();
    expect(renderPrompt("pm-review", { SPECS_DIR: "s", RELEVANT_FILES: "", RUN_SCOPE: "(scope)" })).toBeTruthy();
  });

  it("retires the STUCK prompts from active source while docs keep the history", () => {
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
    const retiredRole = ["generator", "stuck"].join("-");
    const retiredResume = ["generator", "resume", "stuck"].join("-");
    for (const name of [`${retiredRole}.md`, `${retiredResume}.md`]) {
      expect(
        existsSync(new URL(`../prompts/${name}`, import.meta.url)),
      ).toBe(false);
    }

    expect(() =>
      execFileSync(
        "git",
        [
          "grep",
          "-n",
          "-e",
          retiredRole,
          "-e",
          retiredResume,
          "--",
          "src",
          "prompts",
        ],
        { cwd: repoRoot, stdio: "pipe" },
      ),
    ).toThrow();

    const generatorPersona = readFileSync(
      new URL("../agents/generator.md", import.meta.url),
      "utf-8",
    );
    expect(generatorPersona).not.toMatch(
      /(?:write|guess)[^\n]*stuck\.md/i,
    );
    expect(generatorPersona).not.toMatch(/best guess/i);

    // #82 AC6's other half: the historical mentions under docs/ are
    // records of what the pipeline used to do, so they stay. Asserted as
    // presence rather than as a diff against a fixed base commit — a
    // pinned base turns every later ADR anywhere in docs/ into a failure
    // of this test, on this branch and on main.
    const historicalMentions = execFileSync(
      "git",
      [
        "grep",
        "-l",
        "-e",
        retiredRole,
        "-e",
        retiredResume,
        "--",
        "docs/adr",
        "docs/specs",
      ],
      { cwd: repoRoot, encoding: "utf-8" },
    )
      .split(/\r?\n/)
      .filter((line) => line !== "");
    expect(historicalMentions).toContain(
      "docs/adr/0019-configurable-wall-clock-ceiling.md",
    );
    expect(historicalMentions).toContain(
      "docs/specs/afk-v2-agent-roles.md",
    );
  });
});
