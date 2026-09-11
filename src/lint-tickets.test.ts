/**
 * Unit tests for the pre-AFK ticket lint's decisions.
 *
 * The lint itself is a script (`scripts/lint-tickets.mjs`) so it can run on
 * bare node before a PRD enters AFK, and it never touches the pipeline
 * runtime — so per AGENTS.md every assertion here is a unit test against
 * fixture ticket text. Nothing in this file spawns anything.
 *
 * The fixtures are deliberately shaped like the real defects: #77's "every
 * review attempt is archived" (archived where? — the ambiguity that became
 * #123) and #78's HELD state that no schema had.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyWaivers,
  checkAbsentNames,
  checkMixedImpasseOutcome,
  checkRecordingChannel,
  checkSummarisedLists,
  checkUnknownNames,
  identifiersIn,
  lintTicket,
  looksLikePath,
  outcomeFilesUnder,
  parseArgv,
  parseTicket,
  relevantUnusedWaivers,
  waiverCovers,
} from "../scripts/lint-tickets.mjs";

const read = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf-8"));

const VOCABULARY = read("ticket-lint-vocabulary.json");
const WAIVERS = read("ticket-lint-waivers.json");

/** A minimal vocabulary, so a check's decision is readable from its fixture. */
const vocabulary = {
  names: ["contract-review.json", "CONTESTED", "clearCondition"],
  prose: ["PRD", "QA"],
  placeholderPattern: "^[A-Za-z]\\d{1,3}$",
  absentNames: [
    {
      name: "held",
      note: "There is no HELD state.",
      recordedIn: "#78",
    },
    {
      name: "GAPS",
      caseSensitive: true,
      note: "The marker left the negotiate stage.",
      recordedIn: "#77",
    },
  ],
  channels: ["run.log", "run summary", "gate evidence"],
  recordingVerbs: ["recorded", "archived", "log", "reports"],
  recordingPhrases: ["preserved as evidence"],
  summaryPhrases: ["etc.", "such as"],
};

const ticket = (body: string, number = 1, title = "PRD9-S1: A slice") => ({
  number,
  title,
  body,
});

const criteriaTicket = (...criteria: string[]) =>
  ticket(
    ["## What to build", "", "Something.", "", "## Acceptance criteria", "", ...criteria.map((c) => `- [ ] ${c}`)].join(
      "\n",
    ),
  );

describe("parseTicket", () => {
  it("separates the acceptance criteria from the prose that may define names", () => {
    const { criteria, other } = parseTicket(
      [
        "## What to build",
        "",
        "The generator writes `escalation.md`.",
        "",
        "## Acceptance criteria",
        "",
        "- [ ] A malformed `escalation.md` fails closed.",
        "- [x] A second one, already ticked.",
        "",
        "## Blocked by",
        "",
        "- #81",
      ].join("\n"),
    );
    expect(criteria).toEqual([
      { number: 1, text: "A malformed `escalation.md` fails closed." },
      { number: 2, text: "A second one, already ticked." },
    ]);
    expect(other).toContain("The generator writes `escalation.md`.");
    expect(other).toContain("- #81");
    expect(other).not.toContain("fails closed");
  });

  it("keeps a wrapped criterion with the criterion it belongs to", () => {
    const { criteria } = parseTicket(
      ["## Acceptance criteria", "", "- [ ] A long criterion", "  that wrapped onto a second line."].join("\n"),
    );
    expect(criteria).toEqual([
      { number: 1, text: "A long criterion that wrapped onto a second line." },
    ]);
  });

  it("has no criteria when the ticket has no such section", () => {
    expect(parseTicket("## What to build\n\nProse only.").criteria).toEqual([]);
  });
});

