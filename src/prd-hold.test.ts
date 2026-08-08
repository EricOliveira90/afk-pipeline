import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ON_HOLD_STATUS_PATTERN, checkPrdHold } from "./prd-hold.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "afk-prd-hold-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ON_HOLD_STATUS_PATTERN", () => {
  it("matches frontmatter and bold status forms", () => {
    expect(ON_HOLD_STATUS_PATTERN.test("Status: On Hold")).toBe(true);
    expect(ON_HOLD_STATUS_PATTERN.test("**Status:** On Hold")).toBe(true);
  });

  it("does not match other statuses or prose mentions", () => {
    expect(ON_HOLD_STATUS_PATTERN.test("Status: Ready for Agent")).toBe(false);
    expect(ON_HOLD_STATUS_PATTERN.test("The PRD was previously on hold.")).toBe(false);
  });
});

describe("checkPrdHold", () => {
  it("reports no hold for a normal PRD", () => {
    writeFileSync(join(dir, "prd.md"), "# PRD 999\n\n**Status:** Ready for Agent\n");
    expect(checkPrdHold(dir)).toEqual({ onHold: false, reasons: [] });
  });

  it("holds when afk.on-hold.json exists and names its gate", () => {
    writeFileSync(join(dir, "prd.md"), "# PRD 999\n");
    writeFileSync(
      join(dir, "afk.on-hold.json"),
      JSON.stringify({ status: "on-hold", blockedBy: [604] }),
    );

    const check = checkPrdHold(dir);
    expect(check.onHold).toBe(true);
    expect(check.reasons).toHaveLength(1);
    expect(check.reasons[0]).toContain("afk.on-hold.json");
    expect(check.reasons[0]).toContain("#604");
  });

  it("holds when prd.md declares Status: On Hold", () => {
    writeFileSync(join(dir, "prd.md"), "---\nStatus: On Hold\n---\n\n# PRD 999\n");

    const check = checkPrdHold(dir);
    expect(check.onHold).toBe(true);
    expect(check.reasons[0]).toContain("Status: On Hold");
  });

  it("fails closed on an unreadable marker file", () => {
    writeFileSync(join(dir, "prd.md"), "# PRD 999\n");
    writeFileSync(join(dir, "afk.on-hold.json"), "{not json");

    const check = checkPrdHold(dir);
    expect(check.onHold).toBe(true);
    expect(check.reasons[0]).toContain("marker unreadable");
  });

  it("reports both signals when both are present", () => {
    writeFileSync(join(dir, "prd.md"), "**Status:** On Hold\n");
    writeFileSync(join(dir, "afk.on-hold.json"), JSON.stringify({ blockedBy: [] }));

    const check = checkPrdHold(dir);
    expect(check.onHold).toBe(true);
    expect(check.reasons).toHaveLength(2);
  });
});

describe("CLI wiring", () => {
  it.each(["afk.ts", "afk-claude.ts", "afk-codex.ts"])(
    "%s guards against on-hold PRDs after resolving the PRD dir",
    async (entry) => {
      const { readFileSync } = await import("node:fs");
      const source = readFileSync(join(__dirname, entry), "utf-8");
      expect(source).toContain("assertPrdNotOnHold(prdDir)");
    },
  );
});
