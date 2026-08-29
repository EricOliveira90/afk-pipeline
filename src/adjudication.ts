import type { ContractNegotiationOutcome } from "./contract-review.js";

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