describe("identifiersIn", () => {
  it("takes backticked single words, filenames and SCREAMING_CASE", () => {
    expect(
      identifiersIn("A `withdrawn` field in contract-review.json leaves it CONTESTED."),
    ).toEqual(["withdrawn", "contract-review.json", "CONTESTED"]);
  });

  it("ignores a backticked phrase — that is a quotation, not a name", () => {
    expect(identifiersIn("The command `pnpm test:fast` passes.")).toEqual([]);
  });

  it("ignores a token with no letter in it", () => {
    // `[1]` in a type-validation criterion used to arrive as the name "1]".
    expect(identifiersIn("a non-string element in `behaviorIds` (e.g. `[1]`)")).toEqual([
      "behaviorIds",
    ]);
  });

  it("does not mistake a single capital word for a name", () => {
    expect(identifiersIn("The generator writes a file.")).toEqual([]);
  });

  it("keeps a path template intact, separators and placeholders and all", () => {
    expect(identifiersIn("archived under `.afk/artifacts/<run-slug>/slice-<n>/`.")).toEqual([
      ".afk/artifacts/<run-slug>/slice-<n>/",
    ]);
  });
});

describe("looksLikePath", () => {
  it("is true for a separator or a placeholder segment, false for a name", () => {
    expect(looksLikePath(".afk/artifacts/<run-slug>/slice-<n>/")).toBe(true);
    expect(looksLikePath("docs\\adr")).toBe(true);
    expect(looksLikePath("slice-<n>")).toBe(true);
    expect(looksLikePath("contract-review.json")).toBe(false);
    expect(looksLikePath("CONTESTED")).toBe(false);
  });
});

describe("check 2a — a criterion names something no reader can look up", () => {
  it("gates on a name that is in neither the vocabulary nor the ticket", () => {
    const findings = checkUnknownNames(
      criteriaTicket("The slice writes `adjudication-v2.json` before it parks."),
      vocabulary,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      check: "2a",
      severity: "gate",
      where: "criterion 1",
      token: "adjudication-v2.json",
    });
  });

  it("is silent when the ticket's own prose introduces the name", () => {
    const introduced = ticket(
      [
        "## What to build",
        "",
        "The generator writes a schema-validated `escalation.md` and stops.",
        "",
        "## Acceptance criteria",
        "",
        "- [ ] A malformed `escalation.md` fails closed.",
      ].join("\n"),
    );
    expect(checkUnknownNames(introduced, vocabulary)).toEqual([]);
  });

  it("is silent for a path, which no vocabulary of names could declare", () => {
    // `.afk/artifacts/<run-slug>/slice-<n>/` is run-specific by construction.
    expect(
      checkUnknownNames(
        criteriaTicket("The attempt is archived under `.afk/artifacts/<run-slug>/slice-<n>/`."),
        vocabulary,
      ),
    ).toEqual([]);
  });

  it("is silent for a declared name, a prose acronym and a placeholder ID", () => {
    const findings = checkUnknownNames(
      criteriaTicket("A PRD 1 finding `F1` in contract-review.json stays CONTESTED."),
      vocabulary,
    );
    expect(findings).toEqual([]);
  });
});

describe("check 2b — a criterion names something recorded as not existing", () => {
  it("gates on a criterion naming the state that does not exist", () => {
    const findings = checkAbsentNames(
      criteriaTicket("Exhaustion with a held CONTESTED finding parks the slice."),
      vocabulary,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "2b", severity: "gate", token: "held" });
    expect(findings[0]?.message).toContain("recorded in #78");
  });

  it("only warns when the name is in the prose rather than a criterion", () => {
    // The criteria are what gets locked, so only they can stop a ticket.
    const findings = checkAbsentNames(
      ticket("## What to build\n\nA held finding.\n\n## Acceptance criteria\n\n- [ ] It parks."),
      vocabulary,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "warn", where: "ticket prose" });
  });

  it("does not fire a capitals-only marker on the English word", () => {
    // "PM out-of-scope gaps are recorded" is not the retired `GAPS:` marker.
    expect(
      checkAbsentNames(criteriaTicket("PM out-of-scope gaps are recorded."), vocabulary),
    ).toEqual([]);
    expect(
      checkAbsentNames(criteriaTicket("No `GAPS:` parsing remains."), vocabulary),
    ).toHaveLength(1);
  });
});

