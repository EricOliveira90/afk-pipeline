import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContractNegotiationOutcome } from "./contract-review.js";
import { CONTRACT_NEGOTIATION_OUTCOME_FILENAME } from "./contract-review.js";

export const ADJUDICATION_FILENAME = "adjudication.md";

export type Adjudication =
  | {
      version: 1;
      findingId: string;
      winningPosition: "PLANNER" | "EVALUATOR";
      author: string;
    }
  | {
      version: 1;
      findingId: string;
      thirdInstruction: string;
      author: string;
    };

export type AdjudicationWaitResult =
  | { status: "accepted" }
  | { status: "expired"; defect?: string }
  | { status: "cancelled" };

function requireNonBlankString(
  value: unknown,
  field: string,
  source: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${source} ${field} must be a non-blank string`);
  }
}

export function parseAdjudication(
  value: string | unknown,
  impasse: ContractNegotiationOutcome,
  source = ADJUDICATION_FILENAME,
): Adjudication {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch (error) {
    throw new Error(
      `${source} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} must contain a JSON object`);
  }
  const input = parsed as Record<string, unknown>;
  const hasWinner = "winningPosition" in input;
  const hasInstruction = "thirdInstruction" in input;
  if (hasWinner === hasInstruction) {
    throw new Error(
      `${source} must contain exactly one of winningPosition or thirdInstruction`,
    );
  }

  const decisionKey = hasWinner ? "winningPosition" : "thirdInstruction";
  const expected = ["version", "findingId", decisionKey, "author"];
  const keys = Object.keys(input);
  const expectedSet = new Set(expected);
  if (
    keys.some((key) => !expectedSet.has(key)) ||
    expected.some((key) => !(key in input))
  ) {
    throw new Error(
      `${source} root object must contain exactly version, findingId, author and one of winningPosition or thirdInstruction`,
    );
  }
  if (input.version !== 1) {
    throw new Error(`${source} must declare version 1`);
  }

  requireNonBlankString(input.findingId, "findingId", source);
  requireNonBlankString(input.author, "author", source);
  const finding = impasse.findings.find(({ id }) => id === input.findingId);
  if (!finding) {
    throw new Error(
      `${source} findingId ${input.findingId} is absent from the current IMPASSE`,
    );
  }
  if (finding.state !== "CONTESTED") {
    throw new Error(
      `${source} findingId ${input.findingId} is not CONTESTED in the current IMPASSE`,
    );
  }

  if (hasWinner) {
    if (
      input.winningPosition !== "PLANNER" &&
      input.winningPosition !== "EVALUATOR"
    ) {
      throw new Error(
        `${source} winningPosition must be PLANNER or EVALUATOR`,
      );
    }
    return {
      version: 1,
      findingId: input.findingId,
      winningPosition: input.winningPosition,
      author: input.author,
    };
  }

  requireNonBlankString(
    input.thirdInstruction,
    "thirdInstruction",
    source,
  );
  return {
    version: 1,
    findingId: input.findingId,
    thirdInstruction: input.thirdInstruction,
    author: input.author,
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForAdjudication(options: {
  sliceDir: string;
  waitMs: number;
  pollMs: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<AdjudicationWaitResult> {
  const { sliceDir, waitMs, pollMs, signal } = options;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) {
    throw new Error("adjudication wait must be a non-negative integer");
  }
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) {
    throw new Error("adjudication poll interval must be a positive integer");
  }

  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const deadline = now() + waitMs;
  const outcomePath = join(
    sliceDir,
    CONTRACT_NEGOTIATION_OUTCOME_FILENAME,
  );
  const decisionPath = join(sliceDir, ADJUDICATION_FILENAME);
  let latestDefect: string | undefined;

  while (true) {
    if (signal?.aborted) return { status: "cancelled" };
    if (existsSync(decisionPath)) {
      try {
        const outcome = JSON.parse(
          readFileSync(outcomePath, "utf-8"),
        ) as ContractNegotiationOutcome;
        parseAdjudication(readFileSync(decisionPath, "utf-8"), outcome);
        return { status: "accepted" };
      } catch (error) {
        latestDefect = error instanceof Error ? error.message : String(error);
      }
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      return {
        status: "expired",
        ...(latestDefect ? { defect: latestDefect } : {}),
      };
    }
    await sleep(Math.min(pollMs, remaining), signal);
  }
}
