#!/usr/bin/env node
/**
 * Pre-AFK ticket lint — the gate on a slice ticket before the pipeline reads it.
 *
 * A generator gets one ticket, a locked contract and a scarce round cap. Two
 * PRD 1 slices (#77, #78) each burned rounds on defects that were plainly
 * visible in the ticket text: a criterion naming a state no schema had, and a
 * criterion demanding something be "recorded" without saying where. This
 * checks for exactly those, once per ticket, before any round is spent.
 *
 * Scope is the narrowed set from `docs/specs/afk-v2-plan.md` §3 item 6:
 *
 *   Check 2  a criterion names a state/field/artifact that is neither declared
 *            in `ticket-lint-vocabulary.json` nor introduced by the ticket's
 *            own prose (2a), or names something recorded as *not existing*
 *            (2b).                                              GATES
 *   Check 3  a criterion imposes a recording obligation and names no channel
 *            for it.                                            GATES
 *   Check 4  summarised field lists ("etc.", "such as", "and so on") anywhere
 *            in the ticket.                            WARNS, never gates
 *
 * Check 1 of the original four — compound predicates in one criterion ("X and
 * Y and Z" that can half-pass) — is deliberately **not** implemented. Detecting
 * it in free prose is natural-language parsing wearing a lint costume, and the
 * structural rescue (a mandatory ticket field) was cut in the plan debate as a
 * forever-tax on every future author. It is an **authoring-checklist item**:
 * when writing a ticket, split a criterion that can half-pass into one
 * criterion per observable fact. Nothing here will tell you that you didn't.
 *
 * Waivers live in `ticket-lint-waivers.json` — recorded text, one entry per
 * waived finding, each with a reason. A waiver with no reason is itself a
 * failure; a waiver that matches nothing is reported so the file cannot rot.
 *
 * Usage:
 *   node scripts/lint-tickets.mjs 80 81 82 89 94        # fetch with `gh`
 *   node scripts/lint-tickets.mjs --dir .tickets 80 81  # read <dir>/<n>.json
 *   node scripts/lint-tickets.mjs --repo owner/name 80
 *
 * `<dir>/<n>.json` is whatever `gh issue view <n> --json number,title,body`
 * writes, so a fetched corpus can be linted offline and in tests.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const VOCABULARY_PATH = "ticket-lint-vocabulary.json";
const WAIVERS_PATH = "ticket-lint-waivers.json";

const CRITERIA_HEADING = /^##\s+acceptance criteria\s*$/i;

/**
 * Split a ticket body into its acceptance criteria and everything else.
 *
 * "Everything else" matters as much as the criteria: it is where a ticket is
 * allowed to introduce its own vocabulary. A criterion may name
 * `escalation.md` because the What-to-build paragraph above it says what
 * `escalation.md` is; the same word in a ticket that never mentions it is a
 * name the generator has to invent.
 */
export function parseTicket(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  const criteria = [];
  const otherLines = [];
  let inCriteria = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inCriteria = CRITERIA_HEADING.test(line);
      otherLines.push(line);
      continue;
    }
    if (!inCriteria) {
      otherLines.push(line);
      continue;
    }
    const item = /^\s*[-*]\s*\[[ xX]?\]\s*(.*)$/.exec(line);
    if (item) {
      criteria.push({ number: criteria.length + 1, text: item[1].trim() });
    } else if (line.trim() === "") {
      continue;
    } else if (criteria.length > 0) {
      // A wrapped criterion: keep it with the criterion it belongs to.
      const last = criteria[criteria.length - 1];
      last.text = `${last.text} ${line.trim()}`;
    } else {
      otherLines.push(line);
    }
  }
  return { criteria, other: otherLines.join("\n") };
}

const FILENAME = /^[\w.\-/\\]+\.(?:json|md|log|ts|mjs|yaml|yml)$/i;

/**
 * A path, rather than a name: it has a separator or a `<placeholder>` segment.
 *
 * A path is a destination, so check 3 takes it as a named channel; and it is
 * not a name anything could declare, so check 2a leaves it alone —
 * `.afk/artifacts/<run-slug>/slice-<n>/` is run-specific by construction.
 */
export function looksLikePath(token) {
  return /[/\\]/.test(token) || /<[^>]*>/.test(token);
}

/**
 * The identifier-shaped names in a piece of text — the tokens that could be a
 * state, a field or an artifact.
 *
 * Three shapes only, all of them ones an author chose deliberately:
 * backticked single words (the author marked it as code), bare filenames, and
 * bare SCREAMING_CASE (how every phase and verdict in this pipeline is
 * spelled). Free-prose nouns are not candidates — that way lies check 1.
 */
