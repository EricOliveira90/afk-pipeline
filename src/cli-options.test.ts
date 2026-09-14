import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CONTRACT_ROUNDS,
  parseMaxContractRounds,
  parseSliceSelection,
  parsePipelineRuntimeOptions,
  parseStaleRenegotiationRequest,
} from "./cli-options.js";

describe("parseMaxContractRounds", () => {
  it("defaults at the call site to two rounds", () => {
    expect(DEFAULT_MAX_CONTRACT_ROUNDS).toBe(2);
  });

  it("accepts the supported normal range", () => {
    expect(parseMaxContractRounds("1")).toBe(1);
    expect(parseMaxContractRounds("2")).toBe(2);
  });

  it("rejects unsupported values instead of silently clamping them", () => {
    expect(() => parseMaxContractRounds("3")).toThrow(/supports 1-2/);
    expect(() => parseMaxContractRounds("4")).toThrow(/supports 1-2/);
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

  it("parses the generator's verification command override", () => {
    expect(
      parsePipelineRuntimeOptions(["--test-command", "pnpm test:fast"]),
    ).toMatchObject({ testCommand: "pnpm test:fast" });
  });

  it("leaves the test command undefined so the package script is resolved", () => {
    expect(parsePipelineRuntimeOptions([]).testCommand).toBeUndefined();
  });

  it("rejects a whitespace-only test command", () => {
    expect(() => parsePipelineRuntimeOptions(["--test-command", "   "]))
      .toThrow(/--test-command requires a non-empty command/);
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

  it("parses the preflight disk floor, allowing decimals and 0 to disable (ADR 0042)", () => {
    expect(
      parsePipelineRuntimeOptions(["--min-free-disk-gb", "12"]).minFreeDiskGb,
    ).toBe(12);
    expect(
      parsePipelineRuntimeOptions(["--min-free-disk-gb", "0.5"]).minFreeDiskGb,
    ).toBe(0.5);
    expect(
      parsePipelineRuntimeOptions(["--min-free-disk-gb", "0"]).minFreeDiskGb,
    ).toBe(0);
    // Absent leaves the default to DEFAULT_MIN_FREE_DISK_GB at the call site.
    expect(parsePipelineRuntimeOptions([]).minFreeDiskGb).toBeUndefined();
  });

  it.each(["-1", "abc", "5gb", ""])(
    "rejects %s as a disk floor",
    (value) => {
      expect(() =>
        parsePipelineRuntimeOptions(["--min-free-disk-gb", value]),
      ).toThrow(/--min-free-disk-gb/);
    },
  );

  it("keeps the preflight refusal in force unless it is explicitly waived", () => {
    expect(parsePipelineRuntimeOptions([]).preflightReportOnly).toBe(false);
    expect(
      parsePipelineRuntimeOptions(["--preflight-report-only"])
        .preflightReportOnly,
    ).toBe(true);
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

  it("B-01 records prompts only for the exact --record-prompts token", () => {
    expect(
      parsePipelineRuntimeOptions(["--record-prompts"]).recordPrompts,
    ).toBe(true);
    // Absent leaves the field unset rather than false: only a run that asked
    // for the recorder carries the field at all.
    expect(parsePipelineRuntimeOptions([]).recordPrompts).toBeUndefined();
    // Near misses are silently not the flag — exact membership, no value
    // form, and no boolean flag here rejects anything either.
    expect(
      parsePipelineRuntimeOptions(["--record-prompt"]).recordPrompts,
    ).toBeUndefined();
    expect(
      parsePipelineRuntimeOptions(["--record-prompts=false"]).recordPrompts,
    ).toBeUndefined();
    expect(
      parsePipelineRuntimeOptions(["--record-prompts=true"]).recordPrompts,
    ).toBeUndefined();
  });

  it("reads the guardian round cap, allowing 0 to disable it and leaving it absent by default", () => {
    expect(
      parsePipelineRuntimeOptions(["--guardian-round-cap", "5"])
        .guardianRoundCap,
    ).toBe(5);
    // 0 is a real choice — the unbounded pre-ADR-0057 loop — not a typo.
    expect(
      parsePipelineRuntimeOptions(["--guardian-round-cap", "0"])
        .guardianRoundCap,
    ).toBe(0);
    // Absent means the ship gate applies DEFAULT_GUARDIAN_ROUND_CAP.
    expect(parsePipelineRuntimeOptions([]).guardianRoundCap).toBeUndefined();
    expect(() =>
      parsePipelineRuntimeOptions(["--guardian-round-cap", "-1"]),
    ).toThrow(/--guardian-round-cap must be a non-negative integer/);
    expect(() =>
      parsePipelineRuntimeOptions(["--guardian-round-cap", "three"]),
    ).toThrow(/--guardian-round-cap must be a non-negative integer/);
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

/**
 * --resume-stuck (#49): operator opt-in that grants named STUCK slices
 * one more implementation/QA attempt on their preserved tree instead of
 * the default restart from base. Same selector vocabulary as
 * --force-restart, and mutually exclusive with it per slice.
 */
describe("parsePipelineRuntimeOptions --resume-stuck", () => {
  it("is undefined when the flag is absent", () => {
    expect(parsePipelineRuntimeOptions([]).resumeStuck).toBeUndefined();
  });

  it("parses a single slice", () => {
    expect(
      parsePipelineRuntimeOptions(["--resume-stuck", "20"]).resumeStuck,
    ).toEqual(["20"]);
  });

  it("parses a comma-separated list, trimming whitespace", () => {
    expect(
      parsePipelineRuntimeOptions(["--resume-stuck", "20, 49"]).resumeStuck,
    ).toEqual(["20", "49"]);
  });

  it("is repeatable — occurrences accumulate", () => {
    expect(
      parsePipelineRuntimeOptions([
        "--resume-stuck", "20",
        "--resume-stuck", "49",
      ]).resumeStuck,
    ).toEqual(["20", "49"]);
  });

  it.each(["", "20,", "abc", "20 49"])("rejects invalid value %j", (value) => {
    expect(() => parsePipelineRuntimeOptions(["--resume-stuck", value])).toThrow(
      /--resume-stuck/,
    );
  });

  it("rejects a missing value", () => {
    expect(() => parsePipelineRuntimeOptions(["--resume-stuck"])).toThrow(
      /--resume-stuck/,
    );
  });

  it("coexists with --force-restart on DIFFERENT slices", () => {
    const opts = parsePipelineRuntimeOptions([
      "--force-restart", "07",
      "--resume-stuck", "20",
    ]);
    expect(opts.forceRestart).toEqual(["07"]);
    expect(opts.resumeStuck).toEqual(["20"]);
  });

  it("rejects the same slice named in both flags — contradictory instructions", () => {
    expect(() =>
      parsePipelineRuntimeOptions([
        "--force-restart", "20",
        "--resume-stuck", "20",
      ]),
    ).toThrow(/both name 20/);
  });

  it("catches the contradiction across zero padding too", () => {
    expect(() =>
      parsePipelineRuntimeOptions([
        "--force-restart", "05",
        "--resume-stuck", "5",
      ]),
    ).toThrow(/both name 05/);
  });
});

/**
 * The preserved-work recovery flags (#277).
 *
 * The accepted case is asserted on `parseStaleRenegotiationRequest` and the
 * refusal on `parsePipelineRuntimeOptions`, because the parser throws the #335
 * guard for every well-formed pair: exactly one function has an accepted return,
 * exactly one has the refusal, and #335's change is deleting the guard.
 */
describe("preserved-work recovery flags", () => {
  const WELL_FORMED = [
    "--renegotiate-stale", "12",
    "--recovery-reason", " stale lock ",
  ];

  it("[behavior:#277:B-01] returns a request carrying the single selector and the trimmed reason", () => {
    expect(parseStaleRenegotiationRequest(WELL_FORMED)).toEqual({
      selector: "12",
      reason: "stale lock",
    });
  });

  it("[behavior:#277:B-01] trims only — interior spacing, case and code points survive", () => {
    const reason = "\t Contract  MISSED the Ünicode café  \n";
    const request = parseStaleRenegotiationRequest([
      "--renegotiate-stale", "277",
      "--recovery-reason", reason,
    ]);

    expect(request?.reason).toBe(reason.trim());
    // Code-point equality, not just string equality: a normalization pass would
    // survive `toBe` on a composed source but change the code points.
    expect([...(request?.reason ?? "")].map((c) => c.codePointAt(0))).toEqual(
      [...reason.trim()].map((c) => c.codePointAt(0)),
    );
  });

  it("[behavior:#277:B-01] accepts a GH issue id as the selector", () => {
    expect(
      parseStaleRenegotiationRequest([
        "--renegotiate-stale", "277",
        "--recovery-reason", "stale",
      ])?.selector,
    ).toBe("277");
  });

  it("[behavior:#277:B-02] returns undefined when neither flag is present", () => {
    expect(parseStaleRenegotiationRequest([])).toBeUndefined();
    expect(
      parseStaleRenegotiationRequest(["--serial-lanes", "--force-restart", "7"]),
    ).toBeUndefined();
  });

  // One row per distinguishable operator mistake. Every message is asserted
  // distinct below, so a refusal can never be mistaken for a different one.
  const REFUSALS = [
    {
      label: "B-01 comma-separated selector list",
      args: ["--renegotiate-stale", "12,13", "--recovery-reason", "stale"],
      pattern: /not a comma-separated list/,
    },
    {
      label: "B-01 duplicated selector inside one value",
      args: ["--renegotiate-stale", "12,12", "--recovery-reason", "stale"],
      pattern: /names 12 more than once/,
    },
    {
      label: "B-01 second occurrence of --renegotiate-stale",
      args: [
        "--renegotiate-stale", "12",
        "--renegotiate-stale", "13",
        "--recovery-reason", "stale",
      ],
      pattern: /--renegotiate-stale was supplied more than once/,
    },
    {
      label: "B-02 missing --recovery-reason",
      args: ["--renegotiate-stale", "12"],
      pattern: /--renegotiate-stale requires --recovery-reason/,
    },
    {
      label: "B-02 blank --recovery-reason",
      args: ["--renegotiate-stale", "12", "--recovery-reason", "   "],
      pattern: /requires non-blank text/,
    },
    {
      label: "B-02 repeated --recovery-reason",
      args: [
        "--renegotiate-stale", "12",
        "--recovery-reason", "one",
        "--recovery-reason", "two",
      ],
      pattern: /--recovery-reason was supplied more than once/,
    },
    {
      label: "B-02 --recovery-reason without --renegotiate-stale",
      args: ["--recovery-reason", "stale"],
      pattern: /--recovery-reason requires --renegotiate-stale/,
    },
  ] as const;

  it.each(REFUSALS)(
    "[behavior:#277:B-01] [behavior:#277:B-02] refuses $label on the shared parser and the helper alike",
    ({ args, pattern }) => {
      expect(() => parsePipelineRuntimeOptions(args)).toThrow(pattern);
      expect(() => parseStaleRenegotiationRequest(args)).toThrow(pattern);
    },
  );

  it("[behavior:#277:B-02] gives every refusal its own message — no two are equal", () => {
    const messages = REFUSALS.map(({ args }) => {
      try {
        parseStaleRenegotiationRequest(args);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error(`${args.join(" ")} was not refused`);
    });

    expect(new Set(messages).size).toBe(REFUSALS.length);
  });

  it("[behavior:#277:B-12] throws a refusal naming #335 for the same input B-01 accepts", () => {
    expect(parseStaleRenegotiationRequest(WELL_FORMED)).toBeDefined();
    expect(() => parsePipelineRuntimeOptions(WELL_FORMED)).toThrow(/#335/);
  });

  it("[behavior:#277:B-12] refuses before it could reach eligibility, a snapshot or the lock", () => {
    expect(() => parsePipelineRuntimeOptions(WELL_FORMED)).toThrow(
      /No eligibility check, snapshot or run-state lock is attempted/,
    );
  });

  it("[behavior:#277:P-02] leaves both new members undefined and raises nothing for a flagless list", () => {
    const flagless = [
      "--command-timeout-ms", "900000",
      "--serial-lanes",
      "--preview-verify-command", "pnpm verify",
      "--preview-apply-command", "pnpm apply",
    ];

    const options = parsePipelineRuntimeOptions(flagless);

    // The expected value is written out independently of the call's result, so
    // deleting either new member — or adding an unrelated one — turns this red.
    // `toStrictEqual` distinguishes a present-but-`undefined` member from an
    // absent one, which is the whole point of P-02: the shape a flagless run
    // carries gained two keys and nothing else.
    expect(options).toStrictEqual({
      commandTimeoutMs: 900000,
      heartbeatIntervalMs: undefined,
      infrastructureRetries: undefined,
      transientRetryWindowMs: undefined,
      maxAgentDurationMs: undefined,
      testCommand: undefined,
      minFreeDiskGb: undefined,
      preflightReportOnly: false,
      serialLanes: true,
      openPrOnOverride: false,
      recordPrompts: undefined,
      guardianRoundCap: undefined,
      forceRestart: undefined,
      resumeStuck: undefined,
      renegotiateStale: undefined,
      recoveryReason: undefined,
      sharedPreview: {
        verifyMigrationCommand: "pnpm verify",
        applyMigrationCommand: "pnpm apply",
        lockPath: undefined,
      },
    });
    // Key-level pin as well as value-level: `toStrictEqual` would accept a
    // renamed member if both literals were derived from the same source, and an
    // explicit list says out loud which keys a flagless launch carries.
    expect(Object.keys(options).sort()).toEqual(
      [
        "commandTimeoutMs",
        "heartbeatIntervalMs",
        "infrastructureRetries",
        "transientRetryWindowMs",
        "maxAgentDurationMs",
        "testCommand",
        "minFreeDiskGb",
        "preflightReportOnly",
        "serialLanes",
        "openPrOnOverride",
        "recordPrompts",
        "guardianRoundCap",
        "forceRestart",
        "resumeStuck",
        "renegotiateStale",
        "recoveryReason",
        "sharedPreview",
      ].sort(),
    );
    expect("renegotiateStale" in options).toBe(true);
    expect("recoveryReason" in options).toBe(true);
  });

  it("[behavior:#277:P-02] runs no eligibility, snapshot or lock code on a flagless list", () => {
    // The recovery seams cannot record a call from here because the parser
    // cannot reach them: `src/cli-options.ts` imports the recovery module not at
    // all, so a flagless launch runs exactly today's code.
    const source = readFileSync(new URL("./cli-options.ts", import.meta.url), "utf8");
    // Comments name the modules the parser must not reach (that is the point of
    // the note above the flags), so prose is stripped before the code is read.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    expect(code).toContain("parseStaleRenegotiationRequest");
    expect(code).not.toMatch(
      /preserve-work-recovery|\.\/git\.js|\.\/run-state\.js|\.\/file-lock\.js/,
    );
  });

  it("[behavior:#277:P-01] keeps optionValue's and the paired preview-command messages intact", () => {
    expect(() => parsePipelineRuntimeOptions(["--test-command"])).toThrow(
      "--test-command requires a value",
    );
    expect(() =>
      parsePipelineRuntimeOptions(["--preview-verify-command", "pnpm verify"]),
    ).toThrow(
      "--preview-verify-command and --preview-apply-command must be provided together",
    );
    // The new flags reuse the same single-token discipline rather than a second
    // "requires a value" dialect.
    expect(() => parsePipelineRuntimeOptions(["--renegotiate-stale"])).toThrow(
      "--renegotiate-stale requires a value",
    );
  });
});
