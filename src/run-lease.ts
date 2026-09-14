/**
 * Host-wide AFK run lease (#275).
 *
 * One heavy AFK run per machine, enforced rather than advised: concurrent
 * pipeline runs degraded execution 3–5× and destabilized the host. The
 * canonical lease is an atomically-published directory under `os.tmpdir()`
 * at `afk-pipeline/run-lease` — machine-wide for the operator account and
 * independent of cwd, repository, PRD, worktree, and provider binary.
 *
 * This is deliberately not `withFileLock` (src/file-lock.ts): that is a
 * spin-waiting critical section around one run-state file, held for
 * milliseconds. The run lease is held for hours, is never waited on
 * (contention refuses immediately), and its staleness rules must survive
 * PID reuse — so the owner record carries a process-birth identity and a
 * dead-or-reused verdict is required before any takeover. It is also not
 * the stop sentinel (delivery of a stop request, ADR 0043) and not the
 * in-run merge/preview mutexes (serialization inside or between phases of
 * one run). See ADR 0069.
 *
 * Publication protocol: build the owner record in a uniquely-named staging
 * directory, then `renameSync` it onto the canonical path. The canonical
 * directory therefore always appears with a complete `owner.json` inside —
 * a reader never observes a half-written owner. A rename onto an existing
 * non-empty directory fails on every platform, which is the atomic
 * "somebody else holds it" signal.
 *
 * Staleness protocol: probe PID liveness and process-birth identity. A
 * missing PID, or a live PID whose birth identity differs from the
 * recorded one (PID reuse), is conclusively stale; the stale directory is
 * atomically renamed aside to a uniquely-named quarantine path (only one
 * contender's rename can win), the canonical path is re-acquired, and the
 * quarantined directory is removed afterwards. Anything short of a
 * conclusive verdict — corrupt owner record, unreadable identity, foreign
 * hostname — fails closed and requires `--allow-concurrent-run`; age alone
 * never proves staleness.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname as osHostname, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** The versioned record published inside the lease directory. */
export interface RunLeaseOwner {
  version: 1;
  /** Random per-acquisition id; release matches on it, never on PID alone. */
  leaseId: string;
  pid: number;
  /**
   * Process-birth identity of `pid` at acquisition time — an opaque,
   * platform-specific start-time string (see {@link probeProcessBirth}).
   * Empty when the owner could not probe its own identity; such a lease is
   * unverifiable to contenders and fails closed rather than being reaped.
   */
  birth: string;
  hostname: string;
  provider: string;
  prdSlug: string;
  prdDir: string;
  cwd: string;
  argv: string[];
  acquiredAt: string;
}

/** Probe seams injected by unit tests; production uses the real host. */
export interface LeaseProbes {
  pidIsAlive(pid: number): boolean;
  processBirth(pid: number): string | undefined;
  hostname(): string;
  now(): Date;
}

export type OwnerVerdict =
  | { kind: "live" }
  | { kind: "stale"; reason: string }
  | { kind: "unverifiable"; reason: string };

export interface RunLeaseHandle {
  /** False under `--allow-concurrent-run` when another owner was left in place. */
  readonly held: boolean;
  /** Path of the canonical lease directory this handle refers to. */
  readonly leasePath: string;
  /**
   * Remove the canonical lease, but only after re-reading `owner.json` and
   * matching this acquisition's lease id — an old owner's cleanup can never
   * remove a successor's lease. Idempotent; never throws (it runs inside
   * `process.on("exit")`).
   */
  release(): void;
}

export type AcquireRunLeaseResult =
  | {
      outcome: "acquired";
      handle: RunLeaseHandle;
      /** Present when a conclusively stale owner was recovered on the way in. */
      recovered?: { owner: RunLeaseOwner | null; reason: string };
    }
  | {
      outcome: "refused";
      /** `live-owner` or `unverifiable-owner`; both print and exit 2. */
      reason: "live-owner" | "unverifiable-owner";
      owner: RunLeaseOwner | null;
      message: string;
    }
  | {
      /** `--allow-concurrent-run` against a live/unverifiable owner. */
      outcome: "proceeding-without-lease";
      owner: RunLeaseOwner | null;
      warning: string;
    };