export function identifiersIn(text) {
  const found = [];
  const add = (raw) => {
    const token = String(raw).replace(/^[^\w#./\\<]+|[^\w:)\]>/\\]+$/g, "");
    if (token.length < 2) return;
    // A name has a letter in it. Without this, `[1]` in a type-validation
    // criterion arrives as the identifier "1]".
    if (!/[A-Za-z]/.test(token)) return;
    if (!found.includes(token)) found.push(token);
  };

  const stripped = String(text ?? "").replace(/`([^`]+)`/g, (_, inner) => {
    if (!/\s/.test(inner)) add(inner);
    return " ".repeat(inner.length + 2);
  });

  for (const match of stripped.matchAll(/[\w.\-/\\]+/g)) {
    if (FILENAME.test(match[0])) add(match[0]);
  }
  for (const match of stripped.matchAll(/\b[A-Z][A-Z]+(?:[-_][A-Z]+)*\b/g)) {
    add(match[0]);
  }
  return found;
}

const lower = (values) => new Set(values.map((v) => String(v).toLowerCase()));
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A phrase, bounded at word edges. Used for channels and for looking a name up
 * in a ticket's prose, where hyphenated neighbours are wanted: "gate evidence"
 * has to match "base-gate evidence".
 */
const wordRegex = (value, flags = "i") => {
  const body = escape(value);
  const left = /^\w/.test(value) ? "\\b" : "";
  const right = /\w$/.test(value) ? "\\b" : "";
  return new RegExp(`${left}${body}${right}`, flags);
};

/**
 * A single word, and not a piece of a hyphenated compound.
 *
 * `\blog\b` finds "log" inside "commit-log data block", where it is a noun in
 * somebody else's compound rather than an obligation to log anything. Recording
 * verbs are matched this way; phrases are not.
 */
const soleWordRegex = (value) =>
  new RegExp(`(?<![\\w-])${escape(value)}(?![\\w-])`, "i");

/**
 * Check 2a — a criterion names something no reader can look up.
 *
 * Known means: declared in the vocabulary file (it exists in the pipeline
 * today) or present in the ticket's own prose (this ticket introduces it).
 */
export function checkUnknownNames(ticket, vocabulary) {
  const { criteria, other } = parseTicket(ticket.body);
  const declared = lower(vocabulary.names);
  const prose = lower(vocabulary.prose);
  // Example identifiers (`F1`, `R2`) stand in for opaque runtime IDs. They are
  // placeholders by convention, not names anything could declare.
  const placeholder = new RegExp(vocabulary.placeholderPattern ?? "^$");
  const definitionText = `${ticket.title ?? ""}\n${other}`;
  const findings = [];
  for (const criterion of criteria) {
    for (const token of identifiersIn(criterion.text)) {
      const key = token.toLowerCase();
      if (declared.has(key) || prose.has(key)) continue;
      if (placeholder.test(token) || looksLikePath(token)) continue;
      if (wordRegex(token).test(definitionText)) continue;
      findings.push({
        issue: ticket.number,
        check: "2a",
        severity: "gate",
        where: `criterion ${criterion.number}`,
        token,
        text: criterion.text,
        message:
          `names \`${token}\`, which is neither declared in ${VOCABULARY_PATH} ` +
          `nor introduced anywhere else in the ticket`,
      });
    }
  }
  return findings;
}

/**
 * Check 2b — a criterion names something recorded as not existing.
 *
 * The arm that pays for itself: #78 had to spend prose on "there is no fifth
 * `HELD` state" because an earlier draft implied one. Once a decision like
 * that is recorded, the lint enforces it instead of the next reader
 * rediscovering it. Occurrences outside the criteria warn — the criteria are
 * what gets locked, so only they gate.
 */
export function checkAbsentNames(ticket, vocabulary) {
  const { criteria, other } = parseTicket(ticket.body);
  const findings = [];
  for (const absent of vocabulary.absentNames ?? []) {
    // `caseSensitive` is for names that are only that name in capitals: the
    // retired `GAPS:` marker must not fire on the English word "gaps".
    const regex = wordRegex(absent.name, absent.caseSensitive === true ? "" : "i");
    const message =
      `names "${absent.name}", which does not exist: ${absent.note} ` +
      `(recorded in ${absent.recordedIn})`;
    for (const criterion of criteria) {
      if (!regex.test(criterion.text)) continue;
      findings.push({
        issue: ticket.number,
        check: "2b",
        severity: "gate",
        where: `criterion ${criterion.number}`,
        token: absent.name,
        text: criterion.text,
        message,
      });
    }
    if (regex.test(other)) {
      findings.push({
        issue: ticket.number,
        check: "2b",
        severity: "warn",
        where: "ticket prose",
        token: absent.name,
        text: absent.name,
        message,
      });
    }
  }
  return findings;
}

