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