describe("check 3 — a recording obligation with no channel", () => {
  it("gates on the shape that cost #123", () => {
    const findings = checkRecordingChannel(
      criteriaTicket("Every review attempt is archived; later attempts never overwrite earlier ones."),
      vocabulary,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "3", severity: "gate", token: "archived" });
  });

  it("is satisfied by a declared channel", () => {
    expect(
      checkRecordingChannel(
        criteriaTicket("Remaining resume attempts are recorded in run.log at dispatch."),
        vocabulary,
      ),
    ).toEqual([]);
    expect(
      checkRecordingChannel(
        criteriaTicket("Cache reuse is recorded in gate evidence."),
        vocabulary,
      ),
    ).toEqual([]);
  });

  it("is satisfied by a directory path, because a path is a destination", () => {
    expect(
      checkRecordingChannel(
        criteriaTicket(
          "Escalation artifacts are archived per attempt under `.afk/artifacts/<run-slug>/slice-<n>/`.",
        ),
        vocabulary,
      ),
    ).toEqual([]);
  });

  it("is satisfied by a named artifact file, which needs no vocabulary entry", () => {
    expect(
      checkRecordingChannel(
        criteriaTicket("The violation is recorded in `contract-review.json`."),
        vocabulary,
      ),
    ).toEqual([]);
  });

  it("accepts a base-gate variant of a channel phrase", () => {
    expect(
      checkRecordingChannel(
        criteriaTicket("Results are recorded consistently with base-gate evidence."),
        vocabulary,
      ),
    ).toEqual([]);
  });

  it("does not read a recording verb out of somebody else's compound noun", () => {
    // "a commit-log data block" obliges nobody to log anything.
    expect(
      checkRecordingChannel(
        criteriaTicket("A resumed round is the repair template plus a commit-log data block."),
        vocabulary,
      ),
    ).toEqual([]);
  });

  it("catches the phrase form as well as the verb form", () => {
    const findings = checkRecordingChannel(
      criteriaTicket("The attempted change is preserved as evidence."),
      vocabulary,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.token).toBe("preserved as evidence");
  });

  it("reports one finding per criterion, not one per verb", () => {
    expect(
      checkRecordingChannel(
        criteriaTicket("The violation is recorded and the attempt archived."),
        vocabulary,
      ),
    ).toHaveLength(1);
  });
});

describe("check 4 — summarised field lists", () => {
  it("warns and never gates", () => {
    const findings = checkSummarisedLists(
      criteriaTicket("The artifact carries the finding, both positions, etc."),
      vocabulary,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "4", severity: "warn" });
  });

  it("finds the phrase in the prose too, since the planner reads that as well", () => {
    const findings = checkSummarisedLists(
      ticket("## What to build\n\nGates such as typecheck.\n\n## Acceptance criteria\n\n- [ ] It runs."),
      vocabulary,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].where).toBe("ticket prose");
  });
});

