/**
 * The record for the exit ADR 0040 cannot see: a process-fatal crash.
 *
 * ADR 0040 made a stop write a `CANCELLED` run-state entry the moment the
 * signal fires, so a run that dies during its wind-down still leaves a
 * truthful record. But that listener hangs off the `AbortSignal`, and a
 * crash is not a stop — nothing aborts. Run 6 died on an unhandled
 * `'error'` event from a log `WriteStream` (`ENOSPC: no space left on
 * device`) and wrote nothing, so `.afk/state/<prd>.json` still held slice
 * #79's entry from *two runs earlier*: a typecheck failure that had
 * already been fixed. An operator reading it was pointed at the wrong
 * bug (issue #121). A record naming a stale failure is worse than no
 * record.
 *
 * So the three ways the process observes its own death — an uncaught
 * exception, an unhandled rejection, and a fatal error on a stream the
 * pipeline owns — go through the same bookkeeping, with `CRASHED` as the
 * cause instead of "Cancelled by user", and then the process exits
 * non-zero. The crash is recorded, never swallowed.
 *
 * Two deliberate limits:
 *
 * - **Best-effort by design.** The condition most worth recording
 *   (a full disk) is the condition that can defeat the write. A failed
 *   record is logged and the exit still happens; there is no reserved
 *   space, no pre-allocated record — that machinery was proposed and
 *   rejected as cost without a bound. The backstop for the write that
 *   never lands is clearing a slice's stale reason when it is
 *   *dispatched*, so no stale text survives into a later run at all.
 * - **Installed by the CLI, not by the pipeline.** These handlers end the
 *   process, which is only the right thing to do when the run *is* the
 *   process. `runPipeline` registers its recorder with the handle
 *   (`register`) and unregisters it when the run ends; in-process callers
 *   — the test suite runs many pipelines per worker — pass no handle and
 *   keep Node's own behaviour.
 *
 * The stop button lives next door in `src/cancellation.ts`; that is the
 * path for a run someone chose to end.
 */

import type { RunJournal } from "./run-journal.js";
import type { SliceIdentity } from "./slice-lifecycle.js";

/** The cause every crash record carries, distinct from a user cancellation. */
export const CRASH_CAUSE = "CRASHED";

/** Process-fatal conditions the pipeline can observe before dying. */
export type CrashSource =
  | "uncaughtException"
  | "unhandledRejection"
  | "stream-error";

/** The `process` events this module listens on. */
export const CRASH_EVENTS = [
  "uncaughtException",
  "unhandledRejection",
] as const satisfies readonly CrashSource[];

export interface Crash {
  source: CrashSource;
  /**
   * What the pipeline was writing when a stream failed — the agent log
   * file name. Absent for the two process events, which name no target.
   */
  origin?: string;
  /**
   * One-line text for the run-state record, opening with `CRASHED`.
   * Collapsed and capped: it is read out of a JSON field.
   */
  record: string;
  /** Full operator-facing text — the stack when there is one. */
  detail: string;
}

/** Writes the crash into the run's record. Supplied by `runPipeline`. */
export type CrashRecorder = (crash: Crash) => void;

/** Node's `process`, narrowed to what the installer touches. */
export interface CrashHost {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  exit(code: number): unknown;
}

export interface CrashRecorderOptions {
  /** Defaults to `process`; injected in tests. */
  host?: CrashHost;
  /** Defaults to `console.error` — operator-facing, so not stdout. */
  log?: (message: string) => void;
  /**
   * Exit code after the record is written. Non-zero on purpose: a crash
   * must never look like a completed run to whatever launched it.
   */
  exitCode?: number;
}

/**
 * The half of the handle `runPipeline` needs. Narrow on purpose — the
 * pipeline may register a recorder and report a stream failure, and must
 * not be able to uninstall the handlers it does not own.
 */
export interface CrashRecorderRegistrar {
  /**
   * Install the run's recorder, returning the function that removes it.
   * The last registration wins: one run owns the process at a time.
   */
  register(recorder: CrashRecorder): () => void;
  /**
   * A fatal error on a stream the pipeline owns. Recorded and then fatal,
   * exactly as it was before this module existed — an unhandled `'error'`
   * event ended the process; the only change is the record.
   */
  reportFatalStreamError(error: unknown, origin?: string): void;
}

export interface CrashRecorderHandle extends CrashRecorderRegistrar {
  /** Events actually registered on this host. */
  readonly events: readonly string[];
  /** Remove the listeners once the process no longer owns a run. */
  dispose(): void;
}

