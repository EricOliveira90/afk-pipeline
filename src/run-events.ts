/**
 * Structured run events (spec #26). The orchestrator's logging funnel
 * tees operator-meaningful transitions into `events.jsonl` in the
 * per-run log directory (ADR 0017), beside the human `run.log` — which
 * stays byte-for-byte unchanged. One JSON line per event; the first
 * line is a `version: 1` header event, copying the handoff.json
 * convention.
 *
 * Payloads serialize the existing `SliceLifecycle` vocabulary — there
 * is no parallel status vocabulary to keep in sync. The schema is
 * versioned and the union is open for new event types (e.g. the
 * future in-invocation liveness signals sketched in #14) without
 * breaking existing consumers.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SliceLifecycle } from "./slice-lifecycle.js";
import type { BehaviorCoverageStatus } from "./acceptance-gate.js";
import type {
  GateFailureKind,
  GateStatus,
} from "./gate-runner.js";
import type { PromptAssemblyRole } from "./context-envelope.js";

export const EVENTS_FILE = "events.jsonl";
export const EVENTS_SCHEMA_VERSION = 1;

/**
 * Event payloads as emitted at call sites — the RunJournal stamps `ts`.
 */
export type RunEventPayload =
  | { type: "header"; version: typeof EVENTS_SCHEMA_VERSION }
  | {
      type: "run-started";
      provider: string;
      runSlug: string;
      /** Configured convergence limits; absent in historical streams. */
      contractRoundLimit?: number;
      implementationRoundLimit?: number;
      /**
       * Whether `--record-prompts` was on (#264). Always written by a new
       * run; absent in historical streams, which is why it is optional.
       */
      recordPrompts?: boolean;
    }
  | { type: "wave-dispatched"; wave: number; slices: string[] }
  | { type: "wave-completed"; wave: number }
  | {
      type: "lanes-partitioned";
      wave: number;
      /**
       * Lane composition for the wave (ADR 0005): lanes run in
       * parallel; within a lane, slices run serially in the listed
       * order. Known only mid-run, after contracts declare their
       * file lists.
       */
      lanes: string[][];
      /**
       * Slices unioned into one lane by a shared *resource* rather than
       * a shared path (ADR 0027), keyed by resource — today only
       * `migrations`. Present only when at least two slices in the wave
       * contend for the same resource; a lone declarer is contending
       * with nobody.
       */
      sharedResources?: Record<string, string[]>;
      serial?: boolean;
    }
  | {
      type: "phase-started";
      ghIssue: string;
      /**
       * The slice's two-digit manifest number — names the agent log
       * file (`slice-<number>-<agent>[-r<n>].log`) so a status reader
       * can `stat` the active log for liveness without the DAG.
       */
      sliceNumber?: string;
      /** Agent role for this invocation (explorer, planner, evaluator-contract, generator, evaluator-qa, evaluator-uat). */
      agent: string;
      round?: number;
    }
  | {
      type: "phase-ended";
      ghIssue: string;
      sliceNumber?: string;
      agent: string;
      round?: number;
      /**
       * Verdict/outcome where the phase produces one, in the existing
       * artifact vocabulary: evaluator-contract → ACCEPT/REVISE/
       * ESCALATE/UNKNOWN; evaluator-qa/-uat → PASS/IMPLEMENTATION.
       */
      verdict?: string;
    }
  | {
      /**
       * Assembled-envelope evidence, journaled immediately BEFORE the
       * provider is dispatched so the record survives an invocation that
       * dies mid-flight (slice #83; guardian round 2, PM 4). Post-return
       * facts — token counts, non-command time — arrive in the paired
       * `invocation-completed` event.
       */
      type: "prompt-assembly";
      ghIssue: string;
      sliceNumber: string;
      round: number;
      role: PromptAssemblyRole;
      assembledByteSize: number;
      includedArtifactClasses: string[];
      includedArtifactIds: string[];
      omittedArtifactClasses: string[];
      contextManifestVersion: number;
    }
  | {
      /**
       * Post-return completion evidence for one provider invocation.
       * For the four assembled roles it pairs with the `prompt-assembly`
       * event journaled before its dispatch (same
       * ghIssue/sliceNumber/round/role). Candidate-QA and shared-preview
       * evaluator invocations emit it too — completion telemetry is
       * decoupled from envelope assembly, because evaluator reading time
       * is the measurement the PRD's ROI rider scores (plan §3 item 13;
       * guardian round 6). Emitted only for invocations that returned
       * successfully.
       */
      type: "invocation-completed";
      ghIssue: string;
      sliceNumber: string;
      round: number;
      role:
        | PromptAssemblyRole
        | "evaluator-qa"
        | "evaluator-uat"
        // The final evaluator (#96 B-06) is journaled the same way and for the
        // same reason: it has a manifest-only role contract today, so its
        // reading time has no `prompt-assembly` event to pair with.
        | "evaluator-final";
      /** Evaluator attempt within the round, when the role retries. */
      attempt?: number;
      /** Provider-exposed token names and counts, never renamed. */
      tokenCounts?: Record<string, number>;
      /**
       * Evidence-only per-invocation non-command wall clock (PRD 3 §3
       * item 13; ADR 0046 amendment 2026-09-05). Copied verbatim from
       * `InvocationStats.nonCommandTimeMs` — see its TSDoc in
       * `agent-provider.ts` for the exact clock boundaries. Absent
       * whenever the provider could not attribute command time; a
       * reader must treat absence as "unmeasured", never as 0. Like
       * `stage-duration`, nothing thresholds, alerts on, or acts upon
       * this field; its consumers are the context-envelope ROI
       * analysis reading `events.jsonl`.
       */
      nonCommandTimeMs?: number;
    }
  | {
      type: "gate-outcome";
      ghIssue: string;
      sliceNumber: string;
      round: number;
      attemptId: string;
      gateId: string;
      stage: string;
      status: GateStatus;
      failureKind: GateFailureKind;
      startedAt: string;
      endedAt: string;
      durationMs: number;
      exitCode: number | null;
      treeId: string;
      evidenceArtifactId: string;
      logArtifactId: string;
      /**
       * Why this gate cost what it cost, when there is something to say (#86).
       * All three are optional and additive, so every existing reader of this
       * event keeps working:
       *
       * - `cacheReused` — a `PASS` replayed from the tree-identity cache
       *   instead of executed (B-03). A 0ms PASS is otherwise indistinguishable
       *   from a gate that did nothing.
       * - `prerequisiteSkipped` — the gate id whose non-PASS result caused this
       *   `SKIPPED` (B-07). Named, because a silent skip reads as a green run.
       * - `environmentSensitive` — the gate is advisory: its result is reported
       *   and never blocks (B-02, ADR 0063).
       */
      cacheReused?: boolean;
      prerequisiteSkipped?: string;
      environmentSensitive?: boolean;
    }
  | {
      /**
       * One human-authored protected-change waiver a gate actually applied
       * (#193 D5/D23). Emitted per waiver rather than per gate phase, because
       * the operator-meaningful unit is the authorization: this is the event
       * that turns "the gate passed" into "the gate passed because a named
       * human signed off on this exact path, for this reason".
       *
       * All four of D5's fields travel with it. `run-summary.md`'s
       * `## Applied Waivers` section is rendered from this event alone, so a
       * reader of `events.jsonl` and a reader of the summary see one record.
       */
      type: "waiver-applied";
      ghIssue: string;
      sliceNumber: string;
      round: number;
      riskClass: string;
      path: string;
      author: string;
      reason: string;
    }
  | {
      /**
       * One behavior id's coverage verdict from one acceptance-gate attempt
       * (#85 AC6). The aggregate gate reports a single `gate-outcome`, so
       * without this event the per-behavior detail exists only as prose inside
       * the gate log; here it is one line per behavior per attempt, carrying
       * the same tree and artifact identity as its `gate-outcome` so a reader
       * can join them. Descriptive: the gate's own status is the verdict, and
       * nothing thresholds or acts on these counts.
       */
      type: "behavior-coverage";
      ghIssue: string;
      sliceNumber: string;
      round: number;
      attemptId: string;
      behaviorId: string;
      gateId: string;
      status: BehaviorCoverageStatus;
      /** Tests the id's filter selected: `passed + failed`. */
      matched: number;
      passed: number;
      failed: number;
      treeId: string;
      evidenceArtifactId: string;
      logArtifactId: string;
    }
  | {
      /**
       * The approved baseline one deterministic PASS established (#91 AC5,
       * PRD D10): the candidate checkpoint the evaluator graded, and where
       * the orchestrator wrote the artifact that is its canonical record.
       * Additive, so `EVENTS_SCHEMA_VERSION` stays 1 — the same way
       * `behavior-coverage` arrived.
       */
      type: "approved-baseline";
      ghIssue: string;
      sliceNumber: string;
      round: number;
      treeId: string;
      commit: string;
      /** Repo-relative path of `approved-baseline.json`. */
      artifactId: string;
    }
  | {
      /**
       * A final evaluation that did not happen because it did not need to
       * (#96 B-02, PRD D20): the final checkpoint tree was byte-identical to
       * the approved baseline's, so zero final-evaluator invocations were
       * dispatched. Additive, so `EVENTS_SCHEMA_VERSION` stays 1 — the same
       * way `behavior-coverage` and `approved-baseline` arrived.
       *
       * One of exactly three places the reuse is recorded, with the run-state
       * `finalEvaluations` decision and the slice's `run-summary.md` section.
       * Deliberately *not* a `GateEvidence` field: D17's gate-cache `reused`
       * flag says a gate did not re-run for a tree, which is a different
       * subject and a different claim, and a reader who conflated them would
       * think a gate was skipped.
       */
      type: "final-evaluation-reuse";
      ghIssue: string;
      sliceNumber: string;
      round: number;
      /** The final checkpoint tree object ID — not a commit. */
      finalTreeId: string;
      /** The approved baseline tree it equalled, byte for byte. */
      baselineTreeId: string;
    }
  | {
      /**
       * One path the evaluator changed in its disposable review worktree
       * that neither the copy-back allowlist nor the attempt's seed manifest
       * explains (#91 AC2/AC6). Descriptive: the write was already discarded
       * by not being copied back, so nothing acts on this event — it is the
       * record that it happened.
       */
      type: "reviewer-write-violation";
      ghIssue: string;
      sliceNumber: string;
      round: number;
      attempt: number;
      /** Repo-relative path inside the review worktree. */
      path: string;
    }
  | {
      /**
       * One scoped merge-resolution round (#132 AC8). Recorded distinctly from
       * the generator repair rounds it borrows its prompt from, because an
       * operator reading "the generator ran again" needs to know this run was
       * a merge conflict being resolved under a held merge mutex, not a red
       * gate being repaired. Additive, so `EVENTS_SCHEMA_VERSION` stays 1 —
       * the same way `behavior-coverage` and `approved-baseline` arrived.
       *
       * `verdict` and `durationMs` are the two fields the round owes. There is
       * deliberately no cost field: the round's provider cost is already
       * carried by the invocation events its generator dispatch emits, and a
       * second number derived from the same dispatch would be a figure two
       * readers could disagree about.
       */
      type: "merge-resolution-round";
      ghIssue: string;
      sliceNumber: string;
      /** How the round ended (`MergeResolutionVerdict`). */
      verdict: string;
      durationMs: number;
      /** Paths the re-resolved base conflicted on. */
      conflictedPaths?: string[];
      /** The resolved tree the gate re-run proved, when the round got that far. */
      treeId?: string;
      /** Human-readable one-liner, the same text the run log carries. */
      detail?: string;
    }
  | {
      /**
       * The budgets one slice dispatch is running under (plan §3.9,
       * wave item 14): resume attempts, implementation rounds, contract
       * rounds, infrastructure retries. One per dispatch, emitted beside
       * the same numbers' `run.log` line so `afk status` renders them
       * without re-deriving anything. Not a warning — these are the
       * limits, stated, before anything has gone wrong.
       */
      type: "slice-bounds";
      ghIssue: string;
      sliceNumber?: string;
      resumeAttemptsRemaining: number;
      resumeAttemptLimit: number;
      implementationRoundsRemaining: number;
      implementationRoundLimit: number;
      contractRoundsRemaining: number;
      contractRoundLimit: number;
      infrastructureRetriesPerInvocation: number;
      /** Present when this dispatch resumed a preserved tree. */
      resumeMode?: "killed" | "stuck";
    }
  | {
      /**
       * One invocation's wall-clock duration against the durations the
       * same stage recorded before it — the watchdog ping's surviving
       * residue, kept as data only. See `stage-durations.ts` for why
       * nothing thresholds, alerts on, or acts upon this event; its
       * consumers are the morning babysitter and PRD 5 story 17's ROI
       * dataset.
       */
      type: "stage-duration";
      ghIssue: string;
      sliceNumber?: string;
      /** Agent role — the stage identity; the history pools its rounds. */
      agent: string;
      round?: number;
      durationMs: number;
      /** Prior samples for this stage; `null` on a stage's first invocation. */
      history: {
        samples: number;
        medianMs: number;
        maxMs: number;
      } | null;
      /** `durationMs / history.medianMs`, two decimals. Descriptive, not a verdict. */
      ratioToMedian?: number;
    }
  | {
      type: "run-phase-started";
      phase: "sanity" | "architect-review" | "pm-review" | "draft-pr";
      attempt?: number;
      cached?: boolean;
    }
  | {
      type: "run-phase-ended";
      phase: "sanity" | "architect-review" | "pm-review" | "draft-pr";
      attempt?: number;
      cached?: boolean;
      verdict: string;
      /**
       * Set on a `FAIL` verdict, in the same vocabulary the per-slice base
       * gates emit: `"CONFIGURATION"` when the phase never really ran
       * (missing toolchain), `"COMMAND"` when the reviewed tree is red
       * (#101). A status reader can tell the two apart without parsing prose.
       */
      failureKind?: GateFailureKind;
    }
  | { type: "run-ended"; outcome: "SUCCEEDED" | "FAILED" | "ABORTED" }
  | { type: "slice-outcome"; slice: SliceLifecycle }
  | {
      type: "warn";
      /**
       * Which warn-class signal this is. One per signal the pipeline
       * already logs: lane continuation after a member failure
       * (ADR 0024), QA infrastructure retries that don't consume a
       * round, transient-outage backoff retries (ADR 0022), per-slice
       * prior-run state at run start (retry announcement), a dependency
       * counted as satisfied from prior run state rather than from this
       * invocation (issue #41), NOT-RUN dependency holds, idle-kill
       * deferrals from the busy probe (ADR 0021), operator-granted
       * resumes of a STUCK slice's preserved tree (`--resume-stuck`,
       * #49), a locked contract
       * sent back to the planner by the contract-lock gate (ADR 0028), a
       * locked file scope widened mid-slice by the orchestrator because QA
       * found correct work in an undeclared file (#112),
       * the launch guard fast-forwarding a stale feature branch to
       * the host worktree's HEAD before any wave dispatches, a
       * contract review attempt whose audit copy could not be written,
       * a from-base restart refused because the slice branch still holds
       * unmerged commits (#113), the cancellation record written
       * the moment a stop signal fires, naming the slices it marked
       * CANCELLED in run state (#114), the crash record written when the
       * process observes its own death — an uncaught exception, an
       * unhandled rejection, or a fatal log-stream error (#121, ADR 0044),
       * which is the last event the run emits before exiting non-zero and
       * is followed only by `run-ended`, the launch preflight's report
       * — swept shells, reported conditions, and a refusal bypassed with
       * `--preflight-report-only` (ADR 0042) — the `afk stop`
       * sentinel this run found in its own log directory (ADR 0043),
       * a guardian review artifact the ship gate had to restore before
       * committing — or could not restore — and a review worktree that moved
       * under the gate between the reviews and the artifact commit (#136),
       * which is immediately followed by the `cancellation-requested`
       * line it triggers, the previous attempt's persisted slice
       * record dropped when this run dispatched the slice (#111), and each
       * guardian finding the ship gate filed as an issue — or could not file:
       * a blocking finding that cannot be filed refuses the round-cap exit,
       * while an unfilable note only warns (ADR 0057 decision 4), and a
       * negotiation artifact refused by deterministic validation and handed
       * back to its author with the exact error for one repair pass — or
       * denied one — plus durable contract lineage found only under the bare
       * PRD slug, which this run reads as empty and adopts nothing from
       * (both ADR 0061).
       */
      reason:
        | "cancellation-requested"
        | "stale-record-cleared"
        | "stop-requested"
        | "crashed"
        | "lane-continuation"
        | "infrastructure-retry"
        | "backoff-retry"
        | "prior-run-state"
        | "dependency-from-prior-run"
        | "not-run-hold"
        | "idle-deferral"
        | "resume-stuck"
        | "contract-lock-refused"
        | "scope-amended"
        | "negotiation-artifact-repair"
        | "orphaned-contract-lineage"
        | "contract-review-archive-failed"
        | "qa-review-archive-failed"
        /**
         * An evidence archive write failed and the slice carried on (#258).
         * An archive is a record *about* a run and must never be able to end
         * one, so the warning is the whole consequence.
         */
        | "evidence-archive-failed"
        | "feature-branch-fast-forward"
        | "restart-refused"
        | "preflight"
        | "review-artifact-restored"
        | "review-artifact-restore-failed"
        | "review-worktree-drift"
        | "guardian-finding-filed"
        | "guardian-cap-filing-failed"
        | "guardian-note-filing-failed";
      ghIssue?: string;
      /** Human-readable one-liner rendered inline in the chronology. */
      message: string;
      /**
       * prior-run-state / stale-record-cleared: the phase persisted by
       * the previous run — announced at run start, and again by name when
       * the dispatch drops it.
       */
      previousPhase?: string;
      /** prior-run-state / stale-record-cleared: the reason that record carried. */
      previousError?: string;
      /** not-run-hold: unresolved blockers this slice waits on. */
      blockedBy?: string[];
    };

export type RunEvent = RunEventPayload & {
  /** ISO-8601 timestamp stamped when the event line was appended. */
  ts: string;
};

export interface RunEvents {
  version: number;
  events: RunEvent[];
}

/** Serialize one event as a single JSON line (newline-terminated). */
export function serializeRunEvent(event: RunEvent): string {
  return JSON.stringify(event) + "\n";
}

/**
 * Read a run directory's `events.jsonl`. Returns `null` when the file
 * is absent (a run that predates the tee). Malformed lines — e.g. a
 * partially flushed last line while the run is live — are skipped, so
 * a reader polling an in-flight run never crashes on a torn write.
 */
export function readRunEvents(runDir: string): RunEvents | null {
  const path = join(runDir, EVENTS_FILE);
  if (!existsSync(path)) return null;
  const events: RunEvent[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as RunEvent);
    } catch {
      // Torn or foreign line — skip, keep the rest readable.
    }
  }
  const header = events[0];
  const version =
    header && header.type === "header" ? header.version : EVENTS_SCHEMA_VERSION;
  return { version, events };
}
