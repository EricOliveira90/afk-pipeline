import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseIssuesMd, type Slice } from "./issues-parser.js";
import type { RunEvent } from "./run-events.js";
import { prdSlugFromRunSlug, type FutureSection } from "./status-future.js";
import type { PresentSection } from "./status-present.js";

export type PipelineState =
  | "done"
  | "active"
  | "queued"
  | "blocked"
  | "failed"
  | "unknown";

export interface PipelineInvocation {
  agent: string;
  round?: number;
  attempt?: number;
  state: PipelineState;
  startedTs?: string;
  endedTs?: string;
  elapsedMs?: number;
  verdict?: string;
  cached?: boolean;
  stale?: boolean;
}

export interface PipelineRound {
  round: number;
  primary?: PipelineInvocation;
  evaluator?: PipelineInvocation;
  primaryInvocations: PipelineInvocation[];
  evaluatorInvocations: PipelineInvocation[];
}

export interface PipelineSlice {
  ghIssue: string;
  number: string;
  title: string;
  state: PipelineState;
  waitsOn: string[];
  explorer?: PipelineInvocation;
  contractRounds: PipelineRound[];
  implementationRounds: PipelineRound[];
  outcome?: string;
}

export interface PipelineLane {
  lane: number;
  slices: PipelineSlice[];
}

export interface PipelineWave {
  wave: number;
  projected: boolean;
  state: PipelineState;
  startedTs?: string;
  endedTs?: string;
  elapsedMs?: number;
  lanes: PipelineLane[];
}

export interface PipelineAggregateStage {
  id: "sanity" | "architect-review" | "pm-review" | "draft-pr";
  label: string;
  state: PipelineState;
  attempts: PipelineInvocation[];
  verdict?: string;
}

export interface PipelineSection {
  run: {
    slug?: string;
    provider?: string;
    state: PipelineState;
    startedTs?: string;
    endedTs?: string;
    elapsedMs?: number;
    contractRoundLimit?: number;
    implementationRoundLimit?: number;
    outcome?: string;
  };
  waves: PipelineWave[];
  aggregateStages: PipelineAggregateStage[];
  notes: string[];
}

interface InvocationBuilder {
  invocation: PipelineInvocation;
  startMs?: number;
}

const FAILURE_OUTCOMES = new Set([
  "STUCK",
  "ESCALATE",
  "ERROR",
  "CONFLICT",
  "CANCELLED",
  "LANE-CANCELLED",
]);

function elapsed(startTs: string | undefined, endTs: string | undefined, now: number) {
  if (!startTs) return undefined;
  const start = Date.parse(startTs);
  const end = endTs ? Date.parse(endTs) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.max(0, end - start);
}

function invocationKey(input: {
  ghIssue: string;
  agent: string;
  round?: number;
}): string {
  return `${input.ghIssue}|${input.agent}|${input.round ?? ""}`;
}

function manifestFor(
  repoRoot: string,
  events: RunEvent[],
  notes: string[],
): Slice[] {
  const started = events.find((event) => event.type === "run-started");
  if (!started || started.type !== "run-started") return [];
  const slug = prdSlugFromRunSlug(started.runSlug, started.provider);
  const path = join(repoRoot, ".kiro", "specs", slug, "issues.md");
  if (!existsSync(path)) {
    notes.push("issues.md is unavailable; titles and projected dependencies may be unknown");
    return [];
  }
  try {
    return parseIssuesMd(path);
  } catch {
    notes.push("issues.md could not be parsed; the matrix uses observed events only");
    return [];
  }
}

function invocationState(invocation: PipelineInvocation): PipelineState {
  if (!invocation.endedTs) return "active";
  const verdict = invocation.verdict?.toUpperCase();
  return verdict && [
    "FAIL",
    "FAILED",
    "ERROR",
    "ESCALATE",
    "IMPLEMENTATION",
    "FIX-BEFORE-SHIP",
    "NEVER_RAN",
    "DIED_MID_RUN",
    "UNPARSEABLE",
  ].includes(verdict)
    ? "failed"
    : "done";
}

