import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CONTRACT_ROUNDS,
  parseMaxContractRounds,
  parseSliceSelection,
  parsePipelineRuntimeOptions,
  parseStaleRenegotiationRequest,
  parseScopeExtensionSelectors,
  type PipelineRuntimeOptions,
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
      // #278 B-01 added a third: same rule, present and `undefined` on a run
      // that named no additions.
      extendScope: undefined,
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
        "extendScope",
        "sharedPreview",
      ].sort(),
    );
    expect("renegotiateStale" in options).toBe(true);
    expect("recoveryReason" in options).toBe(true);
    expect("extendScope" in options).toBe(true);
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

/**
 * The scope-extension flag (#278 B-01).
 *
 * Split the same way #277's flags are, and for the same reason: the accepted
 * case is asserted on `parseScopeExtensionSelectors`, because
 * `parsePipelineRuntimeOptions` still throws #277's #335 guard for every
 * well-formed recovery request the additions could ride on. The refusals are
 * asserted on both, so a mistake about the flag is reportable today.
 */
describe("scope extension flag", () => {
  const RENEGOTIATION = [
    "--renegotiate-stale", "277",
    "--recovery-reason", "the accepted pair went stale",
  ];

  it("[behavior:#278:B-01] returns the comma-separated selectors as typed, in order", () => {
    expect(
      parseScopeExtensionSelectors([...RENEGOTIATION, "--extend-scope", "03,278"]),
    ).toEqual(["03", "278"]);
  });

  it("[behavior:#278:B-01] preserves zero padding and accepts a bare GH issue id", () => {
    // Digits-only is the whole language, so one accepted part can be a canonical
    // slice number and the next a GH issue id: which is which is not decidable
    // here, and nothing here decides it.
    expect(
      parseScopeExtensionSelectors([
        ...RENEGOTIATION,
        "--extend-scope", " 007 , 4001 ",
      ]),
    ).toEqual(["007", "4001"]);
  });

  it("[behavior:#278:B-01] returns undefined when the flag is absent", () => {
    expect(parseScopeExtensionSelectors([])).toBeUndefined();
    expect(parseScopeExtensionSelectors(RENEGOTIATION)).toBeUndefined();
    expect(
      parseScopeExtensionSelectors(["--serial-lanes", "--force-restart", "7"]),
    ).toBeUndefined();
  });

  // One row per distinguishable operator mistake, all six asserted distinct
  // below so no refusal can be mistaken for another.
  //
  // `shared` is what `parsePipelineRuntimeOptions` throws for the same argv,
  // which is not always `pattern`: an argv missing one of #277's two flags is
  // already refused by `parseStaleRenegotiationRequest`, which runs first and
  // whose messages P-01 keeps intact. So the two paired-presence rows are only
  // observable on the exported helper — the pattern the operator sees through
  // the shared parser names the flag they actually left out.
  const REFUSALS = [
    {
      label: "the flag without --renegotiate-stale",
      args: ["--extend-scope", "03", "--recovery-reason", "stale"],
      pattern: /--extend-scope requires --renegotiate-stale/,
      shared: /--recovery-reason requires --renegotiate-stale/,
    },
    {
      label: "the flag without --recovery-reason",
      args: ["--renegotiate-stale", "277", "--extend-scope", "03"],
      pattern: /--extend-scope requires --recovery-reason/,
      shared: /--renegotiate-stale requires --recovery-reason/,
    },
    {
      label: "a second occurrence of --extend-scope",
      args: [...RENEGOTIATION, "--extend-scope", "03", "--extend-scope", "04"],
      pattern: /--extend-scope was supplied more than once/,
      shared: /--extend-scope was supplied more than once/,
    },
    {
      label: "a missing value",
      args: [...RENEGOTIATION, "--extend-scope"],
      pattern: /--extend-scope requires a value/,
      shared: /--extend-scope requires a value/,
    },
    {
      label: "a value that is the next flag",
      args: ["--extend-scope", "--serial-lanes"],
      pattern: /--extend-scope requires a value/,
      shared: /--extend-scope requires a value/,
    },
    {
      label: "a part that is not digits-only",
      args: [...RENEGOTIATION, "--extend-scope", "03,#278"],
      pattern: /--extend-scope must be a comma-separated list/,
      shared: /--extend-scope must be a comma-separated list/,
    },
    {
      label: "a literal duplicate selector",
      args: [...RENEGOTIATION, "--extend-scope", "03,03"],
      pattern: /--extend-scope names 03 more than once/,
      shared: /--extend-scope names 03 more than once/,
    },
  ] as const;

  it.each(REFUSALS)(
    "[behavior:#278:B-01] refuses $label on the exported parser, and the shared parser refuses the same argv",
    ({ args, pattern, shared }) => {
      expect(() => parseScopeExtensionSelectors(args)).toThrow(pattern);
      // Never accepted anywhere: the shared parser refuses the same argv, with
      // the flag's own message wherever #277's pair is well-formed enough to
      // reach it (the additions are validated before #277's #335 guard).
      expect(() => parsePipelineRuntimeOptions(args)).toThrow(shared);
    },
  );

  it("[behavior:#278:B-01] gives every refusal its own message — no two are equal", () => {
    const messages = REFUSALS.map(({ args }) => {
      try {
        parseScopeExtensionSelectors(args);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error(`${args.join(" ")} was not refused`);
    });

    // Six distinguishable causes; the two "requires a value" rows are the same
    // cause reached two ways, which is why five distinct messages cover seven rows.
    expect(new Set(messages).size).toBe(6);
  });

  it.each(["#278", "278a", "2 78", "", "abc", "-3", "3.0", "0x3"])(
    "[behavior:#278:B-01] refuses %j rather than normalizing it",
    (selector) => {
      expect(() =>
        parseScopeExtensionSelectors([
          ...RENEGOTIATION,
          "--extend-scope", `03,${selector}`,
        ]),
      ).toThrow(/must be a comma-separated list of slice numbers or GH issue ids/);
    },
  );

  it("[behavior:#278:B-01] carries the accepted selectors on the run's option shape", () => {
    // The member is read out before the guard, so the field the run carries is
    // already the shape it will have when #277's guard goes. Reading it back
    // through the shared parser is impossible while that guard throws, so the
    // type-level fact is pinned instead.
    const extendScope: PipelineRuntimeOptions["extendScope"] =
      parseScopeExtensionSelectors([...RENEGOTIATION, "--extend-scope", "03,278"]);

    expect(extendScope).toEqual(["03", "278"]);
    const source = readFileSync(new URL("./cli-options.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("export function parsePipelineRuntimeOptions("));
    // Before the guard, not after: a later call would make every refusal above
    // unreachable through the shared parser.
    expect(body.indexOf("parseScopeExtensionSelectors(args)")).toBeLessThan(
      body.indexOf("is refused until #335 lands"),
    );
    expect(body).toContain("extendScope,");
  });

  it("[behavior:#278:P-01] still throws #277's refusal naming #335 for a well-formed request carrying additions", () => {
    const args = [...RENEGOTIATION, "--extend-scope", "03,278"];

    expect(parseScopeExtensionSelectors(args)).toEqual(["03", "278"]);
    expect(parseStaleRenegotiationRequest(args)).toEqual({
      selector: "277",
      reason: "the accepted pair went stale",
    });
    expect(() => parsePipelineRuntimeOptions(args)).toThrow(/#335/);
    expect(() => parsePipelineRuntimeOptions(args)).toThrow(
      /No eligibility check, snapshot or run-state lock is attempted/,
    );
  });

  it("[behavior:#278:P-01] leaves #277's own messages untouched when additions are present", () => {
    // Adding the rider changes none of the pair's refusals: each one still comes
    // from `parseStaleRenegotiationRequest` with the message #277 shipped.
    expect(() =>
      parseStaleRenegotiationRequest([
        "--renegotiate-stale", "12,13",
        "--recovery-reason", "stale",
        "--extend-scope", "03",
      ]),
    ).toThrow(/--renegotiate-stale takes one slice number or GH issue id, not a comma-separated list/);
    expect(() =>
      parseStaleRenegotiationRequest([
        "--recovery-reason", "stale",
        "--extend-scope", "03",
      ]),
    ).toThrow(/--recovery-reason requires --renegotiate-stale/);
    expect(() =>
      parsePipelineRuntimeOptions([
        "--renegotiate-stale", "277",
        "--recovery-reason", "   ",
        "--extend-scope", "03",
      ]),
    ).toThrow(/requires non-blank text/);
  });

  it("[behavior:#278:P-01] reads no run state, git or recovery module to validate the flag", () => {
    const source = readFileSync(new URL("./cli-options.ts", import.meta.url), "utf8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    expect(code).toContain("parseScopeExtensionSelectors");
    expect(code).not.toMatch(
      /preserve-work-recovery|\.\/git\.js|\.\/run-state\.js|\.\/file-lock\.js|issues-parser/,
    );
  });
});