/**
 * Test support for `afk eval`: a stub `AgentProvider` in the
 * `buildStubProvider` mould, the artifact builders its behaviors write, and
 * pack authoring helpers (`prd.md` D35).
 *
 * **No fixture here re-derives a JSON schema by hand.** The schema-valid
 * artifacts come from the builders production tests already use —
 * `writeContractReview` / `writeQAReview` (`src/test-support.ts`),
 * `writeAcceptanceManifest` / `REVISION_PLANNER_ESCALATION`
 * (`src/orchestrator.fixtures.ts`) — and only the three artifacts no builder
 * exists for are hand-authored: `final-review.json` and the two guardian
 * markdown reviews, which have no schema because `parseGuardianReview` never
 * throws.
 *
 * A live-model eval run is an operator action, never a test: every
 * `runEvalCli` call site under `src/` dispatches to this stub (B-29).
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AgentProvider,
  InvocationStats,
  InvokeOptions,
  InvokeResult,
} from "./agent-provider.js";
import type { EvalRole } from "./eval-pack.js";
import {
  REVISION_PLANNER_ESCALATION,
  writeAcceptanceManifest,
} from "./orchestrator.fixtures.js";
import { writeContractReview, writeQAReview } from "./test-support.js";

/** What one stub invocation does. Every member is optional on purpose: the
 * absence of `write` is the "role wrote no artifact" case (B-13). */
export interface EvalStubBehavior {
  /** Write the role's artifact into the case's scratch directory. */
  write?: (cwd: string) => void;
  /** Non-zero makes the case `ERROR` naming the code, artifact unread. */
  exitCode?: number;
  /** Reject instead of returning — a `TransientProviderError` included. */
  reject?: Error;
  stats?: InvocationStats;
  stdout?: string;
}

export interface EvalStubInvocation {
  options: InvokeOptions;
  role: string;
  cwd: string;
  /**
   * The scratch directory's recursive listing **at invoke entry**, before this
   * behavior wrote anything — which is the only moment at which "seeded from
   * `files` only, with no other entry present" (B-08) is a fact about the
   * directory. Relative, forward-slashed, sorted.
   */
  seededEntries: string[];
  /** Those files' bytes, same moment, keyed the same way. */
  seededBytes: Record<string, string>;
}

/** Recursive relative listing, forward-slashed and sorted. */
function listFiles(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...listFiles(join(dir, entry.name), relative));
    else found.push(relative);
  }
  return found.sort();
}

/**
 * A stub provider that reads `options.role` and `options.cwd`, snapshots the
 * seeded directory, runs the behavior for this invocation, and records the
 * call. Behaviors are consumed by index and the last one repeats, so a
 * one-behavior array serves a pack of any size.
 */
export function buildEvalStubProvider(
  behaviors: readonly EvalStubBehavior[],
  options: { name?: string } = {},
): { provider: AgentProvider; calls: EvalStubInvocation[] } {
  const calls: EvalStubInvocation[] = [];
  const provider: AgentProvider = {
    name: options.name ?? "eval-stub",
    async invoke(invokeOptions: InvokeOptions): Promise<InvokeResult> {
      const cwd = invokeOptions.cwd;
      const seededEntries = listFiles(cwd);
      const seededBytes: Record<string, string> = {};
      for (const entry of seededEntries) {
        seededBytes[entry] = readFileSync(join(cwd, ...entry.split("/")), "utf-8");
      }
      calls.push({
        options: invokeOptions,
        role: invokeOptions.role,
        cwd,
        seededEntries,
        seededBytes,
      });
      const behavior =
        behaviors[Math.min(calls.length - 1, behaviors.length - 1)];
      if (behavior === undefined) {
        throw new Error("eval stub provider was built with no behaviors");
      }
      if (behavior.reject !== undefined) throw behavior.reject;
      behavior.write?.(cwd);
      return {
        exitCode: behavior.exitCode ?? 0,
        stdout: behavior.stdout ?? "",
        stats: behavior.stats ?? {},
      };
    },
  };
  return { provider, calls };
}

