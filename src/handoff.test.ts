import { describe, expect, it } from "vitest";
import {
  parseDraftPrNumber,
  serializeTerminalHandoff,
  unresolvedGuardianIssues,
  type TerminalHandoff,
} from "./handoff.js";
import type { RunEvent, RunEventPayload } from "./run-events.js";

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
      unresolvedGuardianIssues: [
        {
          issue: "https://github.com/example/repo/issues/291",
          guardian: "pm",
          stableId: "P-01",
          kind: "BLOCKER",
          action: "REFUSED",
          detail: "an ID alone is not identity",
        },
      ],
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

/**
 * #320: what a run leaves open. PRD 5's operator had to diff review artifacts
 * against issue bodies because nothing machine-readable said which guardian
 * tickets were still live work.
 */
describe("unresolvedGuardianIssues", () => {
  const event = (payload: RunEventPayload): RunEvent => ({
    ts: "2026-09-14T00:00:00.000Z",
    ...payload,
  });
  const reconciliation = (
    issue: string,
    action: Extract<
      RunEventPayload,
      { type: "guardian-issue-reconciliation" }
    >["action"],
    overrides: Partial<
      Extract<RunEventPayload, { type: "guardian-issue-reconciliation" }>
    > = {},
  ) =>
    event({
      type: "guardian-issue-reconciliation",
      guardian: "architect",
      stableId: "A-01",
      issue,
      kind: "NOTE",
      round: 4,
      action,
      detail: `${action} ${issue}`,
      ...overrides,
    });

  it("reports every issue the run did not close, with the last word per issue", () => {
    expect(
      unresolvedGuardianIssues([
        event({ type: "run-started", provider: "claude", runSlug: "demo" }),
        // Updated in an earlier pass, then closed: one ticket, and it is done.
        reconciliation("https://github.com/acme/repo/issues/290", "UPDATED"),
        reconciliation("https://github.com/acme/repo/issues/290", "CLOSED"),
        // Closed, then the finding came back.
        reconciliation("https://github.com/acme/repo/issues/291", "CLOSED", {
          stableId: "A-02",
        }),
        reconciliation("https://github.com/acme/repo/issues/291", "REOPENED", {
          stableId: "A-02",
        }),
        reconciliation("https://github.com/acme/repo/issues/292", "REFUSED", {
          guardian: "pm",
          stableId: "P-01",
          kind: "BLOCKER",
          refusal: "stable-id-collision",
          detail: "an ID alone is not identity",
        }),
        // A tracker call that never went through leaves the issue open too.
        reconciliation("https://github.com/acme/repo/issues/293", "FAILED", {
          stableId: "A-03",
        }),
      ]),
    ).toEqual([
      {
        issue: "https://github.com/acme/repo/issues/291",
        guardian: "architect",
        stableId: "A-02",
        kind: "NOTE",
        action: "REOPENED",
        detail: "REOPENED https://github.com/acme/repo/issues/291",
      },
      {
        issue: "https://github.com/acme/repo/issues/292",
        guardian: "pm",
        stableId: "P-01",
        kind: "BLOCKER",
        action: "REFUSED",
        detail: "an ID alone is not identity",
      },
      {
        issue: "https://github.com/acme/repo/issues/293",
        guardian: "architect",
        stableId: "A-03",
        kind: "NOTE",
        action: "FAILED",
        detail: "FAILED https://github.com/acme/repo/issues/293",
      },
    ]);
  });

  it("reports nothing for a run that reconciled nothing", () => {
    expect(
      unresolvedGuardianIssues([
        event({ type: "run-ended", outcome: "SUCCEEDED" }),
      ]),
    ).toEqual([]);
  });
});