describe("check 5 — a mixed IMPASSE outcome file", () => {
  const finding = (
    id: string,
    state: string,
    over: Record<string, unknown> = {},
  ) => ({
    id,
    severity: "BLOCKING",
    state,
    unresolved: true,
    plannerPosition: null,
    plannerEvidence: null,
    evaluatorEvidence: "…",
    ...over,
  });

  const outcome = (
    classification: string,
    findings: ReturnType<typeof finding>[],
  ) => ({ version: 1, classification, round: 2, attempt: 3, findings });

  it("gates on CONTESTED beside an unresolved OPEN blocker, naming both sets", () => {
    const findings = checkMixedImpasseOutcome(
      outcome("IMPASSE", [
        finding("F1", "CONTESTED"),
        finding("F2", "OPEN"),
        finding("F3", "CONTESTED"),
      ]),
      ".afk/slice-04/contract-negotiation-outcome.json",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      check: "5",
      severity: "gate",
      issue: null,
      source: ".afk/slice-04/contract-negotiation-outcome.json",
    });
    // Both sets, named — the operator has to see which findings are which.
    expect(findings[0]?.message).toContain("CONTESTED [F1], [F3]");
    expect(findings[0]?.message).toContain("OPEN blocker [F2]");
    // And the consequence, stated rather than implied.
    expect(findings[0]?.message).toContain("parks permanently");
  });

  it("is silent on an outcome with only contested findings", () => {
    // The adjudicable case the park exists for.
    expect(
      checkMixedImpasseOutcome(
        outcome("IMPASSE", [finding("F1", "CONTESTED"), finding("F2", "CONTESTED")]),
        "x.json",
      ),
    ).toEqual([]);
  });

  it("is silent on an outcome with only open blockers", () => {
    expect(
      checkMixedImpasseOutcome(
        outcome("IMPASSE", [finding("F1", "OPEN"), finding("F2", "OPEN")]),
        "x.json",
      ),
    ).toEqual([]);
  });

  it("is silent on NON_CONVERGENCE, which is what the runtime writes for a mix", () => {
    // ADR 0055 §1 routes a mixed exhaustion here on purpose; that file is
    // correct and must not be flagged.
    expect(
      checkMixedImpasseOutcome(
        outcome("NON_CONVERGENCE", [
          finding("F1", "CONTESTED"),
          finding("F2", "OPEN"),
        ]),
        "x.json",
      ),
    ).toEqual([]);
  });

  it("ignores an OPEN finding that never held the lock open", () => {
    // Matches the runtime completion predicate: only an unresolved BLOCKING
    // finding sits in `unresolvedBlockingFindingIds`.
    const advisory = checkMixedImpasseOutcome(
      outcome("IMPASSE", [
        finding("F1", "CONTESTED"),
        finding("F2", "OPEN", { severity: "ADVISORY" }),
      ]),
      "x.json",
    );
    const resolved = checkMixedImpasseOutcome(
      outcome("IMPASSE", [
        finding("F1", "CONTESTED"),
        finding("F2", "OPEN", { unresolved: false }),
      ]),
      "x.json",
    );
    expect(advisory).toEqual([]);
    expect(resolved).toEqual([]);
  });

  it("names where in the file the defect is, not just that it exists", () => {
    const findings = checkMixedImpasseOutcome(
      outcome("IMPASSE", [finding("F1", "CONTESTED"), finding("F2", "OPEN")]),
      "x.json",
    );
    expect(findings[0]?.where).toBe(
      "classification IMPASSE, round 2, attempt 3",
    );
  });

  it("survives a file with no findings array at all", () => {
    expect(
      checkMixedImpasseOutcome({ classification: "IMPASSE" }, "x.json"),
    ).toEqual([]);
    expect(checkMixedImpasseOutcome(undefined, "x.json")).toEqual([]);
  });
});

describe("lintTicket", () => {
  it("reports gating findings before warnings", () => {
    const findings = lintTicket(
      criteriaTicket(
        "A held finding is archived.",
        "The artifact carries both positions, etc.",
      ),
      vocabulary,
    );
    expect(findings.map((f) => f.severity)).toEqual(["gate", "gate", "warn"]);
  });

  it("never emits a check 1 finding — compound predicates are an authoring-checklist item", () => {
    // Deliberate scope: detecting "X and Y and Z" in free prose is NL parsing,
    // and the structural rescue (a mandatory ticket field) was cut in the plan
    // debate. If a check "1" ever appears here, someone rebuilt a cut item.
    const findings = lintTicket(
      criteriaTicket(
        "A stub generator escalates and the round count is unchanged and the artifact validates.",
      ),
      vocabulary,
    );
    expect(findings.map((f) => f.check)).not.toContain("1");
  });
});

