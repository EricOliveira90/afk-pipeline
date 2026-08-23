import type { Slice } from "./issues-parser.js";
import type {
  RunSnapshot,
  SnapshotPhaseInvocation,
  SnapshotSliceOutcome,
} from "./run-snapshot.js";
import { bucketFor } from "./slice-lifecycle.js";
import type {
  FutureSection,
  ManifestReadResult,
} from "./status-future.js";
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

function elapsed(
  startTs: string | undefined,
  endTs: string | undefined,
  now: number,
) {
  if (!startTs) return undefined;
  const start = Date.parse(startTs);
  const end = endTs ? Date.parse(endTs) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.max(0, end - start);
}

function invocationState(invocation: PipelineInvocation): PipelineState {
  if (!invocation.endedTs) return "active";
  const verdict = invocation.verdict?.toUpperCase();
  return verdict &&
    [
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

function stateForClosedInvocation(
  invocation: SnapshotPhaseInvocation,
  outcome: SnapshotSliceOutcome | undefined,
): PipelineState {
  if (invocation.closeReason === undefined) return "active";
  if (invocation.closeReason === "phase-ended") {
    if (invocation.startedTs === undefined) return "unknown";
    return invocationState({
      agent: invocation.agent,
      state: "unknown",
      endedTs: invocation.endedTs,
      verdict: invocation.verdict,
    });
  }
  if (outcome) {
    const bucket = bucketFor(outcome.phase);
    if (bucket === "failed" || bucket === "cancelled") return "failed";
  }
  return "done";
}

function buildSliceInvocations(
  snapshot: RunSnapshot,
  present: PresentSection,
  now: number,
): Map<string, PipelineInvocation[]> {
  const bySlice = new Map<string, PipelineInvocation[]>();
  for (const ghIssue of snapshot.sliceOrder) {
    const slice = snapshot.slices[ghIssue]!;
    const invocations = slice.invocations.map((phase): PipelineInvocation => {
      const active = present.active.find(
        (item) =>
          item.ghIssue === phase.ghIssue &&
          item.agent === phase.agent &&
          item.round === phase.round &&
          item.startedTs === phase.startedTs,
      );
      return {
        agent: phase.agent,
        attempt: phase.attempt,
        round: phase.round,
        state: stateForClosedInvocation(phase, slice.outcome),
        startedTs: phase.startedTs,
        endedTs: phase.endedTs,
        elapsedMs: elapsed(
          phase.startedTs,
          phase.closedTs ?? phase.endedTs,
          now,
        ),
        verdict: phase.verdict,
        stale: active?.stale ?? false,
      };
    });
    if (invocations.length > 0) bySlice.set(ghIssue, invocations);
  }
  return bySlice;
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
  outcome: SnapshotSliceOutcome | undefined,
  invocations: PipelineInvocation[],
  waitsOn: string[],
): PipelineState {
  if (outcome) {
    const bucket = bucketFor(outcome.phase);
    if (bucket === "succeeded") return "done";
    if (bucket === "failed" || bucket === "cancelled") return "failed";
  }
  if (invocations.some((invocation) => invocation.state === "active")) {
    return "active";
  }
  if (waitsOn.length > 0) return "blocked";
  return "queued";
}

function aggregateStages(
  snapshot: RunSnapshot,
  now: number,
): PipelineAggregateStage[] {
  const definitions = [
    ["sanity", "Pre-ship sanity"],
    ["architect-review", "Architect review"],
    ["pm-review", "PM review"],
    ["draft-pr", "Draft PR"],
  ] as const;
  const byPhase = new Map<string, PipelineInvocation[]>();
  for (const phase of snapshot.runPhases) {
    if (phase.startedTs === undefined) continue;
    const invocation: PipelineInvocation = {
      agent: phase.phase,
      attempt: phase.attempt,
      cached: phase.cached,
      startedTs: phase.startedTs,
      endedTs: phase.endedTs,
      elapsedMs: elapsed(phase.startedTs, phase.endedTs, now),
      verdict: phase.verdict,
      state: phase.endedTs
        ? invocationState({
            agent: phase.phase,
            state: "unknown",
            endedTs: phase.endedTs,
            verdict: phase.verdict,
          })
        : "active",
    };
    const list = byPhase.get(phase.phase) ?? [];
    list.push(invocation);
    byPhase.set(phase.phase, list);
  }

  let previousFailed = false;
  return definitions.map(([id, label]) => {
    const attempts = byPhase.get(id) ?? [];
    const verdict = [...attempts].reverse().find((item) => item.verdict)?.verdict;
    let state: PipelineState;
    if (attempts.some((item) => item.state === "active")) state = "active";
    else if (attempts.length > 0) {
      state = attempts.some((item) => item.state === "failed")
        ? "failed"
        : "done";
    } else {
      state = previousFailed ? "blocked" : "queued";
    }
    previousFailed ||= state === "failed" || state === "blocked";
    return { id, label, state, attempts, verdict };
  });
}

function manifestNotes(manifest: ManifestReadResult): string[] {
  if (manifest.status === "missing") {
    return [
      "issues.md is unavailable; titles and projected dependencies may be unknown",
    ];
  }
  if (manifest.status === "invalid") {
    return ["issues.md could not be parsed; the matrix uses observed events only"];
  }
  return [];
}

export function buildPipelineSection(input: {
  snapshot: RunSnapshot;
  manifest: ManifestReadResult;
  future: FutureSection;
  present: PresentSection;
  now: Date;
}): PipelineSection {
  const { snapshot, future, present } = input;
  const now = input.now.getTime();
  const manifest: Slice[] =
    input.manifest.status === "available" ? input.manifest.slices : [];
  const manifestById = new Map(manifest.map((slice) => [slice.ghIssue, slice]));
  const invocationBySlice = buildSliceInvocations(snapshot, present, now);
  const waitsBySlice = new Map(
    future.pending.map((slice) => [
      slice.ghIssue,
      slice.waitsOn.map((blocker) => blocker.ghIssue),
    ]),
  );
  const makeSlice = (ghIssue: string): PipelineSlice => {
    const manifestSlice = manifestById.get(ghIssue);
    const snapshotSlice = snapshot.slices[ghIssue];
    const invocations = invocationBySlice.get(ghIssue) ?? [];
    const waitsOn = waitsBySlice.get(ghIssue) ?? [];
    return {
      ghIssue,
      number: manifestSlice?.number ?? ghIssue,
      title: manifestSlice?.title ?? snapshotSlice?.title ?? "",
      state: inferSliceState(snapshotSlice?.outcome, invocations, waitsOn),
      waitsOn,
      explorer: latest(invocations, "explorer"),
      contractRounds: roundsFor(invocations, "planner", [
        "evaluator-contract",
      ]),
      implementationRounds: roundsFor(invocations, "generator", [
        "evaluator-qa",
        "evaluator-uat",
      ]),
      outcome: snapshotSlice?.outcome?.phase,
    };
  };

  const waves = new Map(
    snapshot.waves.map((wave) => [wave.wave, { ...wave, projected: false }]),
  );
  for (const futureWave of future.upcomingWaves) {
    if (!waves.has(futureWave.wave)) {
      waves.set(futureWave.wave, {
        wave: futureWave.wave,
        slices: futureWave.slices,
        serial: false,
        projected: true,
      });
    }
  }

  const renderedWaves: PipelineWave[] = [...waves.values()]
    .sort((a, b) => a.wave - b.wave)
    .map((wave) => {
      const laneIds = wave.lanes ?? wave.slices.map((slice) => [slice]);
      const lanes = laneIds.map((ids, index) => ({
        lane: index + 1,
        slices: ids.map(makeSlice),
      }));
      const slices = lanes.flatMap((lane) => lane.slices);
      let state: PipelineState;
      if (wave.endedTs) {
        state = slices.some((slice) => slice.state === "failed")
          ? "failed"
          : "done";
      } else if (slices.some((slice) => slice.state === "active")) {
        state = "active";
      } else if (slices.some((slice) => slice.state === "blocked")) {
        state = "blocked";
      } else {
        state = "queued";
      }
      return {
        wave: wave.wave,
        projected: wave.projected,
        state,
        startedTs: wave.startedTs,
        endedTs: wave.endedTs,
        elapsedMs: elapsed(wave.startedTs, wave.endedTs, now),
        lanes,
      };
    });

  const outcome = snapshot.run.outcome;
  const runState: PipelineState =
    outcome === "SUCCEEDED"
      ? "done"
      : outcome
        ? "failed"
        : snapshot.run.startedTs
          ? "active"
          : "unknown";
  return {
    run: {
      slug: snapshot.run.slug,
      provider: snapshot.run.provider,
      state: runState,
      startedTs: snapshot.run.startedTs,
      endedTs: snapshot.run.endedTs,
      elapsedMs: elapsed(snapshot.run.startedTs, snapshot.run.endedTs, now),
      contractRoundLimit: snapshot.run.contractRoundLimit,
      implementationRoundLimit: snapshot.run.implementationRoundLimit,
      outcome,
    },
    waves: renderedWaves,
    aggregateStages: aggregateStages(snapshot, now),
    notes: [...future.notes, ...manifestNotes(input.manifest)],
  };
}
