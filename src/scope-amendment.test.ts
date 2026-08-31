import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAcceptanceManifest,
  type AcceptanceManifest,
} from "./acceptance-manifest.js";
import {
  appendContractScopeFiles,
  applyScopeAmendment,
  buildScopeAmendmentRecord,
  planScopeAmendment,
  type ScopeAmendmentPlan,
} from "./scope-amendment.js";
import { withContractTransaction } from "./contract-transaction.js";

const NOTICE = {
  reason: "qa scope amendment did not complete",
  qualifier: "the previously accepted",
};

const MANIFEST = {
  version: 2,
  fileScope: { kind: "paths", paths: ["src/Resume.ts"] },
  migrationCount: 0,
  behaviors: [
    {
      id: "B-01",
      source: "GH #75 AC1",
      given: "a slice with test support",
      when: "the suite runs",
      then: "it passes",
      observableResult: "green suite",
      preservation: false,
      gateIds: ["tests"],
    },
  ],
};

const CONTRACT = [
  "# Slice Contract — undeclared scope",
  "",
  "**Status:** LOCKED",
  "",
  "## Files expected to change",
  "- src/Resume.ts",
  "",
  "## Migration requirements",
  "- New migration files: 0",
  "",
].join("\n");

function manifest(overrides: Record<string, unknown> = {}): AcceptanceManifest {
  return parseAcceptanceManifest(JSON.stringify({ ...MANIFEST, ...overrides }));
}

function plan(
  args: {
    paths?: string[];
    changedFiles?: string[];
    manifest?: AcceptanceManifest;
    findingId?: string;
  } = {},
): ScopeAmendmentPlan {
  return planScopeAmendment({
    requests: [
      {
        findingId: args.findingId ?? "QA-02",
        paths: args.paths ?? ["src/resume-integration.test.ts"],
      },
    ],
    manifest: args.manifest ?? manifest(),
    changedFiles: args.changedFiles ?? [
      "src/Resume.ts",
      "src/resume-integration.test.ts",
    ],
  });
}

function refusalOf(candidate: ScopeAmendmentPlan): string {
  expect(candidate.ok).toBe(false);
  return candidate.ok ? "" : candidate.refusal;
}

function makeSliceDir(contract = CONTRACT, manifestValue = MANIFEST): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-scope-amend-"));
  writeFileSync(join(dir, "contract.md"), contract, "utf-8");
  writeFileSync(
    join(dir, "acceptance-manifest.json"),
    `${JSON.stringify(manifestValue, null, 2)}\n`,
    "utf-8",
  );
  return dir;
}

