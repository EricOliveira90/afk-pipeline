import { describe, expect, it } from "vitest";
import {
  parseDraftPrNumber,
  serializeTerminalHandoff,
  type TerminalHandoff,
} from "./handoff.js";

describe("terminal handoff serialization", () => {
  it("serializes stable machine-readable scope and shipping metadata", () => {
    const handoff: TerminalHandoff = {
      version: 1,
      runStatus: "SUCCEEDED",
      selectedSlices: [
        {
          number: "01",
          ghIssue: "101",
          title: "Foundation",
          type: "AFK",
          status: "PASS",
        },
      ],
      skippedSlices: [
        {
          number: "02",
          ghIssue: "102",
          title: "Manual review",
          type: "HITL",
          reason: "hitl",
        },
      ],
      featureBranch: "feat-codex/example",
      finalCommitSha: "abc123",
      migrationFilesCreated: ["supabase/migrations/001_example.sql"],
      githubIssuesToClose: ["101"],
      draftPr: {
        number: 42,
        url: "https://github.com/example/repo/pull/42",
      },
    };

    const serialized = serializeTerminalHandoff(handoff);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(JSON.parse(serialized)).toEqual(handoff);
  });

  it("extracts a draft PR number when a GitHub URL is available", () => {
    expect(parseDraftPrNumber("https://github.com/example/repo/pull/42")).toBe(
      42,
    );
    expect(parseDraftPrNumber(null)).toBeNull();
  });
});