/**
 * Check 3 — a recording obligation with no channel named.
 *
 * "Every review attempt is archived" (#77) is a true sentence about nowhere in
 * particular. It shipped, and then #123 was filed because restart relocated
 * the archives and nothing said which location was the promise. A criterion
 * that obliges someone to record something has to say where it lands.
 */
export function checkRecordingChannel(ticket, vocabulary) {
  const { criteria } = parseTicket(ticket.body);
  const verbs = (vocabulary.recordingVerbs ?? []).map(soleWordRegex);
  const verbNames = vocabulary.recordingVerbs ?? [];
  const phrases = (vocabulary.recordingPhrases ?? []).map(
    (source) => new RegExp(source, "i"),
  );
  const channels = (vocabulary.channels ?? []).map((channel) =>
    wordRegex(channel),
  );
  const findings = [];
  for (const criterion of criteria) {
    let trigger = null;
    for (const [index, regex] of verbs.entries()) {
      if (regex.test(criterion.text)) {
        trigger = verbNames[index];
        break;
      }
    }
    if (trigger === null) {
      for (const regex of phrases) {
        const match = regex.exec(criterion.text);
        if (match) {
          trigger = match[0];
          break;
        }
      }
    }
    if (trigger === null) continue;
    const named =
      channels.some((regex) => regex.test(criterion.text)) ||
      identifiersIn(criterion.text).some(
        (token) => FILENAME.test(token) || looksLikePath(token),
      );
    if (named) continue;
    findings.push({
      issue: ticket.number,
      check: "3",
      severity: "gate",
      where: `criterion ${criterion.number}`,
      token: trigger,
      text: criterion.text,
      message:
        `obliges someone to record something ("${trigger}") without naming a ` +
        `channel — say which artifact, log or record it lands in`,
    });
  }
  return findings;
}

/**
 * Check 4 — summarised field lists. Warn only, forever.
 *
 * "the finding, both positions, and both evidences" is buildable; "the finding
 * and the relevant context, etc." is not, and the difference is one phrase.
 * This never gates: false positives here would only teach authors to phrase
 * around the lexicon, which is the defect with extra steps.
 */
export function checkSummarisedLists(ticket, vocabulary) {
  const { criteria, other } = parseTicket(ticket.body);
  const findings = [];
  const scan = (where, text) => {
    for (const phrase of vocabulary.summaryPhrases ?? []) {
      if (!text.toLowerCase().includes(phrase.toLowerCase())) continue;
      findings.push({
        issue: ticket.number,
        check: "4",
        severity: "warn",
        where,
        token: phrase.trim(),
        text,
        message:
          `summarises instead of enumerating ("${phrase.trim()}") — a reader ` +
          `cannot tell which fields are required`,
      });
    }
  };
  for (const criterion of criteria) scan(`criterion ${criterion.number}`, criterion.text);
  scan("ticket prose", other);
  return findings;
}

/** Every finding for one ticket, gating ones first. */
export function lintTicket(ticket, vocabulary) {
  const findings = [
    ...checkAbsentNames(ticket, vocabulary),
    ...checkUnknownNames(ticket, vocabulary),
    ...checkRecordingChannel(ticket, vocabulary),
    ...checkSummarisedLists(ticket, vocabulary),
  ];
  return findings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "gate" ? -1 : 1;
    return a.check.localeCompare(b.check);
  });
}

/**
 * Whether a waiver covers a finding.
 *
 * `match` is a substring that must still appear in the flagged text. That is
 * the anti-rubber-stamp property: rewrite the criterion and the waiver stops
 * applying, so the finding comes back and someone looks at it again with the
 * new words in front of them.
 */
export function waiverCovers(waiver, finding) {
  if (Number(waiver.issue) !== Number(finding.issue)) return false;
  if (String(waiver.check) !== finding.check) return false;
  if (waiver.token !== undefined && waiver.token !== finding.token) return false;
  if (waiver.match !== undefined && waiver.match !== "") {
    if (!finding.text.toLowerCase().includes(String(waiver.match).toLowerCase()))
      return false;
  }
  return true;
}

/**
 * Sort findings into what stops the ticket, what a waiver excused, and what
 * only warns — plus the waivers that matched nothing and the malformed ones.
 *
 * A waiver with a blank reason is an error, not a waiver: the whole mechanism
 * is that the reason is written down where the next reader trips over it.
 */
