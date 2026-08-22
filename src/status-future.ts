/**
 * `afk status` future section (spec #30) — answers "what comes next
 * and what unblocks what?". Read-only over the run directory's events,
 * the persisted run state (`.afk/state/<runSlug>.json`), and the
 * issues DAG (`.kiro/specs/<prd-slug>/issues.md`).
 *
 * Derivation:
 * - A slice is done when events carry a terminal PASS slice-outcome
 *   for it, or persisted state says PASS + mergedToFeature. Failure
 *   outcomes (STUCK/ESCALATE/ERROR/CONFLICT/CANCELLED/LANE-CANCELLED)
 *   and the deferred-merge outcome (MERGE-PENDING) are terminal for this
 *   run too — the slice is not pending work, but it never unblocks
 *   dependents (only `completed` unblocks — the PRD 012 run-1 contract).
 * - Remaining phases per pending slice: the fixed agent sequence
 *   explorer → planner → evaluator-contract → generator → evaluator-qa
 *   minus the agents with a phase-ended event. A slice with no events
 *   has the whole sequence ahead.
 * - Upcoming waves: simulate `buildDAG(...).ready(done)` from the
 *   current completed set, dispatching each projected wave into `done`
 *   until nothing new becomes ready. Slices held by failed or HITL
 *   blockers never enter a wave and render "waits on #NN".
 * - HITL slices are skipped by the pipeline — shown as skipped, never
 *   as pending work.
 *
 * When issues.md is absent the section degrades gracefully: pending
 * slices and remaining phases derive from events alone, wave
 * projection is skipped, and a note explains why — never throws.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunEvent } from "./run-events.js";
import { parseIssuesMd, buildDAG, type Slice } from "./issues-parser.js";
import { loadRunState } from "./run-state.js";

/** The fixed per-slice agent sequence (CONTEXT.md, "Relationships"). */
export const AGENT_SEQUENCE = [
  "explorer",
  "planner",
  "evaluator-contract",
  "generator",
  "evaluator-qa",
] as const;

/** Why an unresolved blocker still blocks. */
export interface FutureBlockerRef {
  ghIssue: string;
  /**
   * "pending" | "in flight" | "HITL" | a failure phase (e.g. "STUCK") |
   * the deferred-merge annotation. A failure phase or "HITL" means the
   * blocker will not resolve without human intervention; MERGE-PENDING
   * says the opposite — the next run retries its merge unattended.
   */
  status: string;
}

export interface FuturePendingSlice {
  ghIssue: string;
  /** "" when unknown (issues.md missing and events carry no title). */
  title: string;
  /** Agents from the fixed sequence still ahead, in order. */
  remainingPhases: string[];
  /** True when this run already has phase events for the slice. */
  inFlight: boolean;
  /** Unresolved blockers this slice waits on (empty when ready). */
  waitsOn: FutureBlockerRef[];
}

export interface FutureWave {
  /** Absolute wave number, continuing the run's dispatched count. */
  wave: number;
  /** GH issue numbers projected to dispatch together. */
  slices: string[];
}

/** Lane composition of the current wave (ADR 0005), when known. */
export interface FutureLanes {
  wave: number;
  /** Lanes run in parallel; within a lane, slices run serially in order. */
  lanes: string[][];
  serial: boolean;
}

/** JSON-serializable — `--json` embeds it verbatim. */
export interface FutureSection {
  pending: FuturePendingSlice[];
  /** Projected waves; empty when the DAG is unavailable. */
  upcomingWaves: FutureWave[];
  /**
   * Lane composition of the latest dispatched wave, from the
   * lanes-partitioned event — null before contracts lock or for runs
   * that predate the event.
   */
  currentLanes: FutureLanes | null;
  /** HITL slices the pipeline skips. */
  skipped: { ghIssue: string; title: string }[];
  /** Degradation notes (e.g. issues.md missing). */
  notes: string[];
}

/**
 * Phases that end a slice's work for this run. `MERGE-PENDING` belongs
 * here even though it needs no human: this run will not touch the slice
 * again, and it never unblocks dependents (nothing of its work is on the
 * feature branch yet). The blocker annotation below says which of the two
 * it is, so "wait for the next run" doesn't read like "go fix something".
 */