describe("planScopeAmendment", () => {
  it("accepts a changed, undeclared, non-migration path", () => {
    expect(plan()).toEqual({
      ok: true,
      findingIds: ["QA-02"],
      entries: [
        {
          path: "src/resume-integration.test.ts",
          key: "src/resume-integration.test.ts",
          findingId: "QA-02",
        },
      ],
    });
  });

  // The declared path keeps the evaluator's casing: normalization exists
  // to compare paths, not to rename them.
  it("declares the path as written while comparing case-insensitively", () => {
    const candidate = plan({
      paths: ["src/ResumeSupport.ts"],
      changedFiles: ["src/resumesupport.ts"],
    });

    expect(candidate.ok && candidate.entries[0]).toEqual({
      path: "src/ResumeSupport.ts",
      key: "src/resumesupport.ts",
      findingId: "QA-02",
    });
  });

  it("collapses the same path requested twice", () => {
    const candidate = planScopeAmendment({
      requests: [
        { findingId: "QA-02", paths: ["src/a.ts"] },
        { findingId: "QA-03", paths: ["./src/a.ts"] },
      ],
      manifest: manifest(),
      changedFiles: ["src/a.ts"],
    });

    expect(candidate.ok && candidate.entries.map(({ path }) => path)).toEqual([
      "src/a.ts",
    ]);
    expect(candidate.ok && candidate.findingIds).toEqual(["QA-02", "QA-03"]);
  });

  it("refuses a path already on the locked file scope", () => {
    expect(refusalOf(plan({ paths: ["src/resume.ts"] }))).toMatch(
      /already on the locked file scope/,
    );
  });

  it("refuses a path the slice never changed", () => {
    expect(
      refusalOf(plan({ changedFiles: ["src/Resume.ts"] })),
    ).toMatch(/not among the files this slice changed/);
  });

  it("refuses a migration file, which needs the prefix renegotiated", () => {
    expect(
      refusalOf(
        plan({
          paths: ["supabase/migrations/0042_add_table.sql"],
          changedFiles: ["supabase/migrations/0042_add_table.sql"],
        }),
      ),
    ).toMatch(/migration prefixes are allocated at contract lock/);
  });

  it.each([
    ["a glob", "src/*.ts", /glob syntax/],
    ["a placeholder", "<unknown>", /placeholder/],
    ["a directory", "src/", /must name a file path/],
    ["an escape", "../outside.ts", /exact repo-relative path/],
  ])("refuses %s", (_name, path, pattern) => {
    expect(refusalOf(plan({ paths: [path], changedFiles: [path] }))).toMatch(
      pattern,
    );
  });

  it("refuses to widen a no-repository-changes scope", () => {
    expect(
      refusalOf(
        plan({
          manifest: manifest({
            fileScope: { kind: "no-repository-changes" },
          }),
        }),
      ),
    ).toMatch(/cannot be widened by amendment/);
  });

  // Every refused path is reported, not just the first: an operator who
  // has to amend by hand needs the whole list.
  it("reports every problem in one refusal", () => {
    const refusal = refusalOf(
      planScopeAmendment({
        requests: [
          { findingId: "QA-02", paths: ["src/resume.ts", "src/absent.ts"] },
        ],
        manifest: manifest(),
        changedFiles: ["src/Resume.ts"],
      }),
    );

    expect(refusal).toMatch(/already on the locked file scope/);
    expect(refusal).toMatch(/not among the files this slice changed/);
  });
});