export interface AcquireRunLeaseRequest {
  provider: string;
  prdSlug: string;
  prdDir: string;
  allowConcurrentRun?: boolean;
}

export interface AcquireRunLeaseOptions {
  /** Defaults to `join(os.tmpdir(), "afk-pipeline")`; injected in tests. */
  baseDir?: string;
  probes?: LeaseProbes;
  /** Race-retry bound; losing contenders re-read and retry up to this. */
  maxAttempts?: number;
}

const LEASE_DIR_NAME = "run-lease";
const OWNER_FILE = "owner.json";
const DEFAULT_MAX_ATTEMPTS = 5;

export function defaultLeaseBaseDir(): string {
  return join(tmpdir(), "afk-pipeline");
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not ours — alive.
    return errorCode(error) !== "ESRCH";
  }
}

/**
 * Read the OS's start-time identity for `pid`, or undefined when it cannot
 * be determined (no such process, listing tool unavailable). The value is
 * opaque: it is only ever compared for exact equality against a value the
 * same probe recorded earlier on the same host.
 *
 * Windows uses PowerShell CIM — never `wmic` (removed from current
 * Windows 11) or `tasklist` (localized), the same conclusion
 * `src/kill-tree.ts` encodes. Linux reads `/proc/<pid>/stat` field 22
 * (start time in clock ticks since boot — stable for the process's
 * lifetime and free of formatting concerns). Elsewhere `ps -o lstart=`
 * gives a stable full start timestamp.
 */