// ---------------------------------------------------------------------------
// Artifact builders — what a role writes into its scratch directory.
// ---------------------------------------------------------------------------

/** `contract-review.json`, via the production-test builder. */
export function writeEvalContractReview(
  cwd: string,
  verdict: "ACCEPT" | "REVISE",
): void {
  writeContractReview(cwd, verdict);
}

/** `qa-review.json`, via the production-test builder. */
export function writeEvalQAReview(
  cwd: string,
  verdict: "PASS" | "FAIL",
  failureClass?: "NONE" | "IMPLEMENTATION" | "INFRASTRUCTURE",
): void {
  writeQAReview(cwd, "deterministic", { verdict, failureClass });
}

/**
 * `final-review.json`. Hand-authored because no builder exists: exactly the
 * five fields `parseFinalReview` admits, and a FAIL carries the one finding
 * the parser requires of it.
 */
export function writeEvalFinalReview(
  cwd: string,
  verdict: "PASS" | "FAIL",
): void {
  writeFileSync(
    join(cwd, "final-review.json"),
    JSON.stringify(
      {
        version: 1,
        verdict,
        baselineTreeId: "1111111111111111111111111111111111111111",
        finalTreeId: "2222222222222222222222222222222222222222",
        findings:
          verdict === "FAIL"
            ? [
                {
                  id: "FE-01",
                  class: "PRESERVATION",
                  summary: "Fixture preservation finding",
                  evidence: "The fixture evaluator observed preserved behavior lost",
                  expected: "The preserved behavior still passes",
                  observed: "The preserved behavior fails",
                  repair: "RESTORE",
                },
              ]
            : [],
      },
      null,
      2,
    ),
    "utf-8",
  );
}

/** The planner's escalation sentinel — the record the pipeline asserts on. */
export function writeEvalPlannerEscalation(cwd: string): void {
  writeFileSync(
    join(cwd, "planner-escalation.md"),
    JSON.stringify(REVISION_PLANNER_ESCALATION, null, 2),
    "utf-8",
  );
}

/** A sentinel `readPlannerEscalation` reads as `{ kind: "malformed" }`. */
export function writeEvalMalformedPlannerEscalation(cwd: string): void {
  writeFileSync(
    join(cwd, "planner-escalation.md"),
    JSON.stringify({ version: 1, criterion: "NOT_A_CRITERION" }, null, 2),
    "utf-8",
  );
}

/**
 * A planner CONTRACT: an `acceptance-manifest.json` beside a `contract.md`,
 * nested one directory deep, which is where a slice's artifacts live.
 *
 * `writeAcceptanceManifest` walks up for a `.git` marker to derive the gate
 * catalog, so the scratch root gets an empty one. It is written by the stub
 * *during* the invocation, so it is never part of the seeded directory B-08
 * asserts on.
 */
export function writeEvalPlannerContract(cwd: string): void {
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const sliceDir = join(cwd, "slice");
  mkdirSync(sliceDir, { recursive: true });
  writeFileSync(
    join(sliceDir, "contract.md"),
    "# Slice Contract — fixture\n\n**Status:** LOCKED\n",
    "utf-8",
  );
  writeAcceptanceManifest(sliceDir);
}

/**
 * A guardian review. Hand-authored because `parseGuardianReview` never throws
 * and so has no schema module: an exact `**Verdict:**` line, one structured
 * findings heading at the guardian's version, and the JSON object below it.
 * A SHIP carries no finding; anything else carries one.
 */