describe("applyScopeAmendment", () => {
  it("adds the path to the manifest and to the contract's file list", () => {
    const dir = makeSliceDir();
    try {
      const candidate = plan();
      expect(candidate.ok).toBe(true);
      if (!candidate.ok) return;
      applyScopeAmendment({ sliceDir: dir, plan: candidate });

      const written = parseAcceptanceManifest(
        readFileSync(join(dir, "acceptance-manifest.json"), "utf-8"),
      );
      expect(
        written.fileScope.kind === "paths" && written.fileScope.paths,
      ).toEqual(["src/resume.ts", "src/resume-integration.test.ts"]);
      expect(written.version === 2 && written.behaviors).toHaveLength(1);
      expect(written.migrationCount).toBe(0);

      const contract = readFileSync(join(dir, "contract.md"), "utf-8");
      expect(contract).toContain(
        "- src/resume-integration.test.ts (added by scope amendment for QA finding QA-02)",
      );
      // The section that follows must still read as a section.
      expect(contract).toMatch(
        /QA finding QA-02\)\n\n## Migration requirements/,
      );
      expect(contract).toContain("**Status:** LOCKED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a contract with no file-list section", () => {
    const dir = makeSliceDir("# Slice Contract\n\n**Status:** LOCKED\n");
    try {
      const candidate = plan();
      if (!candidate.ok) throw new Error("expected a valid plan");
      expect(() =>
        applyScopeAmendment({ sliceDir: dir, plan: candidate }),
      ).toThrow(/no "## Files expected to change" section to amend/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The composition the QA loop performs (ADR 0055 Seam 1 §3): the amendment
 * is the third path that mutates the accepted pair, so it runs inside the
 * one transaction rather than carrying its own half of a rollback.
 *
 * Tested here rather than through a spawned QA round: what has to be proved
 * is that a throw *after* the manifest write leaves neither file changed,
 * and the transaction is what makes that true for every throw, wherever in
 * the amendment it comes from.
 */
describe("applyScopeAmendment inside the shared contract transaction", () => {
  const txContext = (dir: string) => ({
    absSliceDir: dir,
    tag: "[slice]",
    logger: { phase: () => {} },
  });

  it("restores both files when the contract write refuses after the manifest write", async () => {
    // The contract has no file-list section, so `appendContractScopeFiles`
    // throws — after the manifest has already been widened on disk.
    const dir = makeSliceDir("# Slice Contract\n\n**Status:** LOCKED\n");
    try {
      const candidate = plan();
      if (!candidate.ok) throw new Error("expected a valid plan");
      const contractBefore = readFileSync(join(dir, "contract.md"), "utf-8");
      const manifestBefore = readFileSync(
        join(dir, "acceptance-manifest.json"),
        "utf-8",
      );

      await expect(
        withContractTransaction(txContext(dir), NOTICE, async (tx) => {
          applyScopeAmendment({ sliceDir: dir, plan: candidate });
          tx.onAccepted();
        }),
      ).rejects.toThrow(/no "## Files expected to change" section to amend/);

      expect(readFileSync(join(dir, "contract.md"), "utf-8")).toBe(
        contractBefore,
      );
      expect(readFileSync(join(dir, "acceptance-manifest.json"), "utf-8")).toBe(
        manifestBefore,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores both files when the step after the amendment fails", async () => {
    // Both writes succeeded and the *archive* throws — the caller's own
    // bookkeeping, inside the transaction so the amendment archive is only
    // ever written over a coherent pair.
    const dir = makeSliceDir();
    try {
      const candidate = plan();
      if (!candidate.ok) throw new Error("expected a valid plan");
      const contractBefore = readFileSync(join(dir, "contract.md"), "utf-8");
      const manifestBefore = readFileSync(
        join(dir, "acceptance-manifest.json"),
        "utf-8",
      );

      await expect(
        withContractTransaction(txContext(dir), NOTICE, async () => {
          applyScopeAmendment({ sliceDir: dir, plan: candidate });
          // Stands in for the archive write: any throw before `onAccepted`
          // is a rollback, which is the property the caller relies on.
          throw new Error("archive write failed");
        }),
      ).rejects.toThrow(/archive write failed/);

      expect(readFileSync(join(dir, "contract.md"), "utf-8")).toBe(
        contractBefore,
      );
      expect(readFileSync(join(dir, "acceptance-manifest.json"), "utf-8")).toBe(
        manifestBefore,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a completed amendment", async () => {
    const dir = makeSliceDir();
    try {
      const candidate = plan();
      if (!candidate.ok) throw new Error("expected a valid plan");

      await withContractTransaction(txContext(dir), NOTICE, async (tx) => {
        applyScopeAmendment({ sliceDir: dir, plan: candidate });
        tx.onAccepted();
      });

      const written = parseAcceptanceManifest(
        readFileSync(join(dir, "acceptance-manifest.json"), "utf-8"),
      );
      expect(
        written.fileScope.kind === "paths" && written.fileScope.paths,
      ).toEqual(["src/resume.ts", "src/resume-integration.test.ts"]);
      expect(readFileSync(join(dir, "contract.md"), "utf-8")).toContain(
        "- src/resume-integration.test.ts (added by scope amendment for QA finding QA-02)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("appendContractScopeFiles", () => {
  it("appends to a file list that ends the document", () => {
    const dir = makeSliceDir(
      "# Slice Contract\n\n## Files expected to change\n- src/a.ts\n",
    );
    try {
      appendContractScopeFiles(join(dir, "contract.md"), [
        { path: "src/b.ts", key: "src/b.ts", findingId: "QA-09" },
      ]);
      expect(readFileSync(join(dir, "contract.md"), "utf-8")).toBe(
        "# Slice Contract\n\n## Files expected to change\n- src/a.ts\n" +
          "- src/b.ts (added by scope amendment for QA finding QA-09)\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildScopeAmendmentRecord", () => {
  it("records the findings and the paths they added", () => {
    const candidate = plan();
    if (!candidate.ok) throw new Error("expected a valid plan");

    expect(
      buildScopeAmendmentRecord({
        stage: "deterministic",
        round: 2,
        attempt: 1,
        plan: candidate,
      }),
    ).toEqual({
      version: 1,
      stage: "deterministic",
      round: 2,
      attempt: 1,
      findingIds: ["QA-02"],
      paths: ["src/resume-integration.test.ts"],
    });
  });
});
