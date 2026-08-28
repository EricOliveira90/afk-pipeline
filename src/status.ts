/**
 * `afk status` (spec #26) — a one-shot, read-only view over a run
 * directory's `events.jsonl`. Renders one chronological pipeline log;
 * `--json` emits the same model the renderer consumes. Never writes.
 *
 * Run selection: `--run <dir>` renders a specific run directory
 * (absolute or repo-relative). With no arguments, auto-detects the
 * most recently active PRD's latest run directory under `.afk/logs/`
 * (run directory names encode their start time — ADR 0017 — so
 * lexicographic order is chronological order) and announces which
 * run it picked.
 */
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseIssuesMd } from "./issues-parser.js";
import { readRunEvents, type RunEvent } from "./run-events.js";
import { loadRunState } from "./run-state.js";
import { foldEvents, type RunSnapshot } from "./run-snapshot.js";
import {
  buildFutureSection,
  prdSlugFromRunSlug,
  renderFutureSection,
  type FutureSection,
  type ManifestReadResult,
} from "./status-future.js";
import {
  buildPresentSection,
  formatDuration,
  readAgentLogActivity,
  renderPresentSection,
  type PresentSection,
} from "./status-present.js";
import {
  buildPipelineSection,
  type PipelineSection,
} from "./status-pipeline.js";

/** The model the renderer consumes; `--json` emits it verbatim. */
export interface StatusModel {
  schemaVersion: number;
  runDir: string;
  events: RunEvent[];
  /** What is running right now, with derived liveness (spec #32). */
  present: PresentSection;
  /** What comes next and what unblocks what (spec #30). */
  future: FutureSection;
  /** Wave/lane/round projection consumed by the web dashboard. */
  pipeline: PipelineSection;
}

export interface StatusResult {
  output: string;
  exitCode: number;
}

const RUN_DIR_RE = /^run-\d{8}-\d{6}/;

