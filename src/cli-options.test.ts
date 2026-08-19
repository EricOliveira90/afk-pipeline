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
        "--max-agent-duration-ms", "5400000",
      ]),
    ).toMatchObject({
      commandTimeoutMs: 900_000,
      heartbeatIntervalMs: 15_000,
      infrastructureRetries: 4,
      maxAgentDurationMs: 5_400_000,
    });
  });

  it("leaves the agent duration ceiling undefined so role-aware defaults apply", () => {
    expect(parsePipelineRuntimeOptions([]).maxAgentDurationMs).toBeUndefined();
  });

  it("parses the transient retry window, allowing 0 to disable (ADR 0022)", () => {
    expect(
      parsePipelineRuntimeOptions(["--transient-retry-window-ms", "600000"])
        .transientRetryWindowMs,
    ).toBe(600_000);
    expect(
      parsePipelineRuntimeOptions(["--transient-retry-window-ms", "0"])
        .transientRetryWindowMs,
    ).toBe(0);
    expect(
      parsePipelineRuntimeOptions([]).transientRetryWindowMs,
    ).toBeUndefined();
    expect(() =>
      parsePipelineRuntimeOptions(["--transient-retry-window-ms", "-5"]),
    ).toThrow("--transient-retry-window-ms");
  });

  it("enables serial lane execution explicitly", () => {
    expect(parsePipelineRuntimeOptions(["--serial-lanes"]).serialLanes).toBe(true);
  });

  it("enables the PM-verdict PR override explicitly and defaults it off", () => {
    expect(
      parsePipelineRuntimeOptions(["--open-pr-on-override"]).openPrOnOverride,
    ).toBe(true);
    expect(parsePipelineRuntimeOptions([]).openPrOnOverride).toBe(false);
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
    ["--max-agent-duration-ms", "0"],
    ["--max-agent-duration-ms", "1.5"],
  ])("rejects invalid %s", (flag, value) => {
    expect(() => parsePipelineRuntimeOptions([flag, value])).toThrow(flag);
  });

  it("rejects a runtime flag with no value", () => {
    expect(() => parsePipelineRuntimeOptions(["--command-timeout-ms"]))
      .toThrow(/requires a value/);
  });
});


/**
 * --force-restart (#37): operator override that forces named slices to
 * restart from base regardless of resume eligibility. Repeatable and
 * comma-separated; values are slice numbers or GH issue ids.
 */
describe("parsePipelineRuntimeOptions --force-restart", () => {
  it("is undefined when the flag is absent", () => {
    expect(parsePipelineRuntimeOptions([]).forceRestart).toBeUndefined();
  });

  it("parses a single slice", () => {
    expect(
      parsePipelineRuntimeOptions(["--force-restart", "05"]).forceRestart,
    ).toEqual(["05"]);
  });

  it("parses a comma-separated list, trimming whitespace", () => {
    expect(
      parsePipelineRuntimeOptions(["--force-restart", "05, 4001"]).forceRestart,
    ).toEqual(["05", "4001"]);
  });

  it("is repeatable — occurrences accumulate", () => {
    expect(
      parsePipelineRuntimeOptions([
        "--force-restart", "05",
        "--force-restart", "07",
      ]).forceRestart,
    ).toEqual(["05", "07"]);
  });

  it.each(["", "05,", "abc", "05 07"])(
    "rejects invalid value %j",
    (value) => {
      expect(() =>
        parsePipelineRuntimeOptions(["--force-restart", value]),
      ).toThrow(/--force-restart/);
    },
  );

  it("rejects a missing value", () => {
    expect(() => parsePipelineRuntimeOptions(["--force-restart"])).toThrow(
      /--force-restart/,
    );
  });
});
