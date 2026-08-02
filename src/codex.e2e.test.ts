import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { invoke } from "./codex.js";

const e2e = process.env.AFK_CODEX_E2E === "1" ? describe : describe.skip;

e2e("Codex CLI end-to-end", () => {
  it(
    "writes a requested artifact in a temporary Git repository",
    { timeout: 180_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "afk-codex-e2e-"));
      try {
        execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
        const artifact = join(dir, "codex-smoke.txt");
        const result = await invoke({
          role: "generator-e2e",
          cwd: dir,
          prompt:
            "Create codex-smoke.txt in the current repository containing exactly AFK_CODEX_OK followed by a newline.",
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(artifact)).toBe(true);
        expect(readFileSync(artifact, "utf8")).toBe("AFK_CODEX_OK\n");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