describe("waivers", () => {
  const finding = {
    issue: 88,
    check: "3",
    severity: "gate",
    where: "criterion 5",
    token: "recorded",
    text: "PM out-of-scope gaps are recorded but never drive the verdict.",
    message: "…",
  };

  it("covers a finding when issue, check, token and match all agree", () => {
    expect(
      waiverCovers(
        { issue: 88, check: "3", token: "recorded", match: "never drive the verdict", reason: "…" },
        finding,
      ),
    ).toBe(true);
  });

  it("stops covering once the criterion no longer contains the match text", () => {
    // The anti-rubber-stamp property: rewriting the criterion brings the
    // finding back, so the reason gets re-read against the new words.
    expect(
      waiverCovers({ issue: 88, check: "3", match: "drives the verdict", reason: "…" }, finding),
    ).toBe(false);
  });

  it("does not leak across issues, checks or tokens", () => {
    expect(waiverCovers({ issue: 89, check: "3", reason: "…" }, finding)).toBe(false);
    expect(waiverCovers({ issue: 88, check: "2a", reason: "…" }, finding)).toBe(false);
    expect(waiverCovers({ issue: 88, check: "3", token: "archived", reason: "…" }, finding)).toBe(
      false,
    );
  });

  it("waives a gating finding and leaves warnings alone", () => {
    const warning = { ...finding, severity: "warn", check: "4" };
    const result = applyWaivers([finding, warning], {
      waivers: [{ issue: 88, check: "3", token: "recorded", reason: "Existing behavior." }],
    });
    expect(result.gating).toEqual([]);
    expect(result.waived).toHaveLength(1);
    expect(result.warnings).toEqual([warning]);
  });

  it("refuses a waiver with no reason, and still gates the finding", () => {
    const result = applyWaivers([finding], {
      waivers: [{ issue: 88, check: "3", token: "recorded", reason: "  " }],
    });
    expect(result.invalidWaivers).toHaveLength(1);
    expect(result.invalidWaivers[0].why).toContain("no reason");
    expect(result.gating).toHaveLength(1);
  });

  it("reports a waiver that matched nothing, so the file cannot rot", () => {
    const result = applyWaivers([], {
      waivers: [{ issue: 80, check: "3", token: "archived", reason: "Gone now." }],
    });
    expect(result.unusedWaivers).toHaveLength(1);
  });

  it("only reports an unused waiver whose subject this run actually read", () => {
    // `--outcome` alone reads no tickets, and every committed ticket waiver
    // would otherwise be announced as rotten on such a run.
    const ticketWaiver = { issue: 80, check: "3", reason: "…" };
    const outcomeWaiver = { outcome: ".afk", check: "5", reason: "…" };
    const unused = [ticketWaiver, outcomeWaiver];
    expect(
      relevantUnusedWaivers(unused, { ticketsRead: 0, outcomesRead: 2 }),
    ).toEqual([outcomeWaiver]);
    expect(
      relevantUnusedWaivers(unused, { ticketsRead: 3, outcomesRead: 0 }),
    ).toEqual([ticketWaiver]);
    expect(
      relevantUnusedWaivers(unused, { ticketsRead: 3, outcomesRead: 2 }),
    ).toEqual(unused);
  });

  describe("a check-5 finding, which has a path instead of an issue number", () => {
    const outcomeFinding = {
      issue: null,
      source: ".afk/run-x/slice-04/contract-negotiation-outcome.json",
      check: "5",
      severity: "gate",
      where: "classification IMPASSE, round 2, attempt 3",
      token: "IMPASSE",
      text: "CONTESTED [F1] beside unresolved OPEN blocker [F2]",
      message: "…",
    };

    it("is waived by a path substring", () => {
      expect(
        waiverCovers(
          { check: "5", outcome: "run-x/slice-04", reason: "Migrated by hand." },
          outcomeFinding,
        ),
      ).toBe(true);
      expect(
        waiverCovers(
          { check: "5", outcome: "run-x/slice-09", reason: "…" },
          outcomeFinding,
        ),
      ).toBe(false);
    });

    it("does not cross with the issue-number form in either direction", () => {
      // A `#88 check 3` waiver must not excuse an artifact defect, and an
      // outcome waiver must not excuse a ticket one.
      expect(
        waiverCovers({ issue: 88, check: "5", reason: "…" }, outcomeFinding),
      ).toBe(false);
      expect(
        waiverCovers({ check: "3", outcome: ".afk", reason: "…" }, finding),
      ).toBe(false);
    });

    it("keeps the anti-rubber-stamp match on the flagged text", () => {
      expect(
        waiverCovers(
          { check: "5", outcome: ".afk", match: "OPEN blocker [F2]", reason: "…" },
          outcomeFinding,
        ),
      ).toBe(true);
      expect(
        waiverCovers(
          { check: "5", outcome: ".afk", match: "OPEN blocker [F7]", reason: "…" },
          outcomeFinding,
        ),
      ).toBe(false);
    });
  });
});