export function probeProcessBirth(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (platform === "win32") {
    const result = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate.ToFileTimeUtc()`,
      ],
      { encoding: "utf-8", timeout: 30_000, windowsHide: true },
    );
    const out = result.stdout?.trim();
    return result.status === 0 && out && /^\d+$/.test(out) ? out : undefined;
  }
  if (platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      // comm (field 2) may contain spaces/parens; fields resume after the
      // last ")". starttime is field 22 overall = index 19 after field 3.
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const starttime = rest[19];
      return starttime && /^\d+$/.test(starttime) ? starttime : undefined;
    } catch {
      return undefined;
    }
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  const out = result.stdout?.trim();
  return result.status === 0 && out ? out : undefined;
}

export function defaultLeaseProbes(): LeaseProbes {
  return {
    pidIsAlive,
    processBirth: (pid) => probeProcessBirth(pid),
    hostname: () => osHostname(),
    now: () => new Date(),
  };
}

/** Parse `owner.json` content. Null means corrupt — never guessed stale. */
export function parseRunLeaseOwner(text: string): RunLeaseOwner | null {
  let value: Partial<RunLeaseOwner>;
  try {
    value = JSON.parse(text) as Partial<RunLeaseOwner>;
  } catch {
    return null;
  }
  if (
    value === null ||
    typeof value !== "object" ||
    value.version !== 1 ||
    typeof value.leaseId !== "string" ||
    value.leaseId === "" ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.birth !== "string" ||
    typeof value.hostname !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.prdSlug !== "string" ||
    typeof value.prdDir !== "string" ||
    typeof value.cwd !== "string" ||
    !Array.isArray(value.argv) ||
    !value.argv.every((entry) => typeof entry === "string") ||
    typeof value.acquiredAt !== "string"
  ) {
    return null;
  }
  return value as RunLeaseOwner;
}

/**
 * Classify the current owner. Pure given the injected probes.
 *
 * The one hard guarantee: a live process is never classified stale. `stale`
 * requires a conclusive negative — the PID is gone, or the PID is alive but
 * provably a different process (birth identity mismatch). Every ambiguous
 * reading (corrupt record, foreign hostname, unreadable identity, an owner
 * that never recorded its own identity) is `unverifiable` and fails closed.
 */
export function classifyLeaseOwner(
  owner: RunLeaseOwner | null,
  probes: LeaseProbes,
): OwnerVerdict {
  if (owner === null) {
    return {
      kind: "unverifiable",
      reason: "the lease's owner.json is missing or corrupt",
    };
  }
  if (owner.hostname !== probes.hostname()) {
    return {
      kind: "unverifiable",
      reason: `the lease was acquired on host "${owner.hostname}" and this is "${probes.hostname()}" — a foreign PID cannot be probed`,
    };
  }
  if (!probes.pidIsAlive(owner.pid)) {
    return { kind: "stale", reason: `owner PID ${owner.pid} no longer exists` };
  }
  if (owner.birth === "") {
    return {
      kind: "unverifiable",
      reason: `owner PID ${owner.pid} is alive but recorded no process-birth identity, so it cannot be told apart from a PID reuse`,
    };
  }
  const currentBirth = probes.processBirth(owner.pid);
  if (currentBirth === undefined) {
    return {
      kind: "unverifiable",
      reason: `owner PID ${owner.pid} is alive but its process-birth identity could not be read`,
    };
  }
  if (currentBirth !== owner.birth) {
    return {
      kind: "stale",
      reason:
        `owner PID ${owner.pid} was reused by a different process ` +
        `(recorded birth ${owner.birth}, current ${currentBirth})`,
    };
  }
  return { kind: "live" };
}

function readOwnerFile(leasePath: string): RunLeaseOwner | null {
  try {
    return parseRunLeaseOwner(readFileSync(join(leasePath, OWNER_FILE), "utf-8"));
  } catch {
    return null;
  }
}

function ownerAgeDescription(owner: RunLeaseOwner, now: Date): string {
  const acquired = Date.parse(owner.acquiredAt);
  if (!Number.isFinite(acquired)) return owner.acquiredAt;
  const minutes = Math.max(0, Math.round((now.getTime() - acquired) / 60_000));
  return `${owner.acquiredAt} (${minutes} min ago)`;
}

/** Owner details for refusals/warnings — names the evidence, like prd-hold. */
function describeOwner(
  owner: RunLeaseOwner | null,
  leasePath: string,
  now: Date,
): string {
  if (owner === null) {
    return `  Lease: ${leasePath}\n  Owner: unreadable (owner.json missing or corrupt)`;
  }
  return [
    `  Lease: ${leasePath}`,
    `  Owner PID: ${owner.pid}`,
    `  Started: ${ownerAgeDescription(owner, now)}`,
    `  Provider: ${owner.provider}`,
    `  PRD: ${owner.prdSlug} (${owner.prdDir})`,
    `  Cwd: ${owner.cwd}`,
    `  Command: ${owner.argv.join(" ")}`,
  ].join("\n");
}

const OVERRIDE_INSTRUCTION =
  "To run anyway alongside it, relaunch with --allow-concurrent-run " +
  "(expect heavy contention; the other run's lease is left untouched).";

/**
 * Acquire the host-wide run lease, or explain why not.
 *
 * Race safety: publication is a rename onto the canonical path (one winner);
 * a stale takeover renames the old directory aside first (one winner);
 * losing contenders re-read the then-current owner and re-classify, up to
 * `maxAttempts`. A quarantined stale directory is uniquely named and owned
 * by the contender that renamed it, so removing it can never touch a
 * successor's canonical lease.
 */
export function acquireHostRunLease(
  request: AcquireRunLeaseRequest,
  options: AcquireRunLeaseOptions = {},
): AcquireRunLeaseResult {
  const baseDir = options.baseDir ?? defaultLeaseBaseDir();
  const probes = options.probes ?? defaultLeaseProbes();
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const leasePath = join(baseDir, LEASE_DIR_NAME);
  mkdirSync(baseDir, { recursive: true });

  const leaseId = randomUUID();
  const record: RunLeaseOwner = {
    version: 1,
    leaseId,
    pid: process.pid,
    birth: probes.processBirth(process.pid) ?? "",
    hostname: probes.hostname(),
    provider: request.provider,
    prdSlug: request.prdSlug,
    prdDir: request.prdDir,
    cwd: process.cwd(),
    argv: [...process.argv],
    acquiredAt: probes.now().toISOString(),
  };

  let recovered: { owner: RunLeaseOwner | null; reason: string } | undefined;
  // Quarantine directories this contender renamed aside; removed on every
  // way out, win or lose — they are uniquely named and exclusively ours.
  const quarantines: string[] = [];
  const cleanupQuarantines = () => {
    for (const path of quarantines.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  };

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Publish atomically: stage the complete record, rename into place.
      const stagingPath = join(baseDir, `${LEASE_DIR_NAME}.pending-${leaseId}`);
      rmSync(stagingPath, { recursive: true, force: true });
      mkdirSync(stagingPath, { recursive: true });
      writeFileSync(
        join(stagingPath, OWNER_FILE),
        JSON.stringify(record, null, 2),
      );
      let acquiredNow = false;
      try {
        renameSync(stagingPath, leasePath);
        acquiredNow = true;
      } catch (error) {
        rmSync(stagingPath, { recursive: true, force: true });
        // Windows reports EPERM/EACCES for rename onto an existing
        // directory; POSIX reports ENOTEMPTY/EEXIST. Anything else is a
        // real filesystem error.
        const code = errorCode(error);
        if (
          code !== "EEXIST" &&
          code !== "ENOTEMPTY" &&
          code !== "EPERM" &&
          code !== "EACCES"
        ) {
          throw error;
        }
      }
      if (acquiredNow) {
        return {
          outcome: "acquired",
          handle: makeHandle(leasePath, leaseId),
          recovered,
        };
      }

      // Contended. If the canonical directory vanished between the failed
      // rename and now, the owner released — just retry.
      if (!existsSync(leasePath)) continue;
      const owner = readOwnerFile(leasePath);
      // An unreadable owner whose directory is already gone is a release
      // observed mid-read, not a corrupt lease.
      if (owner === null && !existsSync(leasePath)) continue;
      const verdict = classifyLeaseOwner(owner, probes);

      if (verdict.kind === "stale") {
        // One winner: renaming the canonical path aside is atomic; the
        // loser gets ENOENT and re-reads whatever the winner published.
        const quarantinePath = join(
          baseDir,
          `${LEASE_DIR_NAME}.stale-${randomUUID()}`,
        );
        try {
          renameSync(leasePath, quarantinePath);
          quarantines.push(quarantinePath);
          recovered = { owner, reason: verdict.reason };
        } catch (error) {
          const code = errorCode(error);
          if (code !== "ENOENT" && code !== "EPERM" && code !== "EACCES") {
            throw error;
          }
        }
        continue;
      }

      const now = probes.now();
      if (request.allowConcurrentRun) {
        return {
          outcome: "proceeding-without-lease",
          owner,
          warning: [
            "",
            "!".repeat(72),
            "WARNING: --allow-concurrent-run — starting a second AFK run on this host.",
            verdict.kind === "live"
              ? "Another AFK run holds the host run lease:"
              : `The host run lease has an owner that cannot be verified (${verdict.reason}):`,
            describeOwner(owner, leasePath, now),
            "This run proceeds WITHOUT the lease. The existing owner's lease is",
            "left untouched and will not be released by this process. Expect",
            "significant contention (3-5x slowdowns were measured).",
            "!".repeat(72),
            "",
          ].join("\n"),
        };
      }
      return {
        outcome: "refused",
        reason: verdict.kind === "live" ? "live-owner" : "unverifiable-owner",
        owner,
        message:
          verdict.kind === "live"
            ? [
                "Error: another AFK run already holds this host's run lease; refusing to start a second one.",
                describeOwner(owner, leasePath, now),
                OVERRIDE_INSTRUCTION,
              ].join("\n")
            : [
                `Error: the host run lease has an owner that cannot be verified (${verdict.reason}); failing closed.`,
                describeOwner(owner, leasePath, now),
                "Age alone never proves staleness. If you are certain no AFK run is alive on this host,",
                "remove the lease directory by hand, or relaunch with --allow-concurrent-run.",
              ].join("\n"),
      };
    }

    // Retry budget exhausted while losing publication races.
    const owner = readOwnerFile(leasePath);
    if (request.allowConcurrentRun) {
      return {
        outcome: "proceeding-without-lease",
        owner,
        warning: [
          "",
          "!".repeat(72),
          `WARNING: --allow-concurrent-run — the host run lease stayed contended across ${maxAttempts} attempts.`,
          describeOwner(owner, leasePath, probes.now()),
          "This run proceeds WITHOUT the lease. The existing owner's lease is",
          "left untouched and will not be released by this process.",
          "!".repeat(72),
          "",
        ].join("\n"),
      };
    }
    return {
      outcome: "refused",
      reason: "live-owner",
      owner,
      message: [
        `Error: could not acquire the host run lease after ${maxAttempts} attempts (persistent contention).`,
        describeOwner(owner, leasePath, probes.now()),
        OVERRIDE_INSTRUCTION,
      ].join("\n"),
    };
  } finally {
    cleanupQuarantines();
  }
}

function makeHandle(leasePath: string, leaseId: string): RunLeaseHandle {
  let released = false;
  return {
    held: true,
    leasePath,
    release() {
      if (released) return;
      released = true;
      try {
        const owner = readOwnerFile(leasePath);
        if (owner?.leaseId !== leaseId) return; // successor's lease — keep out
        rmSync(leasePath, { recursive: true, force: true });
      } catch {
        // Release runs inside process "exit"; a throw there would mask the
        // run's real exit. A leaked lease is recovered as stale next launch.
      }
    },
  };
}

function unheldHandle(leasePath: string): RunLeaseHandle {
  return { held: false, leasePath, release() {} };
}

/**
 * The shared acquire-or-exit boundary used identically by the three
 * pipeline CLIs (`afk`, `afk-claude`, `afk-codex`).
 *
 * On refusal it prints the owner and the override instruction and exits 2 —
 * before any run state, run directory, branch, worktree, agent, or gate
 * side effect. On acquisition it registers the release on `process`'s
 * "exit" event, which fires on every ordinary way out of the entries —
 * normal success, `process.exit(1)` after a blocked ship, the
 * `PipelineError` handler, the fatal-error catch, clean cancellation's
 * wind-down, and the second-signal hard exit — so the entries need no
 * bespoke unwind code around their existing `process.exit` calls. Release
 * is compare-before-delete and idempotent, so the extra explicit `finally`
 * in the entries and this hook cannot double-fire destructively. Only an
 * entry point may call this: it prints, exits, and hooks the process.
 */
export function acquireHostRunLeaseOrExit(
  request: AcquireRunLeaseRequest,
  options: AcquireRunLeaseOptions = {},
): RunLeaseHandle {
  const result = acquireHostRunLease(request, options);
  if (result.outcome === "refused") {
    console.error(result.message);
    process.exit(2);
  }
  if (result.outcome === "proceeding-without-lease") {
    console.error(result.warning);
    return unheldHandle(
      join(options.baseDir ?? defaultLeaseBaseDir(), LEASE_DIR_NAME),
    );
  }
  if (result.recovered) {
    console.error(
      `Recovered a stale host run lease (${result.recovered.reason}); previous owner: ` +
        `${result.recovered.owner ? `PID ${result.recovered.owner.pid}, ${result.recovered.owner.provider}, PRD ${result.recovered.owner.prdSlug}` : "unreadable"}.`,
    );
  }
  const { handle } = result;
  process.once("exit", () => handle.release());
  return handle;
}
