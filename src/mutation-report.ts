/**
 * Report-only mutation survivor step (#303, ADR 0071).
 *
 * One place holds everything the ship gate needs to run a declared mutation
 * command once per run and say what survived: the report parser, the
 * mutation-eligible-source filter, the outcome classifier, the step runner
 * with its pre-spawn abandonment check, and the one bounded-await helper every
 * exit from the guardian mode fork goes through.
 *
 * Reported, never a gate (ADR 0063). Nothing here produces a `GateDeclaration`,
 * holds a gate id, or is read by any verdict or PR-open decision: a survivor is
 * a question for a reviewer, and a kill-rate threshold is a number that fails
 * work nobody has read.
 *
 * The bound is the flat, non-configurable {@link MUTATION_STEP_BOUND_MS}. It
 * lives here rather than on an options object because a configurable bound is a
 * bound a run can set to zero, and the whole obligation is that a mutation tool
 * can never hold a ship gate open indefinitely.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildChangeSummary, type ChangeSummary, type ChangeSummaryFile } from "./change-summary.js";
import { registerWorktreeProcess } from "./worktree-processes.js";

/**
 * The optional `mutationReport` member of a PRD directory's `afk.json`
 * (`parseAfkManifest`). `reportPath` is repo-relative and normalized the way
 * waiver paths are, so the gate and the manifest compare the same bytes.
 */
export interface MutationReportConfig {
  command: string;
  reportPath: string;
  /**
   * The declared incremental baseline artifact (#304 B-01). Absent means no
   * baseline was declared, which is the normal case and never an error: every
   * survivor is then reported `unattributed`.
   */
  baselinePath?: string;
  /**
   * The declared triage decisions file (#304 B-01). Absent means no decisions
   * file was declared — again normal, and never an error.
   */
  decisionsPath?: string;
}

/**
 * What attribution says about one survivor (#304 B-05, B-07).
 *
 * A label is report text and nothing else: no gate id, verdict or PR-open
 * condition reads one (ADR 0063, ADR 0071's "no blocking mutation gate"), and
 * `accepted` marks a survivor rather than removing it — the report marks, it
 * never suppresses.
 */
export type MutationSurvivorLabel =
  | "new-in-this-run"
  | "pre-existing"
  | "unattributed"
  | "accepted";

/**
 * Why attribution could not answer, when it could not (#304 B-08).
 *
 * Keyed only on a file that is *present but unusable*. An absent baseline or
 * decisions file produces no note at all, because absence is the normal case
 * and a note for it would be a warning every project without one reads forever.
 */
export type MutationAttributionNote =
  | "BASELINE_UNUSABLE"
  | "DECISIONS_UNUSABLE";

