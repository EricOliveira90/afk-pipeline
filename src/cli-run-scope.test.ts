import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentProvider } from "./agent-provider.js";
import type { Slice } from "./issues-parser.js";
import { resolveCliRunScope } from "./cli-run-scope.js";
import { pipelineRunSlug } from "./orchestrator.js";
import { saveRunState } from "./run-state.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const SLICES: Slice[] = [
  { number: "02", ghIssue: "102", title: "Retry", type: "AFK", blockedBy: [], userStories: "" },
  { number: "03", ghIssue: "103", title: "New", type: "AFK", blockedBy: [], userStories: "" },
];

function provider(name: string): AgentProvider {
  return {
    name,
    invoke: async () => {
      throw new Error("not used");
    },
  };
}

describe("resolveCliRunScope", () => {
  it("uses manifest selectedSlices as the default", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "afk-cli-scope-"));
    roots.push(repoRoot);
    const resolved = resolveCliRunScope({
      repoRoot,
      prdSlug: "manifest-default",
      provider: provider("kiro"),
      slices: SLICES,
      manifestSelectedSliceNumbers: ["02"],
      onlyFailed: false,
    });
    expect(resolved.scope.selected.map((slice) => slice.number)).toEqual(["02"]);
  });

  it("fails closed when CLI scope conflicts with the manifest", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "afk-cli-scope-"));
    roots.push(repoRoot);
    expect(() => resolveCliRunScope({
      repoRoot,
      prdSlug: "manifest-conflict",
      provider: provider("kiro"),
      slices: SLICES,
      selectedSliceNumbers: ["03"],
      manifestSelectedSliceNumbers: ["02"],
      onlyFailed: false,
    })).toThrow(/CLI scope conflicts with afk.json/);
  });

  it.each(["kiro", "claude", "codex"])(
    "uses the %s run slug and returns one selection for display and dispatch",
    (name) => {
      const repoRoot = mkdtempSync(join(tmpdir(), "afk-cli-scope-"));
      roots.push(repoRoot);
      const agentProvider = provider(name);
      const prdSlug = "scope-preview";
      const runSlug = pipelineRunSlug(prdSlug, agentProvider);
      saveRunState(repoRoot, {
        version: 2,
        prdSlug: runSlug,
        featureBranch: `feat/${prdSlug}`,
        scope: {
          mode: "all-afk",
          slices: [
            { number: "01", ghIssue: "101" },
            { number: "02", ghIssue: "102" },
          ],
        },
        slices: {
          "101": { phase: "PASS", mergedToFeature: true },
          "102": { phase: "ERROR", error: "retry me" },
        },
      });

      const resolved = resolveCliRunScope({
        repoRoot,
        prdSlug,
        provider: agentProvider,
        slices: SLICES,
        onlyFailed: true,
      });

      expect(resolved.requestedSliceNumbers).toEqual(["02"]);
      expect(resolved.scope.selected.map((slice) => slice.number)).toEqual(
        resolved.requestedSliceNumbers,
      );
      expect(resolved.scope.persisted.slices).toHaveLength(2);
      expect(resolved.scope.members.map((slice) => slice.number)).toEqual(["02"]);
    },
  );
});
