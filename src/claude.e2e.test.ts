import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invoke } from "./claude.js";

// Opt-in end-to-end smoke test for the guardian-review code path. Hits
// the real `claude` CLI and asserts that bare-mode invocations produce
// a parseable verdict file. Catches regressions of the
// `superpowers:using-superpowers` hook hijack (ADR 0009) and any
// future plugin SessionStart hook that defeats `--bare`.
//
// Skipped by default because:
// - Costs Bedrock tokens (~$0.05 per run).
// - Takes ~30-60 s.
// - Requires the `claude` CLI on PATH and Bedrock creds.
//
// Run locally with:  AFK_E2E=1 pnpm test src/claude.e2e.test.ts
const e2e = process.env.AFK_E2E === "1" ? describe : describe.skip;

e2e("guardian invocation end-to-end", () => {
  it(
    "bare-mode review produces a parseable verdict file",
    { timeout: 180_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "afk-guardian-e2e-"));
      writeFileSync(join(dir, "source.txt"), "PROD_SECRET=hello\n");
      const reviewPath = join(dir, "review.md");
      const prompt = [
        "# Identity",
        "You are an architecture guardian for a smoke test.",
        "",
        "# Invariants",
        "- Your review file MUST contain a line exactly: `**Verdict:** SHIP`",
        "  or `**Verdict:** ACCEPT-WITH-NOTES` or `**Verdict:** FIX-BEFORE-SHIP`",
        "  (bold, with colon).",
        "",
        "# Task",
        `Read source.txt in the current directory. Then write review.md with`,
        `a one-line verdict (SHIP is fine for this fixture) and a one-`,
        `sentence rationale. Do not ask questions.`,
        "",
        "**How to write the file:** Use the Bash tool with a heredoc:",
        "```",
        "cat << 'REVIEW_EOF' > review.md",
        "<your review content here>",
        "REVIEW_EOF",
        "```",
      ].join("\n");

      const result = await invoke({
        role: "architect-review-e2e",
        agent: "architect-review",
        bare: true,
        prompt,
        cwd: dir,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(reviewPath)).toBe(true);
      const content = readFileSync(reviewPath, "utf-8");
      expect(content).toMatch(
        /\*\*Verdict:\*\*\s*(SHIP|ACCEPT-WITH-NOTES|FIX-BEFORE-SHIP)/,
      );
    },
  );
});
