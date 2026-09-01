import { describe, expect, it } from "vitest";
import type { AcceptanceManifestV2 } from "./acceptance-manifest.js";
import {
  GENERATOR_CONTEXT_MANIFEST,
  assembleGeneratorEnvelope,
} from "./context-envelope.js";

const acceptanceManifest: AcceptanceManifestV2 = {
  version: 2,
  fileScope: {
    kind: "paths",
    paths: ["src/feature.ts", "src/feature.test.ts"],
  },
  migrationCount: 0,
  behaviors: [
    {
      id: "B-01",
      source: "GH #83 AC1",
      given: "a locked slice",
      when: "generation starts",
      then: "focused context is assembled",
      observableResult: "the prompt is focused",
      preservation: false,
      gateIds: ["tests"],
    },
  ],
};

describe("generator context envelope", () => {
  it("B-01 assembles the focused initial envelope in manifest order", () => {
    const result = assembleGeneratorEnvelope({
      mode: "initial",
      sliceDir: ".kiro/specs/demo/slices/01-focused",
      contractView: "LOCKED-CONTRACT-VIEW",
      acceptanceManifest,
      patternsAndHarness: "PATTERNS-AND-HARNESS",
      testCommand: "pnpm test:focused",
      migrationReservation: "NO-MIGRATIONS",
      failureSet: { findings: [], gates: [] },
    });

    expect(GENERATOR_CONTEXT_MANIFEST).toMatchObject({
      version: 1,
      role: "generator",
      inputOrder: [
        "contract-view",
        "acceptance-manifest",
        "file-scope",
        "patterns-and-harness",
        "failure-set",
      ],
    });

    const orderedMarkers = [
      "# Objective",
      "# Write boundary",
      "src/feature.ts",
      "`.kiro/specs/demo/slices/01-focused/escalation.md`",
      "LOCKED-CONTRACT-VIEW",
      '"id": "B-01"',
      "PATTERNS-AND-HARNESS",
      "# Current failure set",
    ];
    let previous = -1;
    for (const marker of orderedMarkers) {
      const index = result.prompt.indexOf(marker);
      expect(index, marker).toBeGreaterThan(previous);
      previous = index;
    }

    expect(result.prompt.trimEnd()).toMatch(
      /# Current failure set\r?\n\r?\n\(none\)$/,
    );
    expect(result.prompt).toContain("# What shipped");
    expect(result.prompt).toContain("# Decisions made during implementation");
    expect(result.prompt).toContain("# Gotchas / learnings");
    expect(result.prompt).not.toContain("# Status");
    expect(result.prompt).not.toContain("Reasoning Protocol");
    expect(result.prompt).not.toContain("sibling handoffs");
    expect(result.prompt).not.toContain("grep for `docs/adr/`");
  });
});