/**
 * Register the crash handlers and return the handle `runPipeline` records
 * through.
 *
 * The first crash records and exits; a crash raised *while* recording is
 * dropped, because the recorder is the thing that just failed and the
 * exit is what still has to happen.
 */
export function installCrashRecorder(
  options: CrashRecorderOptions = {},
): CrashRecorderHandle {
  const host = options.host ?? (process as unknown as CrashHost);
  const log = options.log ?? ((message: string) => console.error(message));
  const exitCode = options.exitCode ?? 1;

  let recorder: CrashRecorder | undefined;
  let crashing = false;

  const fatal = (source: CrashSource, error: unknown, origin?: string) => {
    if (crashing) return;
    crashing = true;
    const crash: Crash = {
      source,
      ...(origin !== undefined ? { origin } : {}),
      record: crashRecordText(source, error, origin),
      detail: crashDetail(error),
    };
    try {
      recorder?.(crash);
    } catch (err) {
      // The ENOSPC case: the record could not be written. Say so — an
      // operator who knows the record is missing is better off than one
      // who trusts a stale entry — and carry on to the exit.
      log(
        `[afk] Could not write the crash record (${messageOf(err)}) — ` +
          `run state may still name an earlier failure`,
      );
    }
    log(`\n[afk] ${crash.record}\n${crash.detail}`);
    host.exit(exitCode);
  };

  const listeners = CRASH_EVENTS.map((event) => {
    // `unhandledRejection` passes (reason, promise); the reason is the
    // error, and the promise adds nothing a record can use.
    const listener = (...args: unknown[]) => fatal(event, args[0]);
    host.on(event, listener);
    return { event, listener };
  });

  return {
    events: CRASH_EVENTS,
    register(next: CrashRecorder) {
      recorder = next;
      return () => {
        if (recorder === next) recorder = undefined;
      };
    },
    reportFatalStreamError(error: unknown, origin?: string) {
      fatal("stream-error", error, origin);
    },
    dispose() {
      for (const { event, listener } of listeners) host.off(event, listener);
    },
  };
}

/**
 * What a crash writes: the same bookkeeping a stop writes (ADR 0040),
 * with `CRASHED` as the cause instead of "Cancelled by user".
 *
 * `inFlight` is a hook rather than a list because a crash can happen
 * before the run scope resolves — the pipeline passes the same one its
 * abort listener uses, so both paths record the slices that were really
 * dispatched at that moment, and neither invents one.
 *
 * Everything here is best-effort and synchronous, because the caller
 * exits the process as soon as it returns: the journal swallows its own
 * write failures per slice, and this is the last chance to say anything
 * at all about the run. That is also why `run-ended` is emitted here —
 * the normal end-of-run event never gets to fire.
 */
export function crashRecorderFor(
  journal: RunJournal,
  inFlight: () => SliceIdentity[],
): CrashRecorder {
  return (crash: Crash) => {
    const marked = journal.markCancelledInFlight(inFlight(), crash.record);
    const detail =
      marked.length > 0
        ? `marked CANCELLED in run state: ${marked.map((id) => `#${id}`).join(", ")}`
        : "no slice had work in flight";
    const message = `${crash.record} — ${detail}`;
    journal.phase(`[afk] ${message}`, "error", {
      type: "warn",
      reason: "crashed",
      message,
    });
    journal.event({ type: "run-ended", outcome: "FAILED" });
  };
}

/**
 * The one-line cause text a crash persists, e.g.
 * `CRASHED (stream-error: slice-05-generator-r2.log): ENOSPC: no space
 * left on device, write`.
 *
 * Names the source as well as the message because they answer different
 * questions: the message says what went wrong, the source says whether
 * the pipeline was even in a position to see it coming.
 */
export function crashRecordText(
  source: CrashSource,
  error: unknown,
  origin?: string,
): string {
  const where = origin ? `${source}: ${origin}` : source;
  return `${CRASH_CAUSE} (${where}): ${messageOf(error)}`;
}

/** Stack when the value is an Error, else the value's own text. */
export function crashDetail(error: unknown): string {
  if (error instanceof Error && typeof error.stack === "string") {
    return error.stack;
  }
  return messageOf(error);
}

/**
 * A crash's message as one capped line. A record read out of a JSON field
 * has to stay readable, and a rejected value can be anything at all —
 * including `undefined`, which must not persist as the string "undefined"
 * pretending to be a reason.
 */
function messageOf(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error === undefined || error === null
          ? ""
          : safeStringify(error);
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "no error text";
  return collapsed.length > 400 ? `${collapsed.slice(0, 397)}...` : collapsed;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