/** Log-directory names under `.afk/logs` — one per PRD slug + provider. */
export function listLogSlugs(repoRoot: string): string[] {
  const logsDir = join(repoRoot, ".afk", "logs");
  if (!existsSync(logsDir)) return [];
  return readdirSync(logsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Latest run directory across all PRD slugs. "Most recently active
 * PRD" = the PRD owning the chronologically newest run directory.
 *
 * `matchSlug` narrows the search to log directories it accepts, so a
 * caller addressing one PRD (`afk stop <slug>`) gets the same
 * lexicographic-is-chronological selection rather than its own copy of
 * it. Absent, every slug is in scope — the zero-arg `afk status` case.
 */
export function findLatestRunDir(
  repoRoot: string,
  options: { matchSlug?: (logSlug: string) => boolean } = {},
): string | null {
  const logsDir = join(repoRoot, ".afk", "logs");
  if (!existsSync(logsDir)) return null;
  let best: { name: string; path: string } | null = null;
  for (const slug of readdirSync(logsDir, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue;
    if (options.matchSlug && !options.matchSlug(slug.name)) continue;
    const slugDir = join(logsDir, slug.name);
    for (const entry of readdirSync(slugDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !RUN_DIR_RE.test(entry.name)) continue;
      if (!best || entry.name > best.name) {
        best = { name: entry.name, path: join(slugDir, entry.name) };
      }
    }
  }
  return best?.path ?? null;
}

function readManifest(
  repoRoot: string,
  snapshot: RunSnapshot,
): ManifestReadResult {
  const { slug, provider } = snapshot.run;
  if (slug === undefined || provider === undefined) {
    return { status: "unavailable" };
  }
  const prdSlug = prdSlugFromRunSlug(slug, provider);
  const path = join(repoRoot, ".kiro", "specs", prdSlug, "issues.md");
  if (!existsSync(path)) return { status: "missing", path };
  try {
    return { status: "available", slices: parseIssuesMd(path) };
  } catch (error) {
    return {
      status: "invalid",
      path,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Build the status model from a run directory, or explain why not. */
export function buildStatusModel(
  runDir: string,
  repoRoot: string,
):
  | { ok: true; model: StatusModel; snapshot: RunSnapshot }
  | { ok: false; message: string } {
  const parsed = readRunEvents(runDir);
  if (parsed === null) {
    return {
      ok: false,
      message: `No events.jsonl in ${runDir} — this run predates events.jsonl.`,
    };
  }
  const now = new Date();
  const started = parsed.events.find((event) => event.type === "run-started");
  const runState =
    started?.type === "run-started"
      ? loadRunState(repoRoot, started.runSlug)
      : undefined;
  const snapshot = foldEvents(parsed.events, runState);
  const manifest = readManifest(repoRoot, snapshot);
  const present = buildPresentSection({
    snapshot,
    activity: readAgentLogActivity(runDir, snapshot),
    now,
  });
  const future = buildFutureSection({
    snapshot,
    manifest,
  });
  return {
    ok: true,
    snapshot,
    model: {
      schemaVersion: parsed.version,
      runDir,
      events: parsed.events,
      present,
      future,
      pipeline: buildPipelineSection({
        snapshot,
        manifest,
        present,
        future,
        now,
      }),
    },
  };
}

/** hh:mm:ss slice of an ISO timestamp, for compact chronology lines. */
function clock(ts: string): string {
  return ts.length >= 19 ? ts.slice(11, 19) : ts;
}

export function renderStatus(model: StatusModel, snapshot: RunSnapshot): string {
  const lines: string[] = [];
  lines.push(`Run: ${model.runDir}`);
  lines.push("");
  lines.push("Past:");
  let any = false;
  for (const entry of snapshot.chronology) {
    switch (entry.type) {
      case "run-started": {
        const { event } = entry;
        any = true;
        lines.push(`  ${clock(event.ts)}  run started (${event.provider})`);
        break;
      }
      case "wave-dispatched": {
        const { event } = entry;
        any = true;
        lines.push(
          `  ${clock(event.ts)}  wave ${event.wave} dispatched — ${event.slices.length} slice(s): ${event.slices.map((s) => `#${s}`).join(", ")}`,
        );
        break;
      }
      case "phase-ended": {
        const { event } = entry;
        any = true;
        const duration =
          entry.durationMs !== undefined
            ? ` — ${formatDuration(entry.durationMs)}`
            : "";
        const round = event.round !== undefined ? ` (round ${event.round})` : "";
        const verdict = event.verdict ? ` — ${event.verdict}` : "";
        lines.push(
          `  ${clock(event.ts)}  #${event.ghIssue} ${event.agent}${round}${duration}${verdict}`,
        );
        break;
      }
      case "warn": {
        const { event } = entry;
        any = true;
        // Warn lines carry a marker so failure signals stand out from
        // the phase chronology around them. Producers may already
        // prefix the slice reference into the message — don't double it.
        const prefix =
          event.ghIssue !== undefined &&
          !event.message.startsWith(`#${event.ghIssue} `)
            ? `#${event.ghIssue} `
            : "";
        lines.push(`  ${clock(event.ts)}  ⚠ ${prefix}${event.message}`);
        break;
      }
      case "slice-outcome": {
        const { event } = entry;
        any = true;
        const s = event.slice;
        const reason =
          "error" in s && s.error ? ` — ${s.error}` : "";
        // A deferred merge names its colliding prefixes explicitly: they
        // are the fact the operator acts on (or decides not to), and they
        // shouldn't have to be read out of the reason prose.
        const prefixes =
          s.phase === "MERGE-PENDING" && s.collidingPrefixes.length > 0
            ? ` (colliding prefixes: ${s.collidingPrefixes.join(", ")})`
            : "";
        lines.push(
          `  ${clock(event.ts)}  #${s.ghIssue} ${s.title}: ${s.phase}${prefixes}${reason}`,
        );
        break;
      }
    }
  }
  if (!any) lines.push("  (no events)");
  lines.push("");
  lines.push("Present:");
  lines.push(...renderPresentSection(model.present));
  lines.push("");
  lines.push("Future:");
  lines.push(...renderFutureSection(model.future));
  return lines.join("\n");
}

/**
 * Entry point for the `afk status` subcommand. Pure over the
 * filesystem: run directory (`--run <dir>` or auto-detected under
 * `repoRoot`) in, rendered text / JSON out. Read-only by
 * construction. `exitCode !== 0` marks `output` as error text the
 * caller should route to stderr.
 */
export function runStatus(args: readonly string[], repoRoot: string): StatusResult {
  const json = args.includes("--json");

  // Post-mortem selection (#31): `--run <dir>` renders a specific run
  // directory and bypasses auto-detect. Relative paths resolve
  // against repoRoot.
  let runDir: string;
  let autoDetected = false;
  const runFlagIdx = args.indexOf("--run");
  if (runFlagIdx !== -1) {
    const value = args[runFlagIdx + 1];
    if (value === undefined || value.startsWith("--")) {
      return { output: "--run requires a run directory argument.", exitCode: 1 };
    }
    runDir = isAbsolute(value) ? value : resolve(repoRoot, value);
    if (!existsSync(runDir)) {
      return { output: `Run directory not found: ${runDir}`, exitCode: 1 };
    }
  } else {
    const logsDir = join(repoRoot, ".afk", "logs");
    if (!existsSync(logsDir)) {
      return {
        output: `No .afk/logs directory under ${repoRoot} — has a pipeline run happened here?`,
        exitCode: 1,
      };
    }
    const latest = findLatestRunDir(repoRoot);
    if (latest === null) {
      return {
        output: `No run directories found under ${logsDir} — the PRD folders there contain no run-<timestamp> directories.`,
        exitCode: 1,
      };
    }
    runDir = latest;
    autoDetected = true;
  }

  const built = buildStatusModel(runDir, repoRoot);
  if (!built.ok) {
    return { output: built.message, exitCode: 1 };
  }

  if (json) {
    // A single valid JSON document — the model already carries
    // runDir, so no prose announcement line.
    return { output: JSON.stringify(built.model, null, 2), exitCode: 0 };
  }

  const view = renderStatus(built.model, built.snapshot);
  return {
    output: autoDetected
      ? `Auto-detected latest run: ${runDir}\n\n${view}`
      : view,
    exitCode: 0,
  };
}