const TERMINAL_THIS_RUN_PHASES = new Set([
  "STUCK",
  "ESCALATE",
  "ERROR",
  "CONFLICT",
  "MERGE-PENDING",
  "CANCELLED",
  "LANE-CANCELLED",
]);

/** Per-slice facts distilled from the event stream. */
interface EventFacts {
  runSlug?: string;
  provider?: string;
  maxDispatchedWave: number;
  dispatched: Set<string>;
  /** Agents with a phase-ended event, per slice. */
  endedAgents: Map<string, Set<string>>;
  /** Slices with any phase-started/-ended event. */
  hasPhaseEvents: Set<string>;
  /** Last slice-outcome phase per slice. */
  outcomePhase: Map<string, string>;
  /** Titles gleaned from slice-outcome events. */
  titles: Map<string, string>;
  /** blockedBy carried on not-run-hold warns, per slice. */
  warnBlockedBy: Map<string, string[]>;
  /** Every slice reference seen anywhere in the stream. */
  seenSlices: Set<string>;
  /** Latest lanes-partitioned event, if any. */
  currentLanes: FutureLanes | null;
}

function distillEvents(events: RunEvent[]): EventFacts {
  const facts: EventFacts = {
    maxDispatchedWave: 0,
    dispatched: new Set(),
    endedAgents: new Map(),
    hasPhaseEvents: new Set(),
    outcomePhase: new Map(),
    titles: new Map(),
    warnBlockedBy: new Map(),
    seenSlices: new Set(),
    currentLanes: null,
  };
  for (const event of events) {
    switch (event.type) {
      case "run-started":
        facts.runSlug = event.runSlug;
        facts.provider = event.provider;
        break;
      case "lanes-partitioned":
        facts.currentLanes = {
          wave: event.wave,
          lanes: event.lanes,
          serial: event.serial === true,
        };
        for (const lane of event.lanes) {
          for (const s of lane) facts.seenSlices.add(s);
        }
        break;
      case "wave-dispatched":
        facts.maxDispatchedWave = Math.max(facts.maxDispatchedWave, event.wave);
        for (const s of event.slices) {
          facts.dispatched.add(s);
          facts.seenSlices.add(s);
        }
        break;
      case "phase-started":
        facts.hasPhaseEvents.add(event.ghIssue);
        facts.seenSlices.add(event.ghIssue);
        break;
      case "phase-ended": {
        facts.hasPhaseEvents.add(event.ghIssue);
        facts.seenSlices.add(event.ghIssue);
        const agents = facts.endedAgents.get(event.ghIssue) ?? new Set();
        agents.add(event.agent);
        facts.endedAgents.set(event.ghIssue, agents);
        break;
      }
      case "slice-outcome":
        facts.outcomePhase.set(event.slice.ghIssue, event.slice.phase);
        facts.titles.set(event.slice.ghIssue, event.slice.title);
        facts.seenSlices.add(event.slice.ghIssue);
        break;
      case "warn":
        if (event.ghIssue !== undefined) {
          facts.seenSlices.add(event.ghIssue);
          if (event.reason === "not-run-hold" && event.blockedBy) {
            facts.warnBlockedBy.set(event.ghIssue, event.blockedBy);
          }
        }
        break;
      default:
        break;
    }
  }
  return facts;
}

/** PRD slug = runSlug with the trailing `-<provider>` stripped. */
export function prdSlugFromRunSlug(runSlug: string, provider: string): string {
  const suffix = `-${provider}`;
  return runSlug.endsWith(suffix)
    ? runSlug.slice(0, runSlug.length - suffix.length)
    : runSlug;
}

function remainingPhasesFor(facts: EventFacts, ghIssue: string): string[] {
  const ended = facts.endedAgents.get(ghIssue);
  return AGENT_SEQUENCE.filter((agent) => !ended?.has(agent));
}