function buildSliceInvocations(
  events: RunEvent[],
  present: PresentSection,
  now: number,
): Map<string, PipelineInvocation[]> {
  const invocations = new Map<string, PipelineInvocation[]>();
  const open = new Map<string, InvocationBuilder[]>();
  const occurrences = new Map<string, number>();
  const activeByKey = new Map(
    present.active.map((active) => [
      invocationKey(active),
      active,
    ]),
  );

  for (const event of events) {
    if (event.type === "phase-started") {
      const key = invocationKey(event);
      const attempt = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, attempt);
      const invocation: PipelineInvocation = {
        agent: event.agent,
        attempt,
        round: event.round,
        state: "active",
        startedTs: event.ts,
      };
      const list = invocations.get(event.ghIssue) ?? [];
      list.push(invocation);
      invocations.set(event.ghIssue, list);
      const builders = open.get(key) ?? [];
      builders.push({ invocation, startMs: Date.parse(event.ts) });
      open.set(key, builders);
    } else if (event.type === "phase-ended") {
      const builders = open.get(invocationKey(event));
      const builder = builders?.shift();
      if (!builder) {
        const invocation: PipelineInvocation = {
          agent: event.agent,
          round: event.round,
          state: "unknown",
          endedTs: event.ts,
          verdict: event.verdict,
        };
        const list = invocations.get(event.ghIssue) ?? [];
        list.push(invocation);
        invocations.set(event.ghIssue, list);
        continue;
      }
      builder.invocation.endedTs = event.ts;
      builder.invocation.verdict = event.verdict;
      builder.invocation.elapsedMs = elapsed(
        builder.invocation.startedTs,
        event.ts,
        now,
      );
      builder.invocation.state = invocationState(builder.invocation);
    }
  }

  for (const [key, builders] of open) {
    const active = activeByKey.get(key);
    for (const builder of builders) {
      if (builder.invocation.endedTs) continue;
      builder.invocation.elapsedMs = elapsed(
        builder.invocation.startedTs,
        undefined,
        now,
      );
      builder.invocation.stale = active?.stale ?? false;
    }
  }
  return invocations;
}

function latest(invocations: PipelineInvocation[], agent: string) {
  return [...invocations].reverse().find((item) => item.agent === agent);
}

function roundsFor(
  invocations: PipelineInvocation[],
  primaryAgent: string,
  evaluatorAgents: string[],
): PipelineRound[] {
  const rounds = new Map<number, PipelineRound>();
  for (const invocation of invocations) {
    if (
      invocation.agent !== primaryAgent &&
      !evaluatorAgents.includes(invocation.agent)
    ) {
      continue;
    }
    const round = invocation.round ?? 1;
    const entry = rounds.get(round) ?? {
      round,
      primaryInvocations: [],
      evaluatorInvocations: [],
    };
    if (invocation.agent === primaryAgent) {
      entry.primaryInvocations.push(invocation);
      entry.primary = invocation;
    } else {
      entry.evaluatorInvocations.push(invocation);
      entry.evaluator = invocation;
    }
    rounds.set(round, entry);
  }
  return [...rounds.values()].sort((a, b) => a.round - b.round);
}

function inferSliceState(
  outcome: string | undefined,
  invocations: PipelineInvocation[],
  waitsOn: string[],
): PipelineState {
  if (outcome === "PASS") return "done";
  if (outcome && FAILURE_OUTCOMES.has(outcome)) return "failed";
  if (invocations.some((invocation) => invocation.state === "active")) {
    return "active";
  }
  if (waitsOn.length > 0) return "blocked";
  return "queued";
}

function aggregateStages(events: RunEvent[], now: number): PipelineAggregateStage[] {
  const definitions = [
    ["sanity", "Pre-ship sanity"],
    ["architect-review", "Architect review"],
    ["pm-review", "PM review"],
    ["draft-pr", "Draft PR"],
  ] as const;
  const byPhase = new Map<string, PipelineInvocation[]>();
  const open = new Map<string, PipelineInvocation[]>();
  for (const event of events) {
    if (event.type === "run-phase-started") {
      const invocation: PipelineInvocation = {
        agent: event.phase,
        attempt: event.attempt,
        cached: event.cached,
        startedTs: event.ts,
        elapsedMs: elapsed(event.ts, undefined, now),
        state: "active",
      };
      const list = byPhase.get(event.phase) ?? [];
      list.push(invocation);
      byPhase.set(event.phase, list);
      const key = `${event.phase}|${event.attempt ?? ""}`;
      const pending = open.get(key) ?? [];
      pending.push(invocation);
      open.set(key, pending);
    } else if (event.type === "run-phase-ended") {
      const key = `${event.phase}|${event.attempt ?? ""}`;
      const invocation = open.get(key)?.shift();
      if (invocation) {
        invocation.endedTs = event.ts;
        invocation.verdict = event.verdict;
        invocation.cached = event.cached ?? invocation.cached;
        invocation.elapsedMs = elapsed(invocation.startedTs, event.ts, now);
        invocation.state = invocationState(invocation);
      }
    }
  }
  let previousFailed = false;
  return definitions.map(([id, label]) => {
    const attempts = byPhase.get(id) ?? [];
    const verdict = [...attempts].reverse().find((item) => item.verdict)?.verdict;
    let state: PipelineState;
    if (attempts.some((item) => item.state === "active")) state = "active";
    else if (attempts.length > 0) {
      state = attempts.some((item) => item.state === "failed") ? "failed" : "done";
    } else {
      state = previousFailed ? "blocked" : "queued";
    }
    previousFailed ||= state === "failed" || state === "blocked";
    return { id, label, state, attempts, verdict };
  });
}