describe("parseArgv", () => {
  it("reads issue numbers, with or without a hash, and the flags", () => {
    expect(parseArgv(["--dir", ".tickets", "--repo", "o/n", "80", "#81"])).toEqual({
      dir: ".tickets",
      repo: "o/n",
      numbers: [80, 81],
      outcomes: [],
    });
  });

  it("collects every --outcome target, and needs no issue number", () => {
    expect(parseArgv(["--outcome", ".afk", "--outcome", "x.json"])).toEqual({
      dir: null,
      repo: null,
      numbers: [],
      outcomes: [".afk", "x.json"],
    });
  });
});

describe("outcomeFilesUnder", () => {
  const write = (path: string, body: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(body), "utf-8");
  };

  it("takes a file as itself and a directory as every outcome file beneath it", () => {
    const root = mkdtempSync(join(tmpdir(), "afk-lint-outcome-"));
    try {
      const first = join(root, "slice-01", "contract-negotiation-outcome.json");
      const second = join(root, "slice-02", "contract-negotiation-outcome.json");
      write(first, { classification: "IMPASSE" });
      write(second, { classification: "NON_CONVERGENCE" });
      write(join(root, "slice-01", "contract-review.json"), {});

      expect(outcomeFilesUnder(first)).toEqual([first]);
      expect(outcomeFilesUnder(root)).toEqual([first, second]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the committed vocabulary and waiver files", () => {
  it("gives every absent name a note and where the decision is recorded", () => {
    // An absent-name entry is only usable if its message tells the reader why
    // the name does not exist and where that was decided.
    for (const absent of VOCABULARY.absentNames) {
      expect(absent.note, absent.name).toBeTruthy();
      expect(absent.recordedIn, absent.name).toBeTruthy();
    }
  });

  it("has a placeholder pattern that compiles", () => {
    expect(() => new RegExp(VOCABULARY.placeholderPattern)).not.toThrow();
  });

  it("gives every recorded waiver a reason, a known check and a subject", () => {
    // The lint enforces this at run time too; here it fails in the suite, so a
    // reasonless waiver cannot sit in the file waiting for the next lint run.
    for (const waiver of WAIVERS.waivers) {
      expect(String(waiver.reason ?? "").trim(), JSON.stringify(waiver)).not.toBe("");
      expect(["2a", "2b", "3", "5"], JSON.stringify(waiver)).toContain(waiver.check);
      // A check-5 waiver is about an artifact, so it carries a path instead of
      // an issue number. Every other check is about a ticket.
      if (waiver.check === "5") {
        expect(typeof waiver.outcome, JSON.stringify(waiver)).toBe("string");
      } else {
        expect(typeof waiver.issue, JSON.stringify(waiver)).toBe("number");
      }
    }
  });
});