export function buildFutureSection(input: {
  repoRoot: string;
  runDir: string;
  events: RunEvent[];
}): FutureSection {
  const facts = distillEvents(input.events);
  const notes: string[] = [];

  // --- completed set: terminal PASS events + persisted PASS+merged ---
  const completed = new Set<string>();
  for (const [ghIssue, phase] of facts.outcomePhase) {
    if (phase === "PASS") completed.add(ghIssue);
  }
  if (facts.runSlug !== undefined) {
    // loadRunState returns a fresh empty state when the file is absent.
    const state = loadRunState(input.repoRoot, facts.runSlug);
    for (const [ghIssue, s] of Object.entries(state.slices)) {
      if (s.phase === "PASS" && s.mergedToFeature === true) {
        completed.add(ghIssue);
      }
    }
  } else {
    notes.push(
      "no run-started event — cannot locate issues.md or persisted state; " +
        "future derived from run events only",
    );
  }

  // --- the issues DAG, when reachable ---
  let manifest: Slice[] | null = null;
  if (facts.runSlug !== undefined && facts.provider !== undefined) {
    const prdSlug = prdSlugFromRunSlug(facts.runSlug, facts.provider);
    const issuesPath = join(
      input.repoRoot,
      ".kiro",
      "specs",
      prdSlug,
      "issues.md",
    );
    if (existsSync(issuesPath)) {
      try {
        manifest = parseIssuesMd(issuesPath);
      } catch (e) {
        notes.push(
          `issues.md at ${issuesPath} could not be parsed (${e instanceof Error ? e.message : String(e)}) — future derived from run events only`,
        );
      }
    } else {
      notes.push(
        `issues.md not found at ${issuesPath} — future derived from run events only`,
      );
    }
  }

  /** Phase that ended a slice's work this run, if any. */
  const failurePhaseOf = (ghIssue: string): string | undefined => {
    const phase = facts.outcomePhase.get(ghIssue);
    return phase !== undefined && TERMINAL_THIS_RUN_PHASES.has(phase)
      ? phase
      : undefined;
  };

  const hitl = new Set<string>();
  if (manifest) {
    for (const s of manifest) if (s.type === "HITL") hitl.add(s.ghIssue);
  }
  for (const [ghIssue, phase] of facts.outcomePhase) {
    if (phase === "SKIPPED") hitl.add(ghIssue);
  }

  /** Why a blocker still blocks, for waitsOn annotations. */
  const blockerStatus = (ghIssue: string): string => {
    const failure = failurePhaseOf(ghIssue);
    if (failure === "MERGE-PENDING") {
      return "MERGE-PENDING — the next run retries the merge";
    }
    if (failure !== undefined) return failure;
    if (hitl.has(ghIssue)) return "HITL";
    if (facts.hasPhaseEvents.has(ghIssue)) return "in flight";
    return "pending";
  };

  const pending: FuturePendingSlice[] = [];
  const skipped: { ghIssue: string; title: string }[] = [];
  const upcomingWaves: FutureWave[] = [];

  if (manifest) {
    for (const slice of manifest) {
      const id = slice.ghIssue;
      if (slice.type === "HITL") {
        skipped.push({ ghIssue: id, title: slice.title });
        continue;
      }
      if (completed.has(id)) continue;
      if (failurePhaseOf(id) !== undefined) continue; // terminal this run
      pending.push({
        ghIssue: id,
        title: slice.title,
        remainingPhases: remainingPhasesFor(facts, id),
        inFlight: facts.hasPhaseEvents.has(id),
        waitsOn: slice.blockedBy
          .filter((dep) => !completed.has(dep))
          .map((dep) => ({ ghIssue: dep, status: blockerStatus(dep) })),
      });
    }

    // --- wave projection: simulate the DAG from the completed set ---
    const dag = buildDAG(manifest);
    const pendingIds = new Set(pending.map((p) => p.ghIssue));
    const simDone = new Set(completed);
    let waveNo = facts.maxDispatchedWave + 1;
    let first = true;
    while (true) {
      const ready = dag.ready(simDone).filter((id) => pendingIds.has(id));
      if (ready.length === 0) break;
      if (first) {
        // A first projected group containing already-dispatched slices
        // is the current wave, still in flight — keep its number.
        if (
          facts.maxDispatchedWave > 0 &&
          ready.some((id) => facts.dispatched.has(id))
        ) {
          waveNo = facts.maxDispatchedWave;
        }
        first = false;
      }
      upcomingWaves.push({ wave: waveNo, slices: ready });
      for (const id of ready) simDone.add(id);
      waveNo++;
    }
  } else {
    // Degraded mode: derive pending slices from the event stream alone.
    for (const id of facts.seenSlices) {
      if (completed.has(id)) continue;
      if (failurePhaseOf(id) !== undefined) continue;
      if (hitl.has(id)) {
        skipped.push({ ghIssue: id, title: facts.titles.get(id) ?? "" });
        continue;
      }
      pending.push({
        ghIssue: id,
        title: facts.titles.get(id) ?? "",
        remainingPhases: remainingPhasesFor(facts, id),
        inFlight: facts.hasPhaseEvents.has(id),
        waitsOn: (facts.warnBlockedBy.get(id) ?? [])
          .filter((dep) => !completed.has(dep))
          .map((dep) => ({ ghIssue: dep, status: blockerStatus(dep) })),
      });
    }
  }

  return {
    pending,
    upcomingWaves,
    currentLanes: facts.currentLanes,
    skipped,
    notes,
  };
}

