import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  loadRelatedGatePolicy,
  parseRelatedGatePolicy,
  selectRelatedGateDeclarations,
} from "./related-gates.js";

const policy = parseRelatedGatePolicy({
  gates: {
    "heavy:orchestrator": {
      command: "pnpm",
      args: ["run", "test:heavy:orchestrator"],
      expectedCostMs: 180_000,
      timeoutMs: 600_000,
    },
    fast: {
      command: "pnpm",
      args: ["test:fast"],
      expectedCostMs: 120_000,
      timeoutMs: 300_000,
    },
  },
  mappings: [
    {
      patterns: ["src/orchestrator*.ts"],
      gates: ["heavy:orchestrator"],
    },
  ],
  coverage: [{ pattern: "src/**", fallbackGates: ["fast"] }],
});

describe("related gate policy", () => {
  it("unions locked and actual paths so an actual extra path can only add gates", () => {
    const selected = selectRelatedGateDeclarations(policy, {
      lockedPaths: ["src/orchestrator.ts"],
      changedPaths: ["src/unplanned-helper.ts"],
    });
    expect(selected.map((gate) => gate.id)).toEqual([
      "heavy:orchestrator",
      "fast",
    ]);
  });

  it("normalizes separators and deduplicates a gate selected by both path sets", () => {
    const selected = selectRelatedGateDeclarations(policy, {
      lockedPaths: [".\\SRC\\orchestrator.ts"],
      changedPaths: ["src/orchestrator.test.ts"],
    });
    expect(selected).toEqual([
      {
        id: "heavy:orchestrator",
        stage: "related",
        required: true,
        command: "pnpm",
        args: ["run", "test:heavy:orchestrator"],
        expectedCostMs: 180_000,
        wallClockTimeoutMs: 600_000,
      },
    ]);
  });

  it("fails configuration for an unmatched covered path without a fallback", () => {
    const noFallback = parseRelatedGatePolicy({
      gates: {
        fast: {
          command: "pnpm",
          args: ["test:fast"],
          expectedCostMs: 1,
          timeoutMs: 2,
        },
      },
      mappings: [],
      coverage: [{ pattern: "src/**" }],
    });
    expect(() =>
      selectRelatedGateDeclarations(noFallback, {
        lockedPaths: [],
        changedPaths: ["src/new.ts"],
      }),
    ).toThrow(/no related-gate mapping or fallback/i);
  });

  it("rejects a mapping that names an undeclared gate", () => {
    expect(() =>
      parseRelatedGatePolicy({
        gates: {},
        mappings: [{ patterns: ["src/**"], gates: ["missing"] }],
        coverage: [],
      }),
    ).toThrow(/unknown gate "missing"/i);
  });

  it("loads this project's heavy selector from afk.config.json", () => {
    const configured = loadRelatedGatePolicy(resolve("."));
    expect(
      selectRelatedGateDeclarations(configured, {
        lockedPaths: ["src/orchestrator.ts"],
        changedPaths: [],
      }).map((gate) => gate.id),
    ).toEqual(["test:heavy:orchestrator", "test:heavy:qa"]);
  });
});
