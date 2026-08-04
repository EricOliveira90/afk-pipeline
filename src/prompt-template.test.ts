import { describe, it, expect } from "vitest";
import { renderPrompt } from "./prompt-template.js";

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
        TEST_COMMAND: "pnpm test",
        SANITY_COMMANDS: "",
        SIBLING_HANDOFFS: "(none)",
        QA_SCOPE: "deterministic",
        REPORT_PATH: "d/qa-report.md",
        PREVIOUS_QA_REPORTS: "(none)",
        COMMAND_TIMEOUT_SECONDS: 600,
        HEARTBEAT_SECONDS: 30,
        EXTRA: "y",
      }),
    ).toThrow(/EXTRA/);
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
      }),
    ).toBeTruthy();
    expect(
      renderPrompt("evaluator-contract", { SPECS_DIR: "s", SLICE_DIR: "d", ROUND: 1, RELEVANT_FILES: "", PREVIOUS_FEEDBACK_NOTE: "No previous round." }),
    ).toBeTruthy();
    expect(renderPrompt("generator", { SLICE_DIR: "d", RETRY_NOTE: "", RELEVANT_FILES: "", SIBLING_HANDOFFS: "(none)", TEST_COMMAND: "pnpm test" })).toBeTruthy();
    expect(renderPrompt("evaluator-qa", { SLICE_DIR: "d", RELEVANT_FILES: "", SIBLING_HANDOFFS: "(none)", TEST_COMMAND: "pnpm test", SANITY_COMMANDS: "", QA_SCOPE: "deterministic", REPORT_PATH: "d/qa-report.md", PREVIOUS_QA_REPORTS: "(none)", COMMAND_TIMEOUT_SECONDS: 600, HEARTBEAT_SECONDS: 30 })).toBeTruthy();
    expect(renderPrompt("generator-stuck", { SLICE_DIR: "d", QA_REPORTS: "- d/qa-report-r3-a1.md" })).toBeTruthy();
    expect(renderPrompt("architect-review", { SPECS_DIR: "s", RELEVANT_FILES: "" })).toBeTruthy();
    expect(renderPrompt("pm-review", { SPECS_DIR: "s", RELEVANT_FILES: "" })).toBeTruthy();
  });
});
