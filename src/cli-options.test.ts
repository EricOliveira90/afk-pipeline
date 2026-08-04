import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CONTRACT_ROUNDS,
  parseMaxContractRounds,
  parseSliceSelection,
  parsePipelineRuntimeOptions,
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
describe("parseSliceSelection", () => {
  it("accepts a comma-separated list and preserves zero padding", () => {
    expect(parseSliceSelection("01, 02,04")).toEqual(["01", "02", "04"]);
  });

  it.each([undefined, "", "01,two", "01,"])(
    "rejects invalid value %s",
    (value) => {
      expect(() => parseSliceSelection(value)).toThrow(/--slices/);
    },

  );
});
describe("parsePipelineRuntimeOptions", () => {
  it("parses configurable heartbeat timeouts and infrastructure retries", () => {
    expect(
      parsePipelineRuntimeOptions([
        "--command-timeout-ms", "900000",
        "--heartbeat-interval-ms", "15000",
        "--infrastructure-retries", "4",
      ]),
    ).toMatchObject({
      commandTimeoutMs: 900_000,
      heartbeatIntervalMs: 15_000,
      infrastructureRetries: 4,
    });
  });

  it("requires preview verify and apply commands together", () => {
    expect(() =>
      parsePipelineRuntimeOptions(["--preview-verify-command", "pnpm db:verify"]),
    ).toThrow(/provided together/);
  });

  it("builds shared-preview configuration with an optional lock path", () => {
    expect(
      parsePipelineRuntimeOptions([
        "--preview-verify-command", "pnpm db:verify",
        "--preview-apply-command", "pnpm db:apply",
        "--preview-lock-path", "C:/locks/preview.lock",
      ]).sharedPreview,
    ).toEqual({
      verifyMigrationCommand: "pnpm db:verify",
      applyMigrationCommand: "pnpm db:apply",
      lockPath: "C:/locks/preview.lock",
    });
  });

  it.each([
    ["--command-timeout-ms", "0"],
    ["--heartbeat-interval-ms", "abc"],
    ["--infrastructure-retries", "-1"],
  ])("rejects invalid %s", (flag, value) => {
    expect(() => parsePipelineRuntimeOptions([flag, value])).toThrow(flag);
  });

  it("rejects a runtime flag with no value", () => {
    expect(() => parsePipelineRuntimeOptions(["--command-timeout-ms"]))
      .toThrow(/requires a value/);
  });
});