export function writeEvalGuardianReview(
  cwd: string,
  guardian: "pm" | "architect",
  outcome: "SHIP" | "ACCEPT-WITH-NOTES" | "FIX-BEFORE-SHIP",
): void {
  const version = guardian === "architect" ? 2 : 1;
  const finding: Record<string, unknown> = {
    id: "G-01",
    title: "Fixture gap",
    class: "INTEGRITY",
    clearCondition: "The fixture records the gap as closed.",
    disposition: "OPEN",
  };
  if (guardian === "architect") {
    finding.reachableTrigger = "A fixture run reads the record.";
    finding.introducedByReviewedDiff = true;
  }
  writeFileSync(
    join(cwd, `review-${guardian}.md`),
    [
      "# Guardian review",
      "",
      `**Verdict:** ${outcome}`,
      "",
      `## Structured findings (v${version})`,
      JSON.stringify({
        version,
        findings: outcome === "SHIP" ? [] : [finding],
      }),
      "",
      "Prose remains allowed.",
    ].join("\n"),
    "utf-8",
  );
}

/** A review whose verdict line is missing, so the outcome is UNPARSEABLE. */
export function writeEvalUnparseableGuardianReview(
  cwd: string,
  guardian: "pm" | "architect",
): void {
  writeFileSync(
    join(cwd, `review-${guardian}.md`),
    "# Guardian review\n\nThe reviewer wrote prose and no verdict line.\n",
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Pack authoring.
// ---------------------------------------------------------------------------

/** A valid case document, before overrides. Every refusing fixture starts
 * here and breaks exactly one member, so the refusal names that member. */
export function evalCaseDocument(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    id: "case-01",
    role: "evaluator-contract",
    source: "#194 contract evaluator blocked on a false premise",
    prompt: "Review the locked contract and write contract-review.json.",
    files: {},
    expected: { verdict: "ACCEPT" },
    ...overrides,
  };
}

/** The default `expected` for each role, so a per-role fixture stays one line. */
export const EVAL_ROLE_EXPECTED: Readonly<
  Record<EvalRole, Record<string, string>>
> = {
  "evaluator-contract": { verdict: "ACCEPT" },
  "evaluator-qa": { verdict: "PASS", failureClass: "NONE" },
  "evaluator-final": { verdict: "PASS" },
  planner: { artifact: "CONTRACT" },
  pm: { outcome: "SHIP" },
  architect: { outcome: "SHIP" },
};

/** The artifact that makes {@link EVAL_ROLE_EXPECTED} a MATCH for each role. */
export const EVAL_ROLE_MATCHING_ARTIFACT: Readonly<
  Record<EvalRole, (cwd: string) => void>
> = {
  "evaluator-contract": (cwd) => writeEvalContractReview(cwd, "ACCEPT"),
  "evaluator-qa": (cwd) => writeEvalQAReview(cwd, "PASS", "NONE"),
  "evaluator-final": (cwd) => writeEvalFinalReview(cwd, "PASS"),
  planner: (cwd) => writeEvalPlannerContract(cwd),
  pm: (cwd) => writeEvalGuardianReview(cwd, "pm", "SHIP"),
  architect: (cwd) => writeEvalGuardianReview(cwd, "architect", "SHIP"),
};

/**
 * Write a pack into a fresh temporary directory and return its path. Values
 * are JSON-encoded unless already a string, so a fixture can commit malformed
 * bytes. Nothing here is committed: every refusing pack lives in its own
 * `mkdtemp` directory (scope lock), and the caller removes it.
 */
export function writeEvalPackDir(
  files: Record<string, unknown>,
  prefix = "afk-eval-pack-",
): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const [name, value] of Object.entries(files)) {
    const path = join(dir, ...name.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
      "utf-8",
    );
  }
  return dir;
}

/** A one-case pack for `role`, with that role's default `expected`. */
export function writeEvalRolePack(
  role: EvalRole,
  overrides: Record<string, unknown> = {},
): string {
  return writeEvalPackDir({
    "01-case.json": evalCaseDocument({
      id: `${role}-case`,
      role,
      expected: EVAL_ROLE_EXPECTED[role],
      ...overrides,
    }),
  });
}