export function applyWaivers(findings, waivers) {
  const entries = waivers?.waivers ?? [];
  const invalid = entries
    .filter((waiver) => String(waiver.reason ?? "").trim() === "")
    .map((waiver) => ({
      waiver,
      why: "has no reason — a waiver without a recorded reason is a rubber stamp",
    }));
  const usable = entries.filter(
    (waiver) => String(waiver.reason ?? "").trim() !== "",
  );
  const used = new Set();
  const gating = [];
  const waived = [];
  const warnings = [];
  for (const finding of findings) {
    if (finding.severity === "warn") {
      warnings.push(finding);
      continue;
    }
    const index = usable.findIndex((waiver) => waiverCovers(waiver, finding));
    if (index === -1) {
      gating.push(finding);
    } else {
      used.add(index);
      waived.push({ ...finding, waiver: usable[index] });
    }
  }
  const unused = usable.filter((_, index) => !used.has(index));
  return { gating, waived, warnings, unusedWaivers: unused, invalidWaivers: invalid };
}

function readTicket(number, options) {
  if (options.dir !== null) {
    return JSON.parse(readFileSync(join(options.dir, `${number}.json`), "utf-8"));
  }
  const argv = ["issue", "view", String(number), "--json", "number,title,body"];
  if (options.repo !== null) argv.push("--repo", options.repo);
  return JSON.parse(execFileSync("gh", argv, { encoding: "utf-8" }));
}

export function parseArgv(argv) {
  const options = { dir: null, repo: null, numbers: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dir") options.dir = argv[(index += 1)];
    else if (arg === "--repo") options.repo = argv[(index += 1)];
    else options.numbers.push(Number(arg.replace(/^#/, "")));
  }
  return options;
}

function main() {
  const options = parseArgv(process.argv.slice(2));
  if (options.numbers.length === 0 || options.numbers.some(Number.isNaN)) {
    console.error(
      "Usage: node scripts/lint-tickets.mjs [--dir <dir>] [--repo <owner/name>] <issue>...\n" +
        "\nChecks 2 and 3 gate (waivable in " +
        WAIVERS_PATH +
        "); check 4 warns.\n" +
        "Check 1 (compound predicates that can half-pass) is an authoring-\n" +
        "checklist item, not a lint: split such a criterion by hand.",
    );
    process.exit(1);
  }

  const vocabulary = JSON.parse(readFileSync(VOCABULARY_PATH, "utf-8"));
  const waivers = JSON.parse(readFileSync(WAIVERS_PATH, "utf-8"));

  const findings = [];
  for (const number of options.numbers) {
    const ticket = readTicket(number, options);
    findings.push(...lintTicket(ticket, vocabulary));
  }

  const { gating, waived, warnings, unusedWaivers, invalidWaivers } =
    applyWaivers(findings, waivers);

  // A criterion is quotable whole; a hit in the prose is not, so quote a
  // window around the token instead of the first 160 characters of the section.
  const quote = (finding) => {
    const flat = finding.text.replace(/\s+/g, " ").trim();
    if (flat.length <= 170) return flat;
    const at = flat.toLowerCase().indexOf(finding.token.toLowerCase());
    const from = Math.max(0, at - 70);
    return `…${flat.slice(from, from + 170)}…`;
  };
  const show = (finding) =>
    `  #${finding.issue} ${finding.where} [check ${finding.check}] ${finding.message}\n` +
    `      "${quote(finding)}"`;

  if (gating.length > 0) {
    console.error(`\nGATING (${gating.length}):\n`);
    for (const finding of gating) console.error(show(finding));
  }
  if (warnings.length > 0) {
    console.log(`\nWARN (${warnings.length}) — never gates:\n`);
    for (const finding of warnings) console.log(show(finding));
  }
  if (waived.length > 0) {
    console.log(`\nWAIVED (${waived.length}):\n`);
    for (const finding of waived)
      console.log(
        `  #${finding.issue} ${finding.where} [check ${finding.check}] ${finding.token} — ${finding.waiver.reason}`,
      );
  }
  for (const { waiver, why } of invalidWaivers)
    console.error(`  waiver error: #${waiver.issue} check ${waiver.check} ${why}`);
  for (const waiver of unusedWaivers)
    console.log(
      `  note: waiver for #${waiver.issue} check ${waiver.check} ` +
        `(${waiver.token ?? waiver.match ?? "any"}) matched nothing — delete it or fix its match`,
    );

  console.log(
    `\n${options.numbers.length} ticket(s): ${gating.length} gating, ` +
      `${waived.length} waived, ${warnings.length} warning(s).`,
  );

  if (gating.length > 0 || invalidWaivers.length > 0) {
    console.error(
      `\nFix the ticket text, or record a waiver with a reason in ${WAIVERS_PATH}.`,
    );
    process.exit(1);
  }
  console.log("Every ticket is lint-clean.");
}

// Importable for its unit test; only the CLI invocation runs the lint.
if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main();
}
