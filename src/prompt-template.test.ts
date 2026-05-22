import { describe, it, expect } from "vitest";
import { renderPrompt } from "./prompt-template.js";

describe("renderPrompt", () => {
  it("substitutes placeholders for the explorer template", () => {
    const out = renderPrompt("explorer", {
      GH_ISSUE: "42",
      TITLE: "Contact list",
      SLICE_DIR: ".kiro/specs/contacts/slices/01-foo",
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
    });
    expect(out).toContain("**Negotiation round:** 2");
    expect(out).not.toContain("{{");
  });

  it("throws on missing placeholder values", () => {
    expect(() =>
      renderPrompt("explorer", {
        GH_ISSUE: "1",
        TITLE: "x",
      } as never),
    ).toThrow(/SLICE_DIR/);
  });

  it("throws on extra unused args", () => {
    expect(() =>
      renderPrompt("evaluator-qa", {
        SLICE_DIR: "x",
        EXTRA: "y",
      }),
    ).toThrow(/EXTRA/);
  });

  it("loads all eight pipeline templates", () => {
    expect(renderPrompt("explorer", { GH_ISSUE: "1", TITLE: "t", SLICE_DIR: "d" })).toBeTruthy();
    expect(
      renderPrompt("planner", {
        GH_ISSUE: "1",
        SPECS_DIR: "s",
        SLICE_DIR: "d",
        ROUND: 1,
        REVISION_NOTE: "",
      }),
    ).toBeTruthy();
    expect(
      renderPrompt("evaluator-contract", { SPECS_DIR: "s", SLICE_DIR: "d", ROUND: 1 }),
    ).toBeTruthy();
    expect(renderPrompt("generator", { SLICE_DIR: "d", RETRY_NOTE: "" })).toBeTruthy();
    expect(renderPrompt("evaluator-qa", { SLICE_DIR: "d" })).toBeTruthy();
    expect(renderPrompt("generator-stuck", { SLICE_DIR: "d" })).toBeTruthy();
    expect(renderPrompt("architect-review", { SPECS_DIR: "s" })).toBeTruthy();
    expect(renderPrompt("pm-review", { SPECS_DIR: "s" })).toBeTruthy();
  });
});
