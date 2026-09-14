/**
 * The three pipeline entries' shared launch surface (#264).
 *
 * Two cheap rungs of AGENTS.md's assertion ladder, neither of which is a
 * pipeline run: the entry sources read as text for their provider wiring, and
 * each entry spawned with no arguments for its `usage()` text. A missing wrap
 * and an unconditional wrap each fail the source assertions — the flag-on /
 * flag-off decision must exist in exactly one place
 * (`providerForRun`), so no entry may call `withPromptRecording` directly.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const TSX_LOADER = pathToFileURL(
  resolve("node_modules", "tsx", "dist", "loader.mjs"),
).href;

const ENTRIES = ["afk.ts", "afk-claude.ts", "afk-codex.ts"] as const;

function usageStderr(entry: string): string {
  const result = spawnSync(
    process.execPath,
    ["--import", TSX_LOADER, resolve("src", entry)],
    { encoding: "utf-8", env: process.env, timeout: 30_000 },
  );
  if (result.error) throw result.error;
  return result.stderr;
}

describe("pipeline CLI entries", () => {
  it.each(ENTRIES)(
    "B-08 routes %s's provider through providerForRun with the parsed flag",
    (entry) => {
      const source = readFileSync(resolve("src", entry), "utf-8");

      expect(source).toContain("providerForRun(");
      expect(source).toMatch(
        /provider: providerForRun\([\s\S]{0,80}runtimeOptions\.recordPrompts\)/,
      );
      // The decision lives in providerForRun alone; an entry that wrapped
      // directly would be a second copy of it.
      expect(source).not.toContain("withPromptRecording(");
    },
  );

  it.each(ENTRIES)("B-08 advertises --record-prompts in %s's usage", (entry) => {
    const stderr = usageStderr(entry);

    expect(stderr).toContain("[--record-prompts]");
  }, 40_000);

  it.each(ENTRIES)("#275 advertises --allow-concurrent-run in %s's usage", (entry) => {
    const stderr = usageStderr(entry);

    expect(stderr).toContain("[--allow-concurrent-run]");
  }, 40_000);

  /**
   * The host run lease (#275, ADR 0069) is acquired by every entry through
   * the one shared boundary, positioned after the dry-run early return and
   * before the cancellation/crash handlers that precede `runPipeline` — so
   * subcommands and dry runs never acquire it, and refusal happens before
   * any run-state, branch, worktree, agent or gate side effect. A
   * source-order check on purpose: the position of the acquisition is a
   * property of the diff, not of any run.
   */
  it.each(ENTRIES)(
    "#275 acquires the host run lease in %s after dry-run and before the pipeline handlers",
    (entry) => {
      const source = readFileSync(resolve("src", entry), "utf-8");

      const dryRunReturn = source.indexOf("Dry run complete. No changes made.");
      const leaseAcquire = source.indexOf("acquireHostRunLeaseOrExit({");
      const handlers = source.indexOf("installCancellationSignals()");
      expect(dryRunReturn).toBeGreaterThan(-1);
      expect(leaseAcquire).toBeGreaterThan(dryRunReturn);
      expect(handlers).toBeGreaterThan(leaseAcquire);
      // Exactly one acquisition, parsing the flag it documents, and the
      // explicit release at pipeline wind-down.
      expect(source.match(/acquireHostRunLeaseOrExit\(/g)).toHaveLength(1);
      expect(source).toContain('args[i] === "--allow-concurrent-run"');
      expect(source).toContain("runLease.release()");
    },
  );
});