/** Where one mutant sits in its file, as the report spells it. */
export interface MutationSurvivorPosition {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/** One surviving mutant: identity, file, position, mutator. */
export interface MutationSurvivor {
  /**
   * Mutant identity as the report gives it — the tool's own id, never one
   * minted here: slice 2's decisions file keys accepted survivors by it.
   */
  id: string;
  file: string;
  mutator: string;
  position: MutationSurvivorPosition;
  /**
   * What attribution said about this survivor (#304 B-05). Optional, because a
   * record persisted before this slice carries none — and absence *means*
   * `unattributed`, which is why the render derivation substitutes exactly that
   * and the parser mints no label of its own.
   */
  label?: MutationSurvivorLabel;
}

/**
 * What reading the declared report produced. `MALFORMED` and `UNREADABLE` are
 * kept apart because they are different operator problems: a tool that wrote
 * nothing, versus a tool that wrote something this parser does not accept.
 */
export type MutationReportRead =
  | { status: "PARSED"; survivors: MutationSurvivor[] }
  | { status: "MALFORMED"; detail: string }
  | { status: "UNREADABLE"; detail: string };

/** Why a step produced no survivor list. */
export type MutationNotRunReason =
  | "BOUND_REACHED"
  | "COMMAND_FAILED"
  | "REPORT_UNREADABLE"
  | "REPORT_MALFORMED";

/** The step's whole result vocabulary — two cases, neither of them a verdict. */
export type MutationStepOutcome =
  | {
      status: "MUTATION_REPORTED";
      survivors: MutationSurvivor[];
      /**
       * Present only when a declared baseline or decisions file was there but
       * unusable (#304 B-08). Absent is the ordinary shape, so nothing changes
       * for a run that declared neither file.
       */
      attributionNotes?: MutationAttributionNote[];
    }
  | { status: "MUTATION_NOT_RUN"; reason: MutationNotRunReason };

/** How the declared command exited, as the step observed it. */
export type MutationCommandExit =
  | { status: "OK" }
  | { status: "FAILED"; detail: string };

/**
 * The mutation-testing-elements report shape this slice reads — hand-derived
 * from the public schema rather than vendored, because no schema artifact
 * exists in this repository and only mutant status `Survived` is load-bearing
 * here. A tool-specific adapter is an explicit non-goal.
 */
interface RawMutant {
  id?: unknown;
  mutatorName?: unknown;
  status?: unknown;
  location?: {
    start?: { line?: unknown; column?: unknown };
    end?: { line?: unknown; column?: unknown };
  };
}

function malformed(detail: string): MutationReportRead {
  return { status: "MALFORMED", detail };
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Parse a mutation-testing-elements report into its survivor list.
 *
 * Pure and total: every rejection is a `MALFORMED` result naming what was
 * wrong, never a throw, because the caller has to classify the step either way
 * and a thrown parse error inside a report-only step could reach a gate.
 *
 * Only `Survived` mutants are returned. `Killed`, `NoCoverage`, `Timeout`,
 * `CompileError` and `Ignored` are all decided facts — a report-only step has
 * nothing to say about them.
 */
export function parseMutationReport(text: string): MutationReportRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return malformed(
      `report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return malformed("report must be a JSON object");
  }
  const files = (raw as { files?: unknown }).files;
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    return malformed("report must hold a files object");
  }

  const survivors: MutationSurvivor[] = [];
  for (const [file, entry] of Object.entries(files as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return malformed(`report entry for ${file} must be an object`);
    }
    const mutants = (entry as { mutants?: unknown }).mutants;
    if (!Array.isArray(mutants)) {
      return malformed(`report entry for ${file} must hold a mutants array`);
    }
    for (const value of mutants) {
      if (!value || typeof value !== "object") {
        return malformed(`report entry for ${file} holds a non-object mutant`);
      }
      const mutant = value as RawMutant;
      if (mutant.status !== "Survived") continue;
      const id = typeof mutant.id === "string" ? mutant.id.trim() : "";
      const mutator =
        typeof mutant.mutatorName === "string" ? mutant.mutatorName.trim() : "";
      const startLine = positiveInt(mutant.location?.start?.line);
      const startColumn = positiveInt(mutant.location?.start?.column);
      const endLine = positiveInt(mutant.location?.end?.line);
      const endColumn = positiveInt(mutant.location?.end?.column);
      if (
        id === "" ||
        mutator === "" ||
        startLine === undefined ||
        startColumn === undefined ||
        endLine === undefined ||
        endColumn === undefined
      ) {
        // A survivor nobody can locate is not a survivor a reviewer can read,
        // and silently dropping it would report a shorter list than the tool
        // produced. The whole report degrades instead.
        return malformed(
          `report entry for ${file} holds a survived mutant without an id, mutator and location`,
        );
      }
      survivors.push({
        id,
        file,
        mutator,
        position: { startLine, startColumn, endLine, endColumn },
      });
    }
  }
  return { status: "PARSED", survivors };
}

/**
 * Read the declared report from the worktree the command ran in. The **file**
 * is the source of results, never the tool's stdout: stdout is a progress log
 * whose shape every tool spells differently.
 */
export function readMutationReport(
  cwd: string,
  reportPath: string,
): MutationReportRead {
  let text: string;
  try {
    text = readFileSync(join(cwd, reportPath), "utf-8");
  } catch (error) {
    return {
      status: "UNREADABLE",
      detail: `cannot read ${reportPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return parseMutationReport(text);
}

/** A triage verdict a human recorded for one mutant (ADR 0071). */
export type MutationDecisionVerdict = "KILL" | "ACCEPT";

/**
 * One entry of the committed decisions file, in ADR 0071's field set with the
 * key spellings pinned here (#304 B-04) so every Stage A triage session writes
 * one spelling from day one.
 *
 * `id` is the mutation tool's own id, as {@link MutationSurvivor} already
 * declares it, and `file` corroborates it: per-file ids collide across files, so
 * a bare id match must be corroborated before it resolves identity (ADR 0065).
 */
export interface MutationDecision {
  id: string;
  file: string;
  verdict: MutationDecisionVerdict;
  /** What shipping this mutant unkilled would cost. */
  consequence: string;
  /** What keeps that cost bounded. */
  containment: string;
  /** The one line of reasoning behind the verdict. */
  reasoning: string;
}

/**
 * What parsing the decisions *text* produced. No `UNREADABLE`: a text this
 * function was handed was already read.
 */
export type MutationDecisionsParse =
  | { status: "PARSED"; decisions: MutationDecision[] }
  | { status: "MALFORMED"; detail: string };

/**
 * What reading a declared baseline artifact produced — {@link
 * MutationReportRead} plus `ABSENT`.
 *
 * `ABSENT` is the whole point of this union and the one signal every
 * degradation rule in this slice keys on: a declared baseline that is simply not
 * there is the normal case and must stay silent, while one that is there and
 * unusable is a named degradation. That deliberately diverges from
 * {@link readMutationReport}, which collapses an absent report into
 * `UNREADABLE` — and must keep doing so, because a missing mutation report is a
 * real failure that has to reach `REPORT_UNREADABLE` (#303).
 */
export type MutationBaselineRead = MutationReportRead | { status: "ABSENT" };

/** What reading a declared decisions file produced. See {@link MutationBaselineRead}. */
export type MutationDecisionsRead =
  | MutationDecisionsParse
  | { status: "UNREADABLE"; detail: string }
  | { status: "ABSENT" };

function malformedDecisions(detail: string): MutationDecisionsParse {
  return { status: "MALFORMED", detail };
}

/**
 * Parse a triage decisions file into its entries.
 *
 * Pure and total, the discipline {@link parseMutationReport} is under: every
 * rejection is a `MALFORMED` result naming the offending member, never a throw,
 * because a report-only step's parse error must not reach a gate.
 *
 * `version: 1` matches the manifest's version regime per ADR 0071's "Decisions
 * file schema"; a blank field is refused rather than defaulted, because a
 * decision with an empty `reasoning` is a decision nobody can review later —
 * the same rule a protected-change waiver is under.
 */
export function parseMutationDecisions(text: string): MutationDecisionsParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return malformedDecisions(
      `decisions file is not valid JSON: ${describeError(error)}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return malformedDecisions("decisions file must be a JSON object");
  }
  const doc = raw as Record<string, unknown>;
  if (doc.version !== 1) {
    return malformedDecisions("decisions file must declare version 1");
  }
  if (!Array.isArray(doc.decisions)) {
    return malformedDecisions("decisions file must hold a decisions array");
  }
  const decisions: MutationDecision[] = [];
  for (const [index, entry] of doc.decisions.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return malformedDecisions(
        `decisions entry ${index} must be a JSON object holding id, file, ` +
          `verdict, consequence, containment and reasoning`,
      );
    }
    const value = entry as Record<string, unknown>;
    if (value.verdict !== "KILL" && value.verdict !== "ACCEPT") {
      return malformedDecisions(
        `decisions entry ${index} does not recognise verdict ` +
          `${JSON.stringify(value.verdict)}; the declared verdicts are KILL, ACCEPT`,
      );
    }
    const fields: Record<string, string> = {};
    for (const field of [
      "id",
      "file",
      "consequence",
      "containment",
      "reasoning",
    ] as const) {
      const declared = value[field];
      if (typeof declared !== "string" || declared.trim() === "") {
        return malformedDecisions(
          `decisions entry ${index} requires a non-blank ${field}`,
        );
      }
      fields[field] = declared.trim();
    }
    decisions.push({
      id: fields.id!,
      file: fields.file!,
      verdict: value.verdict,
      consequence: fields.consequence!,
      containment: fields.containment!,
      reasoning: fields.reasoning!,
    });
  }
  return { status: "PARSED", decisions };
}

/**
 * Read one declared optional artifact, separating "not there" from "there and
 * unreadable" — the distinction the whole degradation vocabulary keys on
 * (#304 B-04). `existsSync` is checked first and is the *only* thing that
 * produces `ABSENT`.
 */
function readDeclaredArtifact(
  cwd: string,
  path: string,
):
  | { status: "ABSENT" }
  | { status: "UNREADABLE"; detail: string }
  | { status: "READ"; text: string } {
  const full = join(cwd, path);
  if (!existsSync(full)) return { status: "ABSENT" };
  try {
    return { status: "READ", text: readFileSync(full, "utf-8") };
  } catch (error) {
    return {
      status: "UNREADABLE",
      detail: `cannot read ${path}: ${describeError(error)}`,
    };
  }
}

/**
 * Read the declared baseline artifact from the worktree the command ran in.
 *
 * Parsed by {@link parseMutationReport} on this slice's stated assumption that
 * the tool's incremental artifact is the same mutation-testing-elements
 * document — no sample incremental file and no schema artifact exists in this
 * repository to confirm that shape, the same gap the report parser above already
 * records. The assumption is safe because its failure is contained and named: a
 * differently shaped baseline parses `MALFORMED`, which becomes
 * `BASELINE_UNUSABLE` with every survivor `unattributed`, so a wrong shape can
 * only cost attribution and can never produce a wrong label.
 */
export function readMutationBaseline(
  cwd: string,
  baselinePath: string,
): MutationBaselineRead {
  const read = readDeclaredArtifact(cwd, baselinePath);
  if (read.status !== "READ") return read;
  return parseMutationReport(read.text);
}

/** Read the declared decisions file from the worktree the command ran in. */
export function readMutationDecisions(
  cwd: string,
  decisionsPath: string,
): MutationDecisionsRead {
  const read = readDeclaredArtifact(cwd, decisionsPath);
  if (read.status !== "READ") return read;
  return parseMutationDecisions(read.text);
}

/** One spelling for a path, so a baseline and a report compare the same bytes. */
function samePath(file: string): string {
  return file.replace(/\\/g, "/");
}

/**
 * The field separator inside a match key. Written as an escape, not as a literal
 * control character, so the source file stays text: a raw NUL byte makes `grep`
 * and `git diff` treat this module as binary.
 */
const KEY_FIELD = "\u0000";

/**
 * The baseline match key: file, mutator and all four position numbers — never
 * the tool's id.
 *
 * On this slice's conservative assumption that an incremental artifact may
 * renumber its per-file mutant ids between runs, an id-keyed comparison would
 * report unchanged survivors as new. Location and mutator are stable under
 * renumbering either way, so the assumption costs nothing if it is wrong.
 */
function baselineKey(survivor: MutationSurvivor): string {
  return [
    samePath(survivor.file),
    survivor.mutator,
    survivor.position.startLine,
    survivor.position.startColumn,
    survivor.position.endLine,
    survivor.position.endColumn,
  ].join(KEY_FIELD);
}

/**
 * The decisions match key: the tool's own `id`, corroborated by `file`.
 *
 * Deliberately *not* {@link baselineKey}, and the divergence is the recorded
 * decision's rather than this slice's: {@link MutationSurvivor} and ADR 0071
 * already commit the decisions file to the tool's own id, and amending that ADR
 * is an explicit non-goal. B-05's premise therefore lands here as a stated
 * consequence: if the tool renumbers per-file ids between runs, a committed
 * `ACCEPT` entry goes stale — either matching nothing, so its survivor is
 * re-raised carrying its baseline label, or matching whichever mutant now holds
 * that id in the same file, so one bullet is mislabeled. The harm is bounded by
 * what a label is: report text no gate, verdict or PR-open condition reads, on a
 * survivor that stays in the list at full detail.
 */
function decisionKey(entry: { id: string; file: string }): string {
  return `${entry.id}${KEY_FIELD}${samePath(entry.file)}`;
}

/** One `label` per survivor, plus whatever degradation had to be stated. */
export interface MutationAttribution {
  survivors: MutationSurvivor[];
  notes: MutationAttributionNote[];
}

/**
 * Label each survivor from the run's optional baseline and optional decisions
 * file. Pure — the three inputs are the whole content, and it is called once per
 * run, so `run-summary.md` and the draft PR body cannot disagree about a label.
 *
 * Absence is silent, and it is the *omitted or `ABSENT` input* that makes it so:
 * an omitted argument and an `{ status: "ABSENT" }` argument take the identical
 * branch, and neither produces a note. Because the noted branch is keyed on
 * `UNREADABLE` or `MALFORMED` alone, no single input can be both silent and
 * noted.
 *
 * Nothing here gates. A label is a mark on a bullet a reviewer reads.
 */
export function attributeMutationSurvivors(input: {
  survivors: readonly MutationSurvivor[];
  /** Omitted when no `baselinePath` was declared; see {@link MutationBaselineRead}. */
  baseline?: MutationBaselineRead;
  /** Omitted when no `decisionsPath` was declared. */
  decisions?: MutationDecisionsRead;
}): MutationAttribution {
  const notes: MutationAttributionNote[] = [];

  const baseline = input.baseline;
  const baselineKeys =
    baseline?.status === "PARSED"
      ? new Set(baseline.survivors.map(baselineKey))
      : undefined;
  if (
    baseline !== undefined &&
    baseline.status !== "PARSED" &&
    baseline.status !== "ABSENT"
  ) {
    notes.push("BASELINE_UNUSABLE");
  }

  const decisions = input.decisions;
  const accepted =
    decisions?.status === "PARSED"
      ? new Set(
          decisions.decisions
            .filter((entry) => entry.verdict === "ACCEPT")
            .map(decisionKey),
        )
      : undefined;
  if (
    decisions !== undefined &&
    decisions.status !== "PARSED" &&
    decisions.status !== "ABSENT"
  ) {
    notes.push("DECISIONS_UNUSABLE");
  }

  // Mapped, never filtered: an `accepted` survivor keeps its place in the list
  // at full detail, because the report marks and never suppresses.
  const survivors = input.survivors.map((survivor) => {
    const fromBaseline: MutationSurvivorLabel =
      baselineKeys === undefined
        ? "unattributed"
        : baselineKeys.has(baselineKey(survivor))
          ? "pre-existing"
          : "new-in-this-run";
    // A `KILL` entry changes no label: an unkilled mutant a human ruled killable
    // is still an open finding.
    const label: MutationSurvivorLabel =
      accepted !== undefined && accepted.has(decisionKey(survivor))
        ? "accepted"
        : fromBaseline;
    return { ...survivor, label };
  });

  return { survivors, notes };
}

/**
 * Source extensions a mutation tool can mutate. Declaration files carry no
 * runtime behavior, so nothing in them can survive anything.
 */
const MUTATION_ELIGIBLE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/**
 * True when one changed file is mutation-eligible source. A deleted file has
 * nothing left to mutate; a test file is the thing that does the killing, so
 * mutating it measures nothing.
 */
export function isMutationEligibleSource(file: ChangeSummaryFile): boolean {
  const path = file.path.replace(/\\/g, "/");
  if (file.status.startsWith("D")) return false;
  if (path.endsWith(".d.ts")) return false;
  if (/\.(test|spec|fixtures)\.[cm]?[jt]sx?$/.test(path)) return false;
  return MUTATION_ELIGIBLE_EXTENSIONS.some((extension) =>
    path.endsWith(extension),
  );
}

/**
 * The mutation command's file scope: the changed files of the run, filtered to
 * mutation-eligible source, in the order the change summary lists them.
 *
 * The change summary is the single producer of "what this run changed"
 * (ARCHITECTURE.md "Change summary"); this is a filter over it, never a second
 * builder.
 */
export function mutationEligibleSources(summary: ChangeSummary): string[] {
  return summary.files
    .filter(isMutationEligibleSource)
    .map((file) => file.path.replace(/\\/g, "/"));
}

/**
 * Classify the step from the three facts that decide it: how the declared
 * command exited, what reading its report produced, and whether the bound was
 * reached. Pure — the ordering is the whole content.
 *
 * The bound wins over everything: a step cut off mid-run may have written a
 * partial report, and reporting a partial survivor list as if it were the
 * answer is worse than saying the step did not run.
 */
export function classifyMutationStep(input: {
  exit: MutationCommandExit;
  /** Absent when the step never got as far as reading the report. */
  report?: MutationReportRead;
  deadline: "INSIDE" | "REACHED";
}): MutationStepOutcome {
  if (input.deadline === "REACHED") {
    return { status: "MUTATION_NOT_RUN", reason: "BOUND_REACHED" };
  }
  if (input.exit.status === "FAILED") {
    return { status: "MUTATION_NOT_RUN", reason: "COMMAND_FAILED" };
  }
  if (input.report === undefined || input.report.status === "UNREADABLE") {
    return { status: "MUTATION_NOT_RUN", reason: "REPORT_UNREADABLE" };
  }
  if (input.report.status === "MALFORMED") {
    return { status: "MUTATION_NOT_RUN", reason: "REPORT_MALFORMED" };
  }
  return { status: "MUTATION_REPORTED", survivors: input.report.survivors };
}

/**
 * The declared mutation command, in the documented shape of the ship gate's
 * `runCommand`/`sanityRunCommand` seams: substituted by direct tests so no
 * suite invokes a real mutation tool. Resolves with the command's stdout,
 * which the step deliberately ignores.
 */
export type MutationCommandRunner = (
  command: string,
  files: readonly string[],
  options: { cwd: string; encoding: "utf-8" },
) => Promise<string>;

const defaultMutationRun: MutationCommandRunner = (command, files, options) =>
  new Promise<string>((resolveRun, rejectRun) => {
    // `shell: true` because the manifest declares a command line
    // (`pnpm stryker run`), not an executable plus argv.
    const child = spawn(command, [...files], {
      cwd: options.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Registered against the worktree so the one `terminate` binding the ship
    // gate holds can quiesce it — there is no second kill path (ADR 0035).
    registerWorktreeProcess(options.cwd, child);
    let stdout = "";
    child.stdout?.setEncoding(options.encoding);
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", rejectRun);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolveRun(stdout);
        return;
      }
      rejectRun(
        new Error(
          `mutation command exited ${code ?? `on signal ${signal ?? "unknown"}`}`,
        ),
      );
    });
  });

export interface RunMutationStepArgs {
  /** The merged review worktree the command runs in. */
  cwd: string;
  /** Base ref of the run's change summary. */
  fromRef: string;
  /** Merged tip of the run's change summary. */
  toRef: string;
  config: MutationReportConfig;
  /**
   * The caller's abandonment flag, read immediately before the runner is
   * invoked. Owned by the ship gate's fork wrap: the step never sets it.
   */
  isAbandoned: () => boolean;
  /** Test seam: the declared command. */
  mutationRun?: MutationCommandRunner;
  /**
   * Test seam: the scope derivation, so a test can hold the step *ahead* of
   * the runner invocation and observe the pre-spawn window.
   */
  mutationScope?: () => Promise<readonly string[]>;
}

/**
 * Run the declared mutation command once, scoped to the run's changed source
 * files, and classify what came back.
 *
 * `undefined` means the step was abandoned before it invoked the runner: the
 * caller set its flag, so nothing spawned and there is nothing to publish.
 *
 * The abandonment read sits immediately before the invocation with **no
 * `await` between them**, so no other task can interleave: at the instant the
 * caller's `terminate` runs, either the command is already registered against
 * the worktree and gets quiesced, or the check has not happened yet and will
 * skip the invocation. There is no ordering in which a command spawns after
 * the quiesce that was supposed to stop it.
 */
export async function runMutationStep(
  args: RunMutationStepArgs,
): Promise<MutationStepOutcome | undefined> {
  const files = args.mutationScope
    ? [...(await args.mutationScope())]
    : mutationEligibleSources(
        buildChangeSummary(args.cwd, args.fromRef, args.toRef),
      );

  // No `await` between this read and the invocation below.
  if (args.isAbandoned()) return undefined;
  const run = args.mutationRun ?? defaultMutationRun;
  let started: Promise<string>;
  try {
    started = run(args.config.command, files, {
      cwd: args.cwd,
      encoding: "utf-8",
    });
  } catch (error) {
    return classifyMutationStep({
      exit: { status: "FAILED", detail: describeError(error) },
      deadline: "INSIDE",
    });
  }

  let exit: MutationCommandExit;
  try {
    await started;
    exit = { status: "OK" };
  } catch (error) {
    exit = { status: "FAILED", detail: describeError(error) };
  }
  const outcome = classifyMutationStep({
    exit,
    report:
      exit.status === "OK"
        ? readMutationReport(args.cwd, args.config.reportPath)
        : undefined,
    deadline: "INSIDE",
  });
  return attributeStepOutcome(args.cwd, args.config, outcome);
}

/**
 * Attribute a reported outcome from the two declared paths, under the step's own
 * `cwd` and after the command has exited — so the pre-spawn abandonment window
 * above is untouched (#304 B-09).
 *
 * The reads happen here and nowhere else: a declared path's read result is
 * passed straight through, `ABSENT` included, so the absent-versus-unusable
 * distinction lives only in the readers and this call site probes nothing.
 *
 * A run that declared *neither* path is left exactly as it was, unlabeled: no
 * label is the same fact as `unattributed` (the render derivation substitutes
 * precisely that), so writing one would add a member to every survivor of every
 * run that opted into nothing.
 */
function attributeStepOutcome(
  cwd: string,
  config: MutationReportConfig,
  outcome: MutationStepOutcome | undefined,
): MutationStepOutcome | undefined {
  if (outcome === undefined || outcome.status !== "MUTATION_REPORTED") {
    return outcome;
  }
  if (config.baselinePath === undefined && config.decisionsPath === undefined) {
    return outcome;
  }
  const attributed = attributeMutationSurvivors({
    survivors: outcome.survivors,
    ...(config.baselinePath !== undefined
      ? { baseline: readMutationBaseline(cwd, config.baselinePath) }
      : {}),
    ...(config.decisionsPath !== undefined
      ? { decisions: readMutationDecisions(cwd, config.decisionsPath) }
      : {}),
  });
  return {
    status: "MUTATION_REPORTED",
    survivors: attributed.survivors,
    ...(attributed.notes.length > 0
      ? { attributionNotes: attributed.notes }
      : {}),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The flat bound every exit from the guardian mode fork awaits the step under:
 * thirty minutes, one constant, no option field and no second bound for the
 * rejection exits. A configurable bound is a bound a run can set to zero.
 */
export const MUTATION_STEP_BOUND_MS = 30 * 60 * 1000;

export interface AwaitMutationStepArgs {
  /** The in-flight step. */
  step: Promise<MutationStepOutcome | undefined>;
  /**
   * The instant this exit began, on the same clock `now` reads. The rejoin
   * exit captures it once the guardian results are in hand; each rejection
   * exit captures its own, because the rejoin instant never occurs there.
   */
  origin: number;
  /** Injectable clock. */
  now: () => number;
  /** Injectable timer, so no test waits on a real thirty minutes. */
  delay?: (ms: number) => Promise<void>;
  /**
   * The one termination binding — `quiesceWorktree` on the review worktree.
   * Invoked before the bound-reached outcome is returned, so the worktree
   * holds no live `cwd` when the gate leaves.
   */
  terminate: () => Promise<unknown> | unknown;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    // Unref'd: a pending mutation bound must not be the reason a finished
    // process stays alive.
    setTimeout(resolveDelay, ms).unref?.();
  });
}

/** Sentinel for "the bound fired first" — never a value the step can produce. */
/**
 * Race arms, discriminated rather than sentinel-valued: `undefined` is a real
 * step result (the abandonment return), so the bound arm cannot be represented
 * by any value the step arm could also produce.
 */
type BoundRace =
  | { readonly kind: "settled"; readonly outcome: MutationStepOutcome | undefined }
  | { readonly kind: "bound-reached" };

const BOUND_REACHED: BoundRace = { kind: "bound-reached" };

/**
 * Await the in-flight step under {@link MUTATION_STEP_BOUND_MS}, terminating it
 * when the bound is reached. The one helper every exit calls with the one
 * constant: no exit awaits the step to settlement with no deadline, and no
 * exit carries a second deadline.
 *
 * A step rejection resolves as "no outcome" rather than propagating: this
 * helper runs on paths whose own reason — a guardian's rethrow — must reach the
 * caller unchanged.
 */
export async function awaitMutationStepWithinBound(
  args: AwaitMutationStepArgs,
): Promise<MutationStepOutcome | undefined> {
  const remaining = args.origin + MUTATION_STEP_BOUND_MS - args.now();
  const settled: BoundRace =
    remaining <= 0
      ? BOUND_REACHED
      : await Promise.race<BoundRace>([
          args.step.then(
            (outcome): BoundRace => ({ kind: "settled", outcome }),
            (): BoundRace => ({ kind: "settled", outcome: undefined }),
          ),
          (args.delay ?? defaultDelay)(remaining).then(() => BOUND_REACHED),
        ]);
  if (settled.kind === "bound-reached") {
    // Terminate first, then classify: the outcome says the step did not run,
    // which is only true once nothing of it is still running.
    try {
      await args.terminate();
    } catch {
      // A failed quiesce is reported by the teardown that owns the worktree;
      // it must never replace this exit's own reason.
    }
    return { status: "MUTATION_NOT_RUN", reason: "BOUND_REACHED" };
  }
  return settled.outcome;
}

/** The one heading both `run-summary.md` and the draft PR body render. */
export const MUTATION_REPORT_HEADING =
  "## Mutation survivors (reported, never blocking)";

/**
 * The one line each attribution note renders, so a degradation reads the same in
 * `run-summary.md` and in the draft PR body. Each says what was lost and that
 * nothing was gated on it — a degraded artifact costs attribution, never an
 * outcome (#304 B-08/B-10).
 */
const ATTRIBUTION_NOTE_LINES: Record<MutationAttributionNote, string> = {
  BASELINE_UNUSABLE:
    "- Attribution degraded: `BASELINE_UNUSABLE` — the declared baseline was " +
    "there but could not be read or parsed, so every survivor above is " +
    "`unattributed`. Nothing was gated on this (ADR 0063).",
  DECISIONS_UNUSABLE:
    "- Attribution degraded: `DECISIONS_UNUSABLE` — the declared decisions " +
    "file was there but could not be read or parsed, so no survivor above is " +
    "marked `accepted`. Nothing was gated on this (ADR 0063).",
};

/**
 * The report text, from one formatter, so the run summary and the PR body
 * cannot disagree about what survived.
 *
 * The empty-survivor case renders its own line: a section that fell silent
 * when nothing survived could not be told from a step that never ran.
 *
 * Each survivor's bullet ends with its label when it carries one, and each
 * attribution note gets one line of its own (#304 B-10). An unlabeled survivor
 * renders exactly as it did before this slice: the render derivation is what
 * substitutes `unattributed` for a record that predates labels, so nothing is
 * invented here.
 */
export function formatMutationReportLines(report: {
  status: "MUTATION_REPORTED" | "MUTATION_NOT_RUN";
  reason?: MutationNotRunReason;
  survivors: readonly MutationSurvivor[];
  attributionNotes?: readonly MutationAttributionNote[];
}): string[] {
  if (report.status === "MUTATION_NOT_RUN") {
    // A record with no reason is reachable from disk — `reason` is optional on
    // both the event payload and the state record — and substituting a concrete
    // one would make the summary and the PR body state a reason the run never
    // observed. Say the reason is missing instead of inventing one.
    return [
      report.reason === undefined
        ? "- Not run: reason not recorded — no survivor list was produced. " +
          "Nothing was gated on this (ADR 0063)."
        : `- Not run: \`${report.reason}\` — no survivor list was produced. ` +
          "Nothing was gated on this (ADR 0063).",
    ];
  }
  const noteLines = (report.attributionNotes ?? []).map(
    (note) => ATTRIBUTION_NOTE_LINES[note],
  );
  if (report.survivors.length === 0) {
    return ["- No surviving mutants in the changed source files.", ...noteLines];
  }
  return [
    ...report.survivors.map(
      (survivor) =>
        `- \`${survivor.id}\` ${survivor.file}:${survivor.position.startLine}:` +
        `${survivor.position.startColumn} — ${survivor.mutator}` +
        (survivor.label === undefined ? "" : ` — ${survivor.label}`),
    ),
    ...noteLines,
  ];
}
