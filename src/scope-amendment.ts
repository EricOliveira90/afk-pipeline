import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCEPTANCE_MANIFEST_FILENAME,
  acceptanceManifestPaths,
  normalizeAcceptanceManifestPath,
  parseAcceptanceManifest,
  type AcceptanceManifest,
} from "./acceptance-manifest.js";
import { migrationPathsIn, type LaneResourceOptions } from "./lanes.js";
import type { QAReviewStage } from "./qa-review.js";

/**
 * Widening a locked contract's file scope after the fact.
 *
 * The failure this exists for (#112): QA can find that a change is
 * *correct* but touches a file the locked contract never declared. The
 * generator owns no part of the locked file list, so a finding like that
 * routed to the generator leaves it exactly one way to comply — delete
 * its own working code. On the evidence-backbone run it did, and a
 * ninety-minute round ended with seven tests broken by a destructive
 * remedy for a bookkeeping problem.
 *
 * The contract is the orchestrator's to write (ADR 0008), so the
 * amendment is the orchestrator's to perform. Everything here is called
 * from the QA loop and nowhere else; agents do not edit the file scope.
 *
 * The amendment only ever *adds* paths. Behaviors, the migration count,
 * and every other term of the contract are untouched — those are the
 * negotiation's to change, and a finding that needs one of them changed
 * is not a bookkeeping gap.
 */

export const CONTRACT_FILES_HEADING = "## Files expected to change";

export interface ScopeAmendmentRequest {
  findingId: string;
  paths: readonly string[];
}

export interface ScopeAmendmentEntry {
  /**
   * The path as the evaluator wrote it (forward-slashed only). Declared
   * verbatim rather than in normalized form: normalization lowercases,
   * and a lowercased path is the wrong path on a case-sensitive
   * filesystem.
   */
  path: string;
  /** Normalized comparison key, by the manifest's own rules. */
  key: string;
  /** The finding that asked for it, carried into the bullet and record. */
  findingId: string;
}

export type ScopeAmendmentPlan =
  | { ok: true; entries: ScopeAmendmentEntry[]; findingIds: string[] }
  | { ok: false; refusal: string };

export interface ScopeAmendmentRecord {
  version: 1;
  stage: QAReviewStage;
  round: number;
  attempt: number;
  findingIds: string[];
  paths: string[];
}

/**
 * Decide whether every requested path may join the locked file scope, or
 * refuse and say why in one message an operator can act on.
 *
 * Refusals are collected rather than short-circuited: an operator who has
 * to hand-amend wants the whole list, not the first path in it.
 *
 * `changedFiles` is what the slice actually touched. A path the slice
 * never touched is refused, because declaring it would tell the next
 * wave's lane partitioner that this slice owns a file it never wrote —
 * the same class of misleading record this fix exists to remove.
 */
