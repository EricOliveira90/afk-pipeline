import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  withContractTransaction,
  type ContractTransactionContext,
} from "./contract-transaction.js";
import { readContractStatus } from "./artifacts.js";
import type { ContractNegotiationOutcome } from "./contract-review.js";
import type { AdjudicationDecisionLog } from "./adjudication.js";

const ACCEPTED_CONTRACT =
  "# Slice Contract\n\n**Status:** LOCKED\n\n" +
  "## Files expected to change\n- src/declared.ts\n";
const ACCEPTED_MANIFEST = JSON.stringify(
  { version: 1, fileScope: { paths: ["src/declared.ts"] } },
  null,
  2,
);
const NOTICE = {
  reason: "the mutation did not complete",
  qualifier: "the previously accepted",
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Harness {
  ctx: ContractTransactionContext;
  contractPath: string;
  manifestPath: string;
  phases: string[];
  gateCalls: number;
}

function makeHarness(options?: {
  manifest?: string | null;
  gate?: (contractPath: string) => string | null;
}): Harness {
  const sliceDir = mkdtempSync(join(tmpdir(), "afk-contract-tx-"));
  dirs.push(sliceDir);
  const contractPath = join(sliceDir, "contract.md");
  const manifestPath = join(sliceDir, "acceptance-manifest.json");
  writeFileSync(contractPath, ACCEPTED_CONTRACT, "utf-8");
  const manifest =
    options?.manifest === undefined ? ACCEPTED_MANIFEST : options.manifest;
  if (manifest !== null) writeFileSync(manifestPath, manifest, "utf-8");
  const phases: string[] = [];
  const harness: Harness = {
    contractPath,
    manifestPath,
    phases,
    gateCalls: 0,
    ctx: {
      absSliceDir: sliceDir,
      tag: "#1234 s01",
      logger: {
        phase(message) {
          phases.push(message);
        },
      },
      ...(options?.gate
        ? {
            onContractLocked: (path: string) => {
              harness.gateCalls += 1;
              return options.gate!(path);
            },
          }
        : {}),
    },
  };
  return harness;
}

/** What a mutation does to the pair before it succeeds or fails. */
function mutate(harness: Harness): void {
  writeFileSync(
    harness.contractPath,
    "# Slice Contract\n\n**Status:** NEGOTIATING\n\n" +
      "## Files expected to change\n- src/declared.ts\n- src/extra.ts\n",
    "utf-8",
  );
  writeFileSync(
    harness.manifestPath,
    JSON.stringify({
      version: 1,
      fileScope: { paths: ["src/declared.ts", "src/extra.ts"] },
    }),
    "utf-8",
  );
}

describe("withContractTransaction", () => {
  it("restores both files when the mutation throws", async () => {
    const harness = makeHarness();
    await expect(
      withContractTransaction(harness.ctx, NOTICE, async () => {
        mutate(harness);
        throw new Error("injected planner throw");
      }),
    ).rejects.toThrow("injected planner throw");

    expect(readFileSync(harness.contractPath, "utf-8")).toBe(ACCEPTED_CONTRACT);
    expect(readContractStatus(harness.contractPath)).toBe("LOCKED");
    expect(readFileSync(harness.manifestPath, "utf-8")).toBe(ACCEPTED_MANIFEST);
  });

  it("restores both files when the mutation returns without accepting", async () => {
    const harness = makeHarness();
    const result = await withContractTransaction(
      harness.ctx,
      NOTICE,
      async () => {
        mutate(harness);
        // A refusal — an evaluator REVISE, a lock-gate objection — returns
        // normally. ADR 0051: acceptance is signalled, never inferred from
        // a return value.
        return "ERROR" as const;
      },
    );

    expect(result).toBe("ERROR");
    expect(readFileSync(harness.contractPath, "utf-8")).toBe(ACCEPTED_CONTRACT);
    expect(readFileSync(harness.manifestPath, "utf-8")).toBe(ACCEPTED_MANIFEST);
  });

  it("keeps the mutation when it signals acceptance", async () => {
    const harness = makeHarness();
    const result = await withContractTransaction(
      harness.ctx,
      NOTICE,
      async (tx) => {
        mutate(harness);
        const locked = tx.lock();
        expect(locked.locked).toBe(true);
        tx.onAccepted();
        return "LOCKED" as const;
      },
    );

    expect(result).toBe("LOCKED");
    expect(readContractStatus(harness.contractPath)).toBe("LOCKED");
    expect(readFileSync(harness.contractPath, "utf-8")).toContain(
      "src/extra.ts",
    );
    expect(harness.phases).toEqual([]);
  });

  it("announces the rollback naming both files", async () => {
    const harness = makeHarness();
    await withContractTransaction(
      harness.ctx,
      {
        reason: "adjudication was not applied",
        qualifier: "the pre-apply",
        note: "the recorded decisions for F-01 are preserved",
      },
      async () => {
        mutate(harness);
      },
    );

    expect(harness.phases).toEqual([
      "#1234 s01: adjudication was not applied — restored the pre-apply " +
        "contract.md and acceptance-manifest.json; the recorded decisions " +
        "for F-01 are preserved",
    ]);
  });

  it("deletes a manifest the mutation created when there was none", async () => {
    const harness = makeHarness({ manifest: null });
    await withContractTransaction(harness.ctx, NOTICE, async () => {
      mutate(harness);
    });

    expect(existsSync(harness.manifestPath)).toBe(false);
    expect(readFileSync(harness.contractPath, "utf-8")).toBe(ACCEPTED_CONTRACT);
  });

  it("reports the lock gate's objection as a refusal", async () => {
    const harness = makeHarness({ gate: () => "injected lock-gate refusal" });
    const refusal = await withContractTransaction(
      harness.ctx,
      NOTICE,
      async (tx) => {
        mutate(harness);
        const locked = tx.lock();
        return locked.locked ? null : locked.refusal;
      },
    );

    expect(refusal).toBe("injected lock-gate refusal");
    expect(harness.gateCalls).toBe(1);
    // The rollback, not a local reopen, is what the operator finds.
    expect(readFileSync(harness.contractPath, "utf-8")).toBe(ACCEPTED_CONTRACT);
  });

  it("refuses the lock while a blocking finding has no decision", async () => {
    const harness = makeHarness({ gate: () => null });
    const outcome: ContractNegotiationOutcome = {
      version: 1,
      classification: "IMPASSE",
      round: 2,
      attempt: 1,
      findings: [
        {
          id: "F-01",
          severity: "BLOCKING",
          state: "CONTESTED",
          unresolved: true,
          plannerPosition: "CONTESTED",
          plannerEvidence: "planner evidence",
          evaluatorEvidence: "evaluator evidence",
        },
      ],
    };
    const log: AdjudicationDecisionLog = {
      version: 1,
      impasse: "fingerprint",
      decisions: [],
      applied: false,
    };

    const refusal = await withContractTransaction(
      harness.ctx,
      NOTICE,
      async (tx) => {
        mutate(harness);
        const locked = tx.lock({ completion: { outcome, log } });
        return locked.locked ? null : locked.refusal;
      },
    );

    expect(refusal).toBe(
      "unresolved blocking finding F-01 has no recorded human decision",
    );
    // The predicate refuses *before* the contract is locked, so the gate is
    // never consulted and no LOCKED status is ever written.
    expect(harness.gateCalls).toBe(0);
    expect(readFileSync(harness.contractPath, "utf-8")).toBe(ACCEPTED_CONTRACT);
  });
});
