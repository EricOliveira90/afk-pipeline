import { describe, it, expect } from "vitest";
import { renderPrompt } from "./prompt-template.js";
import { buildGuardianRoundScope } from "./guardian-round-scope.js";
import { parseQAReview } from "./qa-review.js";
import {
  GATE_SCOPE_FINDING_ID,
  PRE_BUILD_SCOPE_FINDING_ID,
} from "./escalation.js";
import {
  PLANNER_ESCALATION_FILENAME,
  parsePlannerEscalation,
} from "./planner-escalation.js";
import { parseAcceptanceManifest } from "./acceptance-manifest.js";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

describe("renderPrompt", () => {
  it("P-03 substitutes placeholders for the explorer template", () => {
    const out = renderPrompt("explorer", {
      GH_ISSUE: "42",
      TITLE: "Contact list",
      SLICE_DIR: ".kiro/specs/contacts/slices/01-foo",
      SLICE_BODY: "Implement the contact list component",
      RELEVANT_FILES: "src/app.ts\nsrc/util.ts",
      REPOSITORY_CONTEXT: "(none available)",
      INLINE_SIZE_BUDGET_BYTES: 65536,
    });
    expect(out).toContain("#42");
    expect(out).toContain('"Contact list"');
    expect(out).toContain(".kiro/specs/contacts/slices/01-foo/context.md");
  });

  it("supports numeric values in planner templates", () => {
    const out = renderPrompt("planner", {
      GH_ISSUE: "1",
      SPECS_DIR: "specs",
      SLICE_DIR: "specs/slices/01",
      ROUND: 2,
      SLICE_BODY: "Local issue body",
      CARRIED_OPEN_FINDINGS: "(none)",
      EXPLORER_CONTEXT: "Explorer evidence",
      MIGRATION_RESERVATION: "No claim yet",
      BASE_GATE_CATALOG: "- tests: pnpm run test:run",
      REPOSITORY_CONTEXT: "(none available)",
    });
    expect(out).toContain("**Negotiation round:** 2");
    expect(out).toMatch(
      /prohibition on implementation edits must still\s+allow the planner and evaluator to write their required contract/i,
    );
    expect(out).not.toContain("{{");
  });

  it("P-03 throws on missing placeholder values", () => {
    expect(() =>
      renderPrompt("explorer", {
        GH_ISSUE: "1",
        TITLE: "x",
        SLICE_BODY: "body",
        RELEVANT_FILES: "",
      } as never),
    ).toThrow(/SLICE_DIR/);
  });

  it("P-03 throws on extra unused args", () => {
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

  it("tells the repair template to leave stuck.md alone", () => {
    const repairTemplate = readFileSync(
      new URL("../prompts/generator-repair.md", import.meta.url),
      "utf-8",
    );
    expect(repairTemplate).toContain("preserved `stuck.md` evidence");
    expect(repairTemplate).toMatch(
      /read-only\. Never delete, move,\s+rewrite, or edit it/i,
    );
  });

  it("gives every generator invocation the canonical scope-escalation contract", () => {
    const sources = [
      new URL("../prompts/generator.md", import.meta.url),
      new URL("../prompts/generator-repair.md", import.meta.url),
    ];
    const escalationSections = sources.map((source) => {
      const content = readFileSync(source, "utf-8");
      const section = content.match(
        /^# Scope escalation\r?\n([\s\S]*?)(?=^# |\Z)/m,
      );
      expect(section, source.pathname).not.toBeNull();
      return section![1]!.trim();
    });

    for (const section of escalationSections) {
      expect(section).toMatch(/stop before/i);
      expect(section).toContain(
        '{"version":1,"findingIds":["F-01"],"paths":["src/file.ts"],"reason":"why the cited fix requires the paths"}',
      );
      expect(section).toContain(PRE_BUILD_SCOPE_FINDING_ID);
      expect(section).toMatch(/Never mix these three identities/i);
    }
  });

  /**
   * The three-way escalation branch (#193 B-16, ADR 0060). All three generator
   * surfaces teach it, and they teach it with the same bytes: a generator reads
   * whichever of them its invocation renders, and a rule that holds in one is a
   * rule the other two let it escape.
   */
  it("[behavior:B-16] teaches all three escalation identities identically in every generator surface", () => {
    const surfaces = [
      "../prompts/generator.md",
      "../prompts/generator-repair.md",
      "../agents/generator.md",
    ].map((relative) =>
      readFileSync(new URL(relative, import.meta.url), "utf-8"),
    );

    const blocks = surfaces.map((content) => {
      const start = content.indexOf("`findingIds` is always required");
      const endMarker =
        "escalate for a human decision instead of asking for a wider scope.";
      const end = content.indexOf(endMarker);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return content.slice(start, end + endMarker.length);
    });
    // Byte-identical, not merely equivalent.
    expect(new Set(blocks).size).toBe(1);

    const block = blocks[0]!;
    // The version-2 literal, exactly — a generator copies this shape.
    expect(block).toContain(
      '{"version":2,"findingIds":["GATE-SCOPE"],"paths":["src/file.ts"],' +
        '"reason":"why the failing gate requires the paths",' +
        '"gateEvidence":{"gateId":"scope","evidenceArtifactId":' +
        '"gate-evidence/candidate-r1-a1.json"}}',
    );
    // All three branches, each by the identity it cites.
    expect(block).toMatch(/Findings were cited to you/);
    expect(block).toContain(
      `{"version":1,"findingIds":["${PRE_BUILD_SCOPE_FINDING_ID}"],` +
        '"paths":["src/file.ts"],"reason":"..."}',
    );
    expect(block).toContain(GATE_SCOPE_FINDING_ID);
    expect(block).toMatch(/failing orchestrator-run gate/i);
    expect(block).toMatch(/gateEvidence` is required with `GATE-SCOPE`/);
    // The never-mix rule spans all three identities, not just the pre-build one.
    expect(block).toMatch(
      /Never mix these three identities — not with each other, and not with a\s+real\s+finding ID/,
    );
    // A revision widens a boundary; it never decides what the contract did not.
    for (const decision of [
      /changes behavior/,
      /a public interface/,
      /a data format/,
      /security posture/,
      /the acceptance\s+criteria/,
    ]) {
      expect(block).toMatch(decision);
    }
    expect(block).toMatch(/escalate for a human decision/);
  });

  /**
   * ADR 0060's parser-regression rubric, in both contract-evaluation surfaces
   * (#193 B-17). Round 1 renders `evaluator-contract.md` and every later round
   * renders `evaluator-contract-revision.md`, so a rubric present in only one
   * of them is a rubric a revised contract escapes.
   */
  const renderContractEvaluation = (): Record<string, string> => ({
    "evaluator-contract": renderPrompt("evaluator-contract", {
      SLICE_DIR: "d",
      ROUND: 1,
      ACCEPTANCE_MANIFEST_FILE: "acceptance-manifest.json",
      DURABLE_FINDING_LINEAGE: "(none)",
      CONTROL_SITUATION: "(none)",
      BASE_GATE_CATALOG: "- tests: pnpm run test",
      CONTRACT_REVIEW_FILE: "contract-review.json",
      EXPLORER_CONTEXT: "context",
    }),
    "evaluator-contract-revision": renderPrompt(
      "evaluator-contract-revision",
      {
        SLICE_DIR: "d",
        ROUND: 2,
        CONTRACT_REVIEW_FILE: "contract-review.json",
        ACCEPTANCE_MANIFEST_FILE: "acceptance-manifest.json",
        PRIOR_OPEN_FINDINGS: "(none)",
        DURABLE_FINDING_LINEAGE: "(none)",
        PLANNER_RESPONSE: "(none)",
        REVISION_CONTEXT: '{"before":"old","after":"new"}',
        CONTROL_SITUATION: "(none)",
        BASE_GATE_CATALOG: "- tests: pnpm run test",
        EXPLORER_CONTEXT: "context",
      },
    ),
  });

  it("[behavior:B-17] gives both contract-evaluation prompts ADR 0060's parser-regression rubric", () => {
    const rendered = renderContractEvaluation();

    const rubrics = Object.entries(rendered).map(([name, prompt]) => {
      const section = prompt.match(
        /^# Parser regression surface\r?\n([\s\S]*?)(?=^# )/m,
      );
      expect(section, name).not.toBeNull();
      return section![1]!;
    });
    // Both surfaces teach it with the same bytes, so neither can drift.
    expect(new Set(rubrics.map((r) => r.trim())).size).toBe(1);

    for (const [index, rubric] of rubrics.entries()) {
      const name = Object.keys(rendered)[index]!;
      expect(rubric, name).toMatch(
        /changes a parser's accepted input language/,
      );
      expect(rubric, name).toMatch(/ADR 0060/);
      // Both halves of the regression evidence are bound, not just the happy one.
      expect(rubric, name).toMatch(
        /positive evidence: at least one newly accepted input/,
      );
      expect(rubric, name).toMatch(
        /rejected-or-boundary evidence: relevant rejected or boundary input\s+that must\s+remain rejected/,
      );
      // A fixture-backed harness declares its owning area and the concrete
      // paths, or authorizes new fixtures there explicitly.
      expect(rubric, name).toMatch(/established harness .* is fixture-backed/);
      expect(rubric, name).toMatch(/owning fixture area/);
      expect(rubric, name).toMatch(
        /concrete existing\s+fixture paths expected to change/,
      );
      expect(rubric, name).toMatch(
        /explicit authorization to add fixtures in\s+that area/,
      );
      // Inline tests stay legal where they are the harness: the rubric binds
      // evidence, not a literal fixture path.
      expect(rubric, name).toMatch(
        /Inline parser tests are valid evidence where they are the\s+established harness/,
      );
      expect(rubric, name).toMatch(
        /not universally mandatory —\s*concrete regression evidence is/,
      );
      expect(rubric, name).toMatch(/BLOCKING finding/);
    }
  });

  /**
   * The rubric is additive (#193 P-04): the lineage, control-plane and review
   * artifact contracts the contract-evaluation prompts already carried still
   * hold, and the manifest format itself is untouched at version 2.
   */
  it("[behavior:P-04] keeps the prior contract-evaluation contract intact", () => {
    for (const [name, prompt] of Object.entries(renderContractEvaluation())) {
      expect(prompt, name).toContain("# Durable finding lineage");
      expect(prompt, name).toContain("# Control-plane situation");
      // The placeholders still resolve — the rendered prompt carries the
      // substituted values, not the raw tokens.
      expect(prompt, name).not.toContain("{{DURABLE_FINDING_LINEAGE}}");
      expect(prompt, name).not.toContain("{{CONTROL_SITUATION}}");
      expect(prompt, name).toContain("# Canonical review artifacts");
      expect(prompt, name).toContain(
        "`severity` is exactly `BLOCKING` or `ADVISORY`",
      );
      expect(prompt, name).toContain(
        "`state` is exactly one of `OPEN`, `RESOLVED`, `CONTESTED`, `WITHDRAWN`",
      );
    }

    for (const relative of [
      "../prompts/evaluator-contract.md",
      "../prompts/evaluator-contract-revision.md",
    ]) {
      const template = readFileSync(
        new URL(relative, import.meta.url),
        "utf-8",
      );
      expect(template, relative).toContain("{{DURABLE_FINDING_LINEAGE}}");
      expect(template, relative).toContain("{{CONTROL_SITUATION}}");
    }

    // The acceptance manifest format is still version 2: this slice taught the
    // evaluator a rubric, it did not bump the machine format.
    const manifest = parseAcceptanceManifest({
      version: 2,
      fileScope: { kind: "paths", paths: ["src/example.ts"] },
      migrationCount: 0,
      behaviors: [
        {
          id: "B-01",
          source: "contract.md",
          given: "a parser change",
          when: "the evaluator reviews it",
          then: "the regression surface is declared",
          observableResult: "the review cites the fixture area",
          preservation: false,
          gateIds: ["tests"],
        },
      ],
    });
    expect(manifest.version).toBe(2);
    expect(() =>
      parseAcceptanceManifest({
        version: 3,
        fileScope: { kind: "paths", paths: ["src/example.ts"] },
        migrationCount: 0,
        behaviors: [],
      }),
    ).toThrow(/must declare version 1 or 2/);
  });

  it("B-08 limits escalation to plan-level contradictions, silence, and risk", () => {
    for (const name of ["generator.md", "generator-repair.md"]) {
      const template = readFileSync(
        new URL(`../prompts/${name}`, import.meta.url),
        "utf-8",
      );
      const escalation = template.match(
        /^# Scope escalation\r?\n([\s\S]*?)(?=^# |\Z)/m,
      )?.[1];

      expect(escalation).toMatch(/spec contradiction/i);
      expect(escalation).toMatch(/including recorded ADRs/i);
      expect(escalation).toMatch(/load-bearing\s+silence/i);
      expect(escalation).toMatch(/declared risk class/i);
      expect(escalation).toMatch(/decide and record otherwise/i);
      expect(template).not.toMatch(/^#{1,6} ADR\b/m);
      expect(template).not.toContain("grep for `docs/adr/`");
    }
  });

  it("gives both planner templates the same critical-judgment rule", () => {
    // §3c policy 1 as prompt text. Both templates carry it because the
    // negotiation loop renders `planner.md` in round 1 and
    // `planner-revision.md` from round 2 on, and a judgment rule that holds
    // in only one of them is a rule the planner can escape by being revised.
    for (const name of ["planner.md", "planner-revision.md"]) {
      const template = readFileSync(
        new URL(`../prompts/${name}`, import.meta.url),
        "utf-8",
      );
      const escalation = template.match(
        /^# Escalation\r?\n([\s\S]*?)(?=^# |\Z)/m,
      )?.[1];
      expect(escalation, name).toBeDefined();

      // Decide-and-record first: without it the section reads as "escalate
      // when unsure", which is the behavior the rule exists to prevent.
      expect(escalation, name).toMatch(/decide and record/i);
      expect(escalation, name).toMatch(/reversible before merge/i);

      expect(escalation, name).toMatch(/spec contradiction/i);
      expect(escalation, name).toMatch(/a recorded ADR counts as specification/i);
      expect(escalation, name).toMatch(/load-bearing silence/i);
      expect(escalation, name).toMatch(/public interface/i);
      expect(escalation, name).toMatch(/security posture/i);
      expect(escalation, name).toMatch(/declared risk class/i);
      expect(escalation, name).toMatch(/schema history/i);
      expect(escalation, name).toMatch(/deletion of tests or gates/i);
      expect(escalation, name).toMatch(/destructive git/i);

      // The sentinel by constant, not by literal, so renaming the artifact
      // cannot leave the prompts pointing at the old name.
      expect(escalation, name).toContain(PLANNER_ESCALATION_FILENAME);
      for (const criterion of [
        "SPEC_CONTRADICTION",
        "LOAD_BEARING_SILENCE",
        "DECLARED_RISK_CLASS",
      ]) {
        expect(escalation, name).toContain(criterion);
      }

      // The exemplar is round-tripped through the parser rather than compared
      // to a literal pasted in here. What decides whether a real planner's
      // sentinel is read as a request or as `malformed` is the parser, so the
      // prompt has to be checked against the parser — not against a second
      // copy of itself.
      const exemplar = escalation!.match(/^`(\{.*\})`$/m)?.[1];
      expect(exemplar, name).toBeDefined();
      expect(() => parsePlannerEscalation(exemplar!), name).not.toThrow();

      // Instead of, not as well as: a sentinel written beside a contract pair
      // reports a failed round rather than a question.
      expect(escalation, name).toMatch(/instead of/i);
      expect(escalation, name).toContain("acceptance-manifest.json");

      // The write boundary is the sentence the model treats as exhaustive, so
      // the third artifact has to be named there too.
      const boundary = template.match(
        /^# Write boundary\r?\n([\s\S]*?)(?=^# |\Z)/m,
      )?.[1];
      expect(boundary, name).toContain(PLANNER_ESCALATION_FILENAME);
    }
  });

  it("B-05 P-01 loads planner artifact contracts in both templates", () => {
    expect(renderPrompt("explorer", { GH_ISSUE: "1", TITLE: "t", SLICE_DIR: "d", SLICE_BODY: "b", RELEVANT_FILES: "", REPOSITORY_CONTEXT: "(none available)", INLINE_SIZE_BUDGET_BYTES: 65536 })).toBeTruthy();
    expect(
      renderPrompt("planner", {
        GH_ISSUE: "1",
        SPECS_DIR: "s",
        SLICE_DIR: "d",
        ROUND: 1,
        SLICE_BODY: "Fetch with gh",
        CARRIED_OPEN_FINDINGS: "(none)",
        EXPLORER_CONTEXT: "context",
        MIGRATION_RESERVATION: "No claim yet",
        BASE_GATE_CATALOG: "- tests: pnpm run test:run",
        REPOSITORY_CONTEXT: "(none available)",
      }),
    ).toContain("- tests: pnpm run test:run");
    expect(
      renderPrompt("planner-revision", {
        GH_ISSUE: "1",
        SPECS_DIR: "s",
        SLICE_DIR: "d",
        ROUND: 2,
        CURRENT_CONTRACT: "contract",
        CURRENT_ACCEPTANCE_MANIFEST: '{"version":2}',
        OPEN_FINDINGS: "(none)",
        RESOLVED_HISTORY: "(none)",
        CONTROL_SITUATION: "(none)",
        CONTRACT_RESPONSE_INSTRUCTIONS: "Do not write a response.",
        MIGRATION_RESERVATION: "No claim yet",
        REPOSITORY_CONTEXT: "(none available)",
        BASE_GATE_CATALOG: "- tests: pnpm run test:run",
      }),
    ).toContain("# Routed OPEN findings");
    expect(
      renderPrompt("evaluator-contract", {
        SLICE_DIR: "d",
        ROUND: 1,
        ACCEPTANCE_MANIFEST_FILE: "acceptance-manifest.json",
        DURABLE_FINDING_LINEAGE: "(none)",
        CONTROL_SITUATION: "(none)",
        BASE_GATE_CATALOG: "- tests: pnpm run test",
        CONTRACT_REVIEW_FILE: "contract-review.json",
        EXPLORER_CONTEXT: "context",
      }),
    ).toContain("- tests: pnpm run test");
    expect(
      renderPrompt("evaluator-contract-revision", {
        SLICE_DIR: "d",
        ROUND: 2,
        CONTRACT_REVIEW_FILE: "contract-review.json",
        ACCEPTANCE_MANIFEST_FILE: "acceptance-manifest.json",
        PRIOR_OPEN_FINDINGS: "(none)",
        DURABLE_FINDING_LINEAGE: "(none)",
        PLANNER_RESPONSE: "(none)",
        REVISION_CONTEXT: '{"before":"old","after":"new"}',
        CONTROL_SITUATION: "(none)",
        BASE_GATE_CATALOG: "- tests: pnpm run test",
        EXPLORER_CONTEXT: "context",
      }),
    ).toContain("# Prior OPEN findings");
    expect(renderPrompt("generator", {
      SLICE_DIR: "d",
      FILE_SCOPE: "- `src/example.ts`",
      MIGRATION_RESERVATION: "none",
      CONTRACT_VIEW: "contract",
      ACCEPTANCE_MANIFEST: '{"version":2}',
      TEST_COMMAND: "pnpm test",
      PATTERNS_AND_HARNESS: "patterns",
      FAILURE_SET: "(none)",
    })).toBeTruthy();
    expect(renderPrompt("evaluator-qa", { SLICE_DIR: "d", RELEVANT_FILES: "", SIBLING_HANDOFFS: "(none)", SANITY_COMMANDS: "", BASE_GATE_AUTHORIZATION: "", QA_SCOPE: "deterministic", REPORT_PATH: "d/qa-report.md", UNRESOLVED_FINDINGS: "(none)", COMMAND_TIMEOUT_SECONDS: 600, HEARTBEAT_SECONDS: 30 })).toBeTruthy();
    expect(renderPrompt("generator-repair", {
      SLICE_DIR: "d",
      FILE_SCOPE: "- `src/example.ts`",
      MIGRATION_RESERVATION: "none",
      CONTRACT_VIEW: "contract",
      ACCEPTANCE_MANIFEST: '{"version":2}',
      TEST_COMMAND: "pnpm test",
      PATTERNS_AND_HARNESS: "patterns",
      REPAIR_SITUATION: "resume facts",
      FAILURE_SET: "(none)",
    })).toBeTruthy();
    expect(renderPrompt("architect-review", {
      SPECS_DIR: "s",
      RELEVANT_FILES: "",
      ROUND_SCOPE: "round 1",
      OPEN_FINDINGS: "(none)",
      RESOLVED_HISTORY: "(none)",
    })).toBeTruthy();
    expect(renderPrompt("pm-review", { SPECS_DIR: "s", RELEVANT_FILES: "", RUN_SCOPE: "(scope)" })).toBeTruthy();
  });

  it("B-01 B-02 B-03 B-04 QA-01 states the exact architect authority contract while PM remains v1", () => {
    const architect = renderPrompt("architect-review", {
      SPECS_DIR: "s",
      RELEVANT_FILES: "(files)",
      ROUND_SCOPE: "round 1",
      OPEN_FINDINGS: "(none)",
      RESOLVED_HISTORY: "(none)",
    });
    expect(architect).toContain("## Structured findings (v2)");
    const architectExample = architect.match(
      /`(\{"version":2,"findings":\[\{[^\r\n]+\}\]\})`\./,
    )?.[1];
    expect(architectExample).toBeDefined();
    const architectShape = JSON.parse(architectExample!);
    expect(Object.keys(architectShape)).toEqual(["version", "findings"]);
    expect(Object.keys(architectShape.findings[0])).toEqual([
      "id",
      "title",
      "class",
      "clearCondition",
      "disposition",
      "reachableTrigger",
      "introducedByReviewedDiff",
    ]);
    expect(architectShape.findings[0].reachableTrigger).toEqual(
      expect.any(String),
    );
    expect(architectShape.findings[0].introducedByReviewedDiff).toBe(true);
    expect(architect).toMatch(
      /Round 1:[\s\S]*?reachableTrigger[\s\S]*?non-blank[\s\S]*?introducedByReviewedDiff` is `true`/,
    );
    expect(architect).toMatch(
      /Round 2 or later, later-new:[\s\S]*?no prior stable lineage[\s\S]*?introducedByReviewedDiff` is `true`[\s\S]*?exactly `INTEGRITY` or `DATA_LOSS`/,
    );
    expect(architect).toMatch(
      /Round 2 or later, prior-lineage:[\s\S]*?not `RESOLVED`[\s\S]*?reachableTrigger[\s\S]*?non-blank[\s\S]*?class and[\s\S]*?introducedByReviewedDiff` value do not remove/,
    );
    expect(architect).toMatch(
      /FIX-BEFORE-SHIP only when at least one finding satisfies its branch/,
    );

    const pm = renderPrompt("pm-review", {
      SPECS_DIR: "s",
      RELEVANT_FILES: "(files)",
      RUN_SCOPE: "(scope)",
    });
    expect(pm).toContain("## Structured findings (v1)");
    const pmExample = pm.match(
      /`(\{"version":1,"findings":\[\{[^\r\n]+\}\]\})`\./,
    )?.[1];
    expect(pmExample).toBeDefined();
    const pmShape = JSON.parse(pmExample!);
    expect(Object.keys(pmShape)).toEqual(["version", "findings"]);
    expect(Object.keys(pmShape.findings[0])).toEqual([
      "id",
      "title",
      "class",
      "clearCondition",
      "disposition",
    ]);
    expect(pm).not.toContain('"reachableTrigger"');
    for (const prompt of [architect, pm]) {
      expect(prompt).toContain('"clearCondition"');
      expect(prompt).toContain('"disposition":"OPEN"');
      expect(prompt).toMatch(/empty `findings` array for SHIP/i);
      expect(prompt).toMatch(
        /ACCEPT-WITH-NOTES and\s+FIX-BEFORE-SHIP require at least one finding/i,
      );
    }
  });

  it("renders the architect review round scope from the ledger, round 1 and round N", () => {
    const roundOne = buildGuardianRoundScope({
      rounds: [],
      guardian: "architect",
      defaultBranch: "main",
    });
    const roundOnePrompt = renderPrompt("architect-review", {
      SPECS_DIR: "s",
      RELEVANT_FILES: "(files)",
      ROUND_SCOPE: roundOne.roundScope,
      OPEN_FINDINGS: roundOne.openFindings,
      RESOLVED_HISTORY: roundOne.resolvedHistory,
    });
    expect(roundOnePrompt).toContain("# What this round reviews");
    expect(roundOnePrompt).toContain("git diff main...HEAD");
    expect(roundOnePrompt).not.toContain("verification round");
    expect(roundOnePrompt).not.toContain("{{");

    const roundTwo = buildGuardianRoundScope({
      rounds: [
        {
          round: 1,
          reviewedHeadSha: "reviewed-1",
          headSha: "deadbeefcafe0001",
          architect: {
            source: "INVOKED",
            outcome: "FIX-BEFORE-SHIP",
            findingsOriginRound: 1,
            findings: [
              {
                stableId: "A-01",
                currentId: "A-01",
                title: "Round persistence skips the early return",
                class: "INTEGRITY",
                clearCondition: "The round persists on every exit path.",
                disposition: "OPEN",
                reachableTrigger: "A normal retry reads the partial record.",
                introducedByReviewedDiff: true,
              },
              {
                stableId: "A-02",
                currentId: "A-02",
                title: "Naming drift in the lane partitioner",
                class: "CONVENTION",
                clearCondition: "The helper follows the module's naming.",
                disposition: "RESOLVED",
                reachableTrigger: null,
                introducedByReviewedDiff: false,
              },
            ],
          },
          pm: {
            source: "INVOKED",
            outcome: "SHIP",
            findingsOriginRound: 1,
            findings: [],
          },
        },
      ],
      guardian: "architect",
      defaultBranch: "main",
    });
    const roundTwoPrompt = renderPrompt("architect-review", {
      SPECS_DIR: "s",
      RELEVANT_FILES: "(files)",
      ROUND_SCOPE: roundTwo.roundScope,
      OPEN_FINDINGS: roundTwo.openFindings,
      RESOLVED_HISTORY: roundTwo.resolvedHistory,
    });
    expect(roundTwoPrompt).toContain("review round 2, a verification round");
    expect(roundTwoPrompt).toContain("git diff deadbeefcafe0001..HEAD");
    expect(roundTwoPrompt).not.toContain("git diff main...HEAD");
    expect(roundTwoPrompt).toContain("Reuse the stable IDs");
    expect(roundTwoPrompt).toMatch(
      /## Open findings[\s\S]*?\[A-01\][\s\S]*?The round persists on every exit path\./,
    );
    expect(roundTwoPrompt).toMatch(
      /## Already resolved — do not re-raise[\s\S]*?\[A-02\]/,
    );
    // The resolved finding must not reappear in the verify-these list.
    const openBlock = roundTwoPrompt
      .split("## Open findings")[1]!
      .split("## Already resolved")[0]!;
    expect(openBlock).not.toContain("[A-02]");
    expect(roundTwoPrompt).not.toContain("{{");
  });

  it("B-04 QA-02 documents the fresh revisionCitation object contract", () => {
    const prompt = renderPrompt("evaluator-contract-revision", {
      SLICE_DIR: "d",
      ROUND: 2,
      CONTRACT_REVIEW_FILE: "contract-review.json",
      ACCEPTANCE_MANIFEST_FILE: "acceptance-manifest.json",
      PRIOR_OPEN_FINDINGS: "(none)",
      DURABLE_FINDING_LINEAGE: "(none)",
      PLANNER_RESPONSE: "(none)",
      REVISION_CONTEXT: '{"before":"old","after":"new"}',
      CONTROL_SITUATION: "(none)",
      BASE_GATE_CATALOG: "- tests: pnpm run test",
      EXPLORER_CONTEXT: "context",
    });

    expect(prompt).toContain('"artifact": "contract.md"');
    expect(prompt).toContain('"before": "exact text from the prior artifact"');
    expect(prompt).toContain('"after": "exact text from the revised artifact"');
    expect(prompt).toContain(
      "`artifact` must be exactly `contract.md` or `acceptance-manifest.json`",
    );
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
    expect(
      existsSync(new URL("../prompts/generator-resume.md", import.meta.url)),
    ).toBe(false);

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