function renderBlockers(waitsOn: FutureBlockerRef[]): string {
  return waitsOn
    .map((b) => `waits on #${b.ghIssue} (${b.status})`)
    .join(", ");
}

/**
 * Indented lines for the future section, no trailing newlines. The
 * coordinator prints the section header; these lines sit under it at
 * two-space indent (group labels) and four-space indent (items),
 * matching the existing renderer's style.
 */
export function renderFutureSection(future: FutureSection): string[] {
  const lines: string[] = [];

  for (const note of future.notes) {
    lines.push(`  note: ${note}`);
  }

  if (future.pending.length === 0) {
    lines.push("  (nothing pending — no slices ahead)");
  } else {
    lines.push("  Remaining phases:");
    for (const slice of future.pending) {
      const title = slice.title !== "" ? ` ${slice.title}` : "";
      const phases =
        slice.remainingPhases.length > 0
          ? slice.remainingPhases.join(" → ")
          : "all phases done — awaiting outcome";
      const waits =
        slice.waitsOn.length > 0 ? ` — ${renderBlockers(slice.waitsOn)}` : "";
      lines.push(`    #${slice.ghIssue}${title} — ${phases}${waits}`);
    }
  }

  if (future.upcomingWaves.length > 0) {
    lines.push("  Upcoming waves:");
    for (const wave of future.upcomingWaves) {
      lines.push(
        `    wave ${wave.wave}: ${wave.slices.map((s) => `#${s}`).join(", ")}`,
      );
    }
  }

  if (future.currentLanes !== null) {
    const { wave, lanes, serial } = future.currentLanes;
    lines.push(
      `  Lanes (wave ${wave}${serial ? ", serial" : ""}): ${lanes
        .map((lane) => `[${lane.map((s) => `#${s}`).join(" → ")}]`)
        .join(" ")}`,
    );
  }

  // Pending slices that never enter a projected wave are held by a
  // blocker that won't resolve on its own (failed or HITL).
  const scheduled = new Set(future.upcomingWaves.flatMap((w) => w.slices));
  const held = future.pending.filter(
    (p) => !scheduled.has(p.ghIssue) && p.waitsOn.length > 0,
  );
  if (held.length > 0 && future.upcomingWaves.length > 0) {
    // In degraded mode (no waves) waitsOn already shows inline above.
    for (const slice of held) {
      lines.push(
        `    held: #${slice.ghIssue} — ${renderBlockers(slice.waitsOn)}`,
      );
    }
  } else if (held.length > 0 && future.notes.length === 0) {
    lines.push("  Held (no schedulable waves):");
    for (const slice of held) {
      lines.push(
        `    #${slice.ghIssue} — ${renderBlockers(slice.waitsOn)}`,
      );
    }
  }

  if (future.skipped.length > 0) {
    lines.push("  Skipped (HITL):");
    for (const slice of future.skipped) {
      const title = slice.title !== "" ? ` ${slice.title}` : "";
      lines.push(`    #${slice.ghIssue}${title}`);
    }
  }

  return lines;
}