export function planScopeAmendment(args: {
  requests: readonly ScopeAmendmentRequest[];
  manifest: AcceptanceManifest;
  changedFiles: readonly string[];
  options?: LaneResourceOptions;
}): ScopeAmendmentPlan {
  const { requests, manifest, changedFiles, options } = args;
  const findingIds = [...new Set(requests.map((request) => request.findingId))];
  if (requests.every((request) => request.paths.length === 0)) {
    return { ok: false, refusal: "no paths were requested" };
  }
  if (manifest.fileScope.kind !== "paths") {
    return {
      ok: false,
      refusal:
        `the locked ${ACCEPTANCE_MANIFEST_FILENAME} declares ` +
        `no-repository-changes, and a slice that was scoped to change no ` +
        `files cannot be widened by amendment — it needs the contract ` +
        `renegotiated`,
    };
  }

  const declared = new Set(acceptanceManifestPaths(manifest));
  const changed = new Set(
    changedFiles.map((path) => path.trim().replace(/\\/g, "/").toLowerCase()),
  );
  const problems: string[] = [];
  const entries: ScopeAmendmentEntry[] = [];
  const seen = new Set<string>();

  for (const request of requests) {
    for (const raw of request.paths) {
      let key: string;
      try {
        key = normalizeAcceptanceManifestPath(raw);
      } catch (error) {
        problems.push(
          `"${raw}" is not a declarable path (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
        continue;
      }
      if (declared.has(key)) {
        problems.push(
          `"${raw}" is already on the locked file scope, so no amendment ` +
            `can clear the finding that asked for it`,
        );
        continue;
      }
      if (migrationPathsIn([key], options).length > 0) {
        problems.push(
          `"${raw}" is a migration file, and migration prefixes are ` +
            `allocated at contract lock (ADR 0028/0034) — it cannot be ` +
            `added after the lock`,
        );
        continue;
      }
      if (!changed.has(key)) {
        problems.push(
          `"${raw}" is not among the files this slice changed, so there is ` +
            `no work in it to bring into scope`,
        );
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        path: raw.trim().replace(/\\/g, "/"),
        key,
        findingId: request.findingId,
      });
    }
  }

  if (problems.length > 0) {
    return { ok: false, refusal: problems.join("; ") };
  }
  return { ok: true, entries, findingIds };
}

/**
 * Add the planned paths to the slice's `acceptance-manifest.json` and to
 * the contract's human-readable file list, keeping the two in sync the
 * way the planner is required to.
 *
 * The manifest is edited as raw JSON rather than re-serialized from the
 * parsed value: parsing lowercases the declared paths, and writing that
 * back would rename every path the planner declared with a capital in
 * it. Re-parsed afterwards so a write that produced an artifact the
 * pipeline would later refuse fails here, where the slice can still be
 * stopped, instead of at the next gate.
 */
export function applyScopeAmendment(args: {
  sliceDir: string;
  plan: Extract<ScopeAmendmentPlan, { ok: true }>;
}): void {
  const { sliceDir, plan } = args;
  const manifestPath = join(sliceDir, ACCEPTANCE_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    throw new Error(`${manifestPath} is missing`);
  }
  const raw = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    fileScope?: { kind?: string; paths?: unknown };
  };
  if (
    raw.fileScope?.kind !== "paths" ||
    !Array.isArray(raw.fileScope.paths)
  ) {
    throw new Error(
      `${manifestPath} fileScope must declare paths to be amended`,
    );
  }
  raw.fileScope.paths = [
    ...raw.fileScope.paths,
    ...plan.entries.map((entry) => entry.path),
  ];
  const text = `${JSON.stringify(raw, null, 2)}\n`;
  parseAcceptanceManifest(text, manifestPath);
  writeFileSync(manifestPath, text, "utf-8");

  appendContractScopeFiles(
    join(sliceDir, "contract.md"),
    plan.entries,
  );
}

/**
 * Append one bullet per amended path under the contract's
 * `## Files expected to change`, naming the finding that asked for it so
 * the next reader of the contract can see which lines the orchestrator
 * added and why.
 *
 * A contract with no such section is refused rather than repaired: the
 * generator reads that list as its write boundary, and inventing the
 * section here would hide a contract the planner never wrote correctly.
 */
export function appendContractScopeFiles(
  contractPath: string,
  entries: readonly ScopeAmendmentEntry[],
): void {
  if (!existsSync(contractPath)) {
    throw new Error(`${contractPath} is missing`);
  }
  const content = readFileSync(contractPath, "utf-8");
  const heading = content.match(/^##[ \t]+Files expected to change[ \t]*$/im);
  if (!heading || heading.index === undefined) {
    throw new Error(
      `${contractPath} has no "${CONTRACT_FILES_HEADING}" section to amend`,
    );
  }

  const bodyStart = heading.index + heading[0].length;
  const after = content.slice(bodyStart);
  const nextHeading = after.match(/^##[ \t]+/m);
  const bodyEnd =
    nextHeading?.index !== undefined
      ? bodyStart + nextHeading.index
      : content.length;
  const body = content.slice(bodyStart, bodyEnd).replace(/\s+$/, "");
  const bullets = entries
    .map(
      (entry) =>
        `- ${entry.path} (added by scope amendment for QA finding ${entry.findingId})`,
    )
    .join("\n");
  const tail = content.slice(bodyEnd);

  writeFileSync(
    contractPath,
    `${content.slice(0, bodyStart)}${body}\n${bullets}\n${
      tail === "" ? "" : `\n${tail}`
    }`,
    "utf-8",
  );
}

export function buildScopeAmendmentRecord(args: {
  stage: QAReviewStage;
  round: number;
  attempt: number;
  plan: Extract<ScopeAmendmentPlan, { ok: true }>;
}): ScopeAmendmentRecord {
  const { stage, round, attempt, plan } = args;
  return {
    version: 1,
    stage,
    round,
    attempt,
    findingIds: [...plan.findingIds],
    paths: plan.entries.map((entry) => entry.path),
  };
}