export function buildPipelineSection(input: {
  repoRoot: string;
  events: RunEvent[];
  future: FutureSection;
  present: PresentSection;
  now: Date;
}): PipelineSection {
  const { events, future, present } = input;
  const now = input.now.getTime();
  const notes: string[] = [];
  const manifest = manifestFor(input.repoRoot, events, notes);
  const manifestById = new Map(manifest.map((slice) => [slice.ghIssue, slice]));
  const invocationBySlice = buildSliceInvocations(events, present, now);
  const outcomes = new Map<string, { phase: string; title: string }>();
  const waves = new Map<number, {
    slices: string[];
    lanes?: string[][];
    startedTs?: string;
    endedTs?: string;
  }>();
  let runStarted: Extract<RunEvent, { type: "run-started" }> | undefined;
  let runEnded: Extract<RunEvent, { type: "run-ended" }> | undefined;

  for (const event of events) {
    if (event.type === "run-started") runStarted = event;
    else if (event.type === "run-ended") runEnded = event;
    else if (event.type === "wave-dispatched") {
      waves.set(event.wave, {
        ...waves.get(event.wave),
        slices: event.slices,
        startedTs: event.ts,
      });
    } else if (event.type === "lanes-partitioned") {
      const wave = waves.get(event.wave) ?? { slices: event.lanes.flat() };
      wave.lanes = event.lanes;
      waves.set(event.wave, wave);
    } else if (event.type === "wave-completed") {
      const wave = waves.get(event.wave) ?? { slices: [] };
      wave.endedTs = event.ts;
      waves.set(event.wave, wave);
    } else if (event.type === "slice-outcome") {
      outcomes.set(event.slice.ghIssue, {
        phase: event.slice.phase,
        title: event.slice.title,
      });
    }
  }

  const waitsBySlice = new Map(
    future.pending.map((slice) => [
      slice.ghIssue,
      slice.waitsOn.map((blocker) => blocker.ghIssue),
    ]),
  );
  const makeSlice = (ghIssue: string): PipelineSlice => {
    const manifestSlice = manifestById.get(ghIssue);
    const outcome = outcomes.get(ghIssue);
    const invocations = invocationBySlice.get(ghIssue) ?? [];
    const waitsOn = waitsBySlice.get(ghIssue) ?? [];
    return {
      ghIssue,
      number: manifestSlice?.number ?? ghIssue,
      title: manifestSlice?.title ?? outcome?.title ?? "",
      state: inferSliceState(outcome?.phase, invocations, waitsOn),
      waitsOn,
      explorer: latest(invocations, "explorer"),
      contractRounds: roundsFor(invocations, "planner", ["evaluator-contract"]),
      implementationRounds: roundsFor(invocations, "generator", [
        "evaluator-qa",
        "evaluator-uat",
      ]),
      outcome: outcome?.phase,
    };
  };

  const projected = new Set<number>();
  for (const futureWave of future.upcomingWaves) {
    if (!waves.has(futureWave.wave)) {
      waves.set(futureWave.wave, { slices: futureWave.slices });
      projected.add(futureWave.wave);
    }
  }

  const renderedWaves: PipelineWave[] = [...waves.entries()]
    .sort(([a], [b]) => a - b)
    .map(([waveNumber, wave]) => {
      const laneIds = wave.lanes ?? wave.slices.map((slice) => [slice]);
      const lanes = laneIds.map((ids, index) => ({
        lane: index + 1,
        slices: ids.map(makeSlice),
      }));
      const slices = lanes.flatMap((lane) => lane.slices);
      let state: PipelineState;
      if (wave.endedTs) {
        state = slices.some((slice) => slice.state === "failed") ? "failed" : "done";
      } else if (slices.some((slice) => slice.state === "active")) state = "active";
      else if (slices.some((slice) => slice.state === "blocked")) state = "blocked";
      else state = "queued";
      return {
        wave: waveNumber,
        projected: projected.has(waveNumber),
        state,
        startedTs: wave.startedTs,
        endedTs: wave.endedTs,
        elapsedMs: elapsed(wave.startedTs, wave.endedTs, now),
        lanes,
      };
    });

  const outcome = runEnded?.outcome;
  const runState: PipelineState =
    outcome === "SUCCEEDED"
      ? "done"
      : outcome
        ? "failed"
        : runStarted
          ? "active"
          : "unknown";
  return {
    run: {
      slug: runStarted?.runSlug,
      provider: runStarted?.provider,
      state: runState,
      startedTs: runStarted?.ts,
      endedTs: runEnded?.ts,
      elapsedMs: elapsed(runStarted?.ts, runEnded?.ts, now),
      contractRoundLimit: runStarted?.contractRoundLimit,
      implementationRoundLimit: runStarted?.implementationRoundLimit,
      outcome,
    },
    waves: renderedWaves,
    aggregateStages: aggregateStages(events, now),
    notes: [...future.notes, ...notes],
  };
}
