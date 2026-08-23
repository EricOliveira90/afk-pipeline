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
 * - Upcoming waves come from the RunSnapshot module's projection of the
 *   current completed set. Slices held by failed or HITL blockers never
 *   enter a wave and render "waits on #NN".
 * - HITL slices are skipped by the pipeline — shown as skipped, never
 *   as pending work.
 *
 * When issues.md is absent the section degrades gracefully: pending
 * slices and remaining phases derive from events alone, wave
 * projection is skipped, and a note explains why — never throws.
 */
import type { Slice } from "./issues-parser.js";
import {
  projectUpcomingWaves,
  type RunSnapshot,
  type SnapshotSlice,
} from "./run-snapshot.js";
import { isSlicePhase, traitsFor } from "./slice-lifecycle.js";

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

export type ManifestReadResult =
  | { status: "available"; slices: Slice[] }
  | { status: "missing"; path: string }
  | { status: "invalid"; path: string; error: string }
  | { status: "unavailable" };

/** PRD slug = runSlug with the trailing `-<provider>` stripped. */
export function prdSlugFromRunSlug(runSlug: string, provider: string): string {
  const suffix = `-${provider}`;
  return runSlug.endsWith(suffix)
    ? runSlug.slice(0, runSlug.length - suffix.length)
    : runSlug;
}

function remainingPhasesFor(slice: SnapshotSlice | undefined): string[] {
  const ended = new Set(
    slice?.invocations
      .filter((invocation) => invocation.endedTs !== undefined)
      .map((invocation) => invocation.agent) ?? [],
  );
  return AGENT_SEQUENCE.filter((agent) => !ended.has(agent));
}

export function buildFutureSection(input: {
  snapshot: RunSnapshot;
  manifest: ManifestReadResult;
}): FutureSection {
  const { snapshot } = input;
  const notes: string[] = [];
  const manifest =
    input.manifest.status === "available" ? input.manifest.slices : null;

  if (snapshot.run.slug === undefined) {
    notes.push(
      "no run-started event — cannot locate issues.md or persisted state; " +
        "future derived from run events only",
    );
  } else if (input.manifest.status === "missing") {
    notes.push(
      `issues.md not found at ${input.manifest.path} — future derived from run events only`,
    );
  } else if (input.manifest.status === "invalid") {
    notes.push(
      `issues.md at ${input.manifest.path} could not be parsed (${input.manifest.error}) — future derived from run events only`,
    );
  }

  // --- completed set: terminal PASS events + persisted PASS+merged ---
  const completed = new Set<string>();
  for (const [ghIssue, slice] of Object.entries(snapshot.slices)) {
    const outcome = slice.outcome;
    if (
      outcome?.phase === "PASS" &&
      (outcome.source === "event" || outcome.mergedToFeature === true)
    ) {
      completed.add(ghIssue);
    }
  }

  /** Phase that ended a slice's work this run, if any. */
  const terminalPhaseOf = (ghIssue: string): string | undefined => {
    const phase = snapshot.slices[ghIssue]?.outcome?.phase;
    return phase !== undefined &&
      isSlicePhase(phase) &&
      traitsFor(phase).terminalThisRun &&
      phase !== "PASS" &&
      phase !== "SKIPPED"
      ? phase
      : undefined;
  };

  const hitl = new Set<string>();
  if (manifest) {
    for (const s of manifest) if (s.type === "HITL") hitl.add(s.ghIssue);
  }
  for (const [ghIssue, slice] of Object.entries(snapshot.slices)) {
    if (slice.outcome?.phase === "SKIPPED") hitl.add(ghIssue);
  }

  /** Why a blocker still blocks, for waitsOn annotations. */
  const blockerStatus = (ghIssue: string): string => {
    const terminal = terminalPhaseOf(ghIssue);
    if (terminal === "MERGE-PENDING") {
      return "MERGE-PENDING — the next run retries the merge";
    }
    if (terminal !== undefined) return terminal;
    if (hitl.has(ghIssue)) return "HITL";
    if ((snapshot.slices[ghIssue]?.invocations.length ?? 0) > 0) {
      return "in flight";
    }
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
      if (terminalPhaseOf(id) !== undefined) continue; // terminal this run
      pending.push({
        ghIssue: id,
        title: slice.title,
        remainingPhases: remainingPhasesFor(snapshot.slices[id]),
        inFlight: (snapshot.slices[id]?.invocations.length ?? 0) > 0,
        waitsOn: slice.blockedBy
          .filter((dep) => !completed.has(dep))
          .map((dep) => ({ ghIssue: dep, status: blockerStatus(dep) })),
      });
    }

    upcomingWaves.push(...projectUpcomingWaves(snapshot, manifest));
  } else {
    // Degraded mode: derive pending slices from the event stream alone.
    for (const id of snapshot.sliceOrder) {
      if (completed.has(id)) continue;
      if (terminalPhaseOf(id) !== undefined) continue;
      if (hitl.has(id)) {
        skipped.push({ ghIssue: id, title: snapshot.slices[id]?.title ?? "" });
        continue;
      }
      pending.push({
        ghIssue: id,
        title: snapshot.slices[id]?.title ?? "",
        remainingPhases: remainingPhasesFor(snapshot.slices[id]),
        inFlight: (snapshot.slices[id]?.invocations.length ?? 0) > 0,
        waitsOn: (snapshot.slices[id]?.blockedBy ?? [])
          .filter((dep) => !completed.has(dep))
          .map((dep) => ({ ghIssue: dep, status: blockerStatus(dep) })),
      });
    }
  }

  return {
    pending,
    upcomingWaves,
    currentLanes: snapshot.currentLanes,
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
