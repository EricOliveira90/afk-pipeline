import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CONTRACT_ROUNDS,
  parseMaxContractRounds,
} from "./cli-options.js";

describe("parseMaxContractRounds", () => {
  it("defaults at the call site to three rounds", () => {
    expect(DEFAULT_MAX_CONTRACT_ROUNDS).toBe(3);
  });

  it("accepts positive integers", () => {
    expect(parseMaxContractRounds("1")).toBe(1);
    expect(parseMaxContractRounds("4")).toBe(4);
  });

  it.each([undefined, "", "0", "-1", "1.5", "abc"])(
    "rejects invalid value %s",
    (value) => {
      expect(() => parseMaxContractRounds(value)).toThrow(/positive integer/);
    },
  );
});
