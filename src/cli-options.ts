export const DEFAULT_MAX_CONTRACT_ROUNDS = 3;

export function parseMaxContractRounds(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error("--max-contract-rounds must be a positive integer");
  }
  const rounds = Number(value);
  if (!Number.isSafeInteger(rounds) || rounds < 1) {
    throw new Error("--max-contract-rounds must be a positive integer");
  }
  return rounds;
}

export function parseSliceSelection(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    throw new Error("--slices requires a comma-separated list of slice numbers");
  }
  const values = value.split(",").map((part) => part.trim());
  if (values.some((part) => !/^\d+$/.test(part))) {
    throw new Error("--slices must contain only comma-separated slice numbers");
  }
  return values;
}
