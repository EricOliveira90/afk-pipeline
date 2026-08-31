import {
  ACCEPTANCE_MANIFEST_FILENAME,
  acceptanceManifestPaths,
  normalizeAcceptanceManifestPath,
  type AcceptanceManifest,
} from "./acceptance-manifest.js";
import { parseJsonWithUniqueKeys } from "./json-scan.js";
import { migrationPathsIn, type LaneResourceOptions } from "./lanes.js";

export const ESCALATION_FILENAME = "escalation.md";

/**
 * The two files at a slice's artifact root that no agent may write: the
 * accepted `contract.md` / `acceptance-manifest.json` pair, mutated only
 * by the shared contract transaction (ADR 0055 Seam 1 §3, ADR 0048).
 *
 * Named once and used twice — by the changed-set guard's carve-out below
 * and by the orchestrator's per-invocation integrity check — so the answer
 * to "which files are the orchestrator's" cannot drift between the guard
 * that refuses a widened lock and the check that restores one.
 */
export const ORCHESTRATOR_OWNED_SLICE_FILENAMES: readonly string[] = [
  "contract.md",
  ACCEPTANCE_MANIFEST_FILENAME,
];

/**
 * The reserved `findingIds` identity for a **pre-build scope discovery**:
 * a generator that learns the locked file scope is too narrow *before* it
 * has any finding to cite.
 *
 * `findingIds` stays mandatory and an empty list stays a refusal — that
 * fail-closed check is what stops a generator from widening its own scope
 * on an unexplained whim (story 13). But the first generator invocation of
 * a round-1 slice is handed no QA findings at all, so a real finding ID is
 * an identity it cannot honestly produce. Without a reserved value the
 * only schema-valid escalations were the QA-driven ones, and the PRD's
 * original pre-build deadlock — discover the scope is wrong, have no legal
 * way to say so — remained reachable. See ADR 0052.
 *
 * It is an identity, not an escape hatch: `reason` is still required, the
 * paths are still validated against the locked manifest, and it may not be
 * mixed with real finding IDs. An escalation is either a pre-build
 * discovery or a cited-finding fix; claiming both describes no single
 * event, and accepting the mixture would let a QA-driven generator launder
 * an uncited path in beside a cited one.
 */
export const PRE_BUILD_SCOPE_FINDING_ID = "PRE-BUILD-SCOPE";

export interface ScopeEscalation {
  version: 1;
  findingIds: string[];
  paths: string[];
  reason: string;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  source: string,
): void {
  const keys = Object.keys(value);
  const expectedSet = new Set(expected);
  if (
    keys.some((key) => !expectedSet.has(key)) ||
    expected.some((key) => !(key in value))
  ) {
    throw new Error(
      `${source} root object must contain exactly ${expected.join(", ")}`,
    );
  }
}

function parseNonBlankStrings(
  value: unknown,
  field: "findingIds" | "paths",
  source: string,
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${source} ${field} must be a non-empty array`);
  }
  if (
    value.some(
      (item) => typeof item !== "string" || item.trim() === "",
    )
  ) {
    throw new Error(
      `${source} ${field} must contain only non-blank strings`,
    );
  }
  return (value as string[]).map((item) => item.trim());
}

function displayPath(raw: string): string {
  let path = raw.trim().replace(/\\/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  return path;
}

/**
 * Normalize a directory to the same comparison key the manifest uses for a
 * file path, minus the "must name a file" rule: trimmed, forward-slashed,
 * `./`-stripped, trailing-slash-stripped, lowercased. Deliberately the
 * manifest's own rules — the prefix is compared against keys produced by
 * `normalizeAcceptanceManifestPath`, so a second normalization dialect here
 * would exempt a directory on Windows and refuse it on Linux.
 */
function normalizeDirKey(raw: string): string {
  let dir = raw.trim().replace(/\\/g, "/");
  while (dir.startsWith("./")) dir = dir.slice(2);
  return dir.replace(/\/+$/, "").toLowerCase();
}

/**
 * Changed paths this worktree holds that the locked contract does not
 * declare — the guard that stops an escalation laundering an edit that
 * already happened (architect blocker 1, fifth adjudication gate round).
 *
 * ## Why the two scope doors are deliberately asymmetric
 *
 * `planScopeAmendment` (`scope-amendment.ts`) **requires** the requested
 * path to be already changed; this door **forbids** any undeclared change
 * at all. That is not a contradiction, it is the whole design:
 *
 * - The amendment's warrant is an independent QA finding. A generator
 *   cannot forge one, so "the work is already there" is evidence that an
 *   evaluator judged the work correct and only the bookkeeping is wrong
 *   (#112). Refusing a path with no work in it would declare a file the
 *   slice never wrote.
 * - The escalation's warrant is written by the generator itself. "The work
 *   is already there" is therefore not evidence of anything — it is exactly
 *   the state the route exists to prevent. ADR 0052 defines this route as a
 *   *pre-build discovery*: the generator stops **before** the undeclared
 *   edit, says which path it needs, and builds after the contract is
 *   revised. Both generator prompts say "Stop before making the undeclared
 *   edit" in those words. A tree that already holds the edit is a generator
 *   that did not follow the protocol, and granting the revision would
 *   retro-authorize the boundary violation the locked contract exists to
 *   hold (ADR 0008/0048: the contract is the orchestrator's).
 *
 * ## Why the FULL changed set, not just the requested paths
 *
 * Checking only `escalation.paths` leaves the laundering intact one step
 * removed: edit undeclared `X`, escalate for unrelated `Y`, and `X` sails
 * through the grant untouched. The question the grant has to answer is
 * "is this tree still inside its lock", and that is a question about every
 * changed path.
 *
 * ## The two exemptions, and why they are these
 *
 * - **The slice artifact directory, by directory prefix, minus the two
 *   orchestrator-owned files at its root.** The slice's own artifacts live
 *   in the worktree and are written by the pipeline and the agents as a
 *   matter of course — `escalation.md` most of all, since it is the very
 *   file that triggers this check. The exemption is a prefix and not a
 *   filename list on purpose: `artifacts.sliceArtifactNames()` omits
 *   `escalation.md`, `acceptance-manifest.json` and both adjudication
 *   files, so a list-based exemption would refuse every honest escalation
 *   on its own escalation artifact.
 *
 *   `contract.md` and `acceptance-manifest.json` at the slice root are
 *   carved back out of that prefix unless the caller passes
 *   `acceptedPairIntact` (architect A1, seventh gate round). They are not
 *   agent-writable artifacts: they are the accepted pair the shared
 *   contract transaction alone mutates (ADR 0055 Seam 1 §3, ADR 0048). An
 *   unconditional prefix exemption let a generator add an undeclared source
 *   path to *both* locked files, escalate for some unrelated path, and have
 *   this guard wave the widened lock through — the focused revision then
 *   captured the generator's own bytes as "the previously accepted pair"
 *   and its additive guard preserved the smuggled path.
 *
 *   The exemption cannot simply be dropped: both files live inside the
 *   worktree and are written during negotiation, so `git` reports them as
 *   changed against the feature branch on every honest escalation too.
 *   What separates the honest tree from the laundered one is not *whether*
 *   they changed but *whose* bytes they hold, and that is a question only
 *   the caller holding the orchestrator's pre-dispatch snapshot can answer.
 *   So the caller answers it: `acceptedPairIntact` is that answer, and it
 *   has no default — a caller that cannot prove the pair still holds the
 *   accepted bytes says `false` and gets both files named.
 * - **Migration files.** `fileScope` forbids placeholders and globs, and a
 *   migration's exact filename is chosen at build time, so a migration can
 *   never be a declared path — `planScopeAmendment` refuses migration paths
 *   for exactly that reason. Migrations are governed by the reserved-prefix
 *   claim gate (`checkClaimedGeneratedMigrations`, ADR 0028/0034), which
 *   runs on this same tree before QA. Not exempting them here would refuse
 *   every escalation from every slice that has a migration to write.
 *
 * Anything else is out of scope, including other paths under `specsDir`
 * that are not this slice's own artifact directory.
 *
 * A path git reported that the manifest's rules cannot even normalize is
 * reported as out-of-scope rather than skipped: an unclassifiable path is
 * not a proof that the tree is clean.
 */
export function outOfScopeChangedPaths(args: {
  changedFiles: readonly string[];
  manifest: AcceptanceManifest;
  /**
   * Repo-relative slice artifact directory, exempt with everything under
   * it — except the two orchestrator-owned files at its root, which are
   * exempt only under `acceptedPairIntact`.
   */
  sliceArtifactDir: string;
  /**
   * The caller's attestation that `contract.md` and
   * `acceptance-manifest.json` still hold the bytes the orchestrator
   * accepted — proven, not assumed. No default: see the docstring.
   */
  acceptedPairIntact: boolean;
  options?: LaneResourceOptions;
}): string[] {
  const {
    changedFiles,
    manifest,
    sliceArtifactDir,
    acceptedPairIntact,
    options,
  } = args;
  const declared = new Set(acceptanceManifestPaths(manifest));
  const artifactDir = normalizeDirKey(sliceArtifactDir);
  /**
   * The orchestrator-owned pair, normalized the manifest's way so the
   * carve-out matches on every platform and casing — the same reason the
   * prefix test below normalizes rather than comparing raw strings.
   */
  const orchestratorOwned = new Set(
    artifactDir === "" || acceptedPairIntact
      ? []
      : ORCHESTRATOR_OWNED_SLICE_FILENAMES.map((name) =>
          normalizeAcceptanceManifestPath(`${artifactDir}/${name}`),
        ),
  );
  const offenders: string[] = [];

  for (const raw of changedFiles) {
    const display = displayPath(raw);
    let key: string;
    try {
      key = normalizeAcceptanceManifestPath(raw);
    } catch {
      offenders.push(display);
      continue;
    }
    if (orchestratorOwned.has(key)) {
      // Refused even if the manifest declares it: a manifest that declares
      // itself is the widening this carve-out exists to catch.
      offenders.push(display);
      continue;
    }
    if (declared.has(key)) continue;
    if (
      artifactDir !== "" &&
      (key === artifactDir || key.startsWith(`${artifactDir}/`))
    ) {
      continue;
    }
    if (migrationPathsIn([key], options).length > 0) continue;
    offenders.push(display);
  }
  return [...new Set(offenders)].sort();
}

export function parseScopeEscalation(
  value: string | unknown,
  manifest: AcceptanceManifest,
  options?: LaneResourceOptions,
  source = ESCALATION_FILENAME,
): ScopeEscalation {
  // Duplicate keys are refused, not resolved. `requireExactKeys` below
  // reads the *parsed* object, so
  // `{"findingIds":["F-01"],"findingIds":["PRE-BUILD-SCOPE"],...}` presents
  // one well-formed `findingIds` and passes — while the artifact on disk
  // claims both a cited-finding fix and a pre-build discovery. That is the
  // same class of defect as the duplicated `winningPosition` in
  // `adjudication.md` (PM blocker 1) and is closed with the same primitive:
  // this escalation is generator-authored, so it is the last artifact that
  // should get the benefit of the doubt.
  const parsed: unknown =
    typeof value === "string" ? parseJsonWithUniqueKeys(value, source) : value;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} must contain a JSON object`);
  }
  const input = parsed as Record<string, unknown>;
  requireExactKeys(
    input,
    ["version", "findingIds", "paths", "reason"],
    source,
  );
  if (input.version !== 1) {
    throw new Error(`${source} must declare version 1`);
  }

  const findingIds = parseNonBlankStrings(
    input.findingIds,
    "findingIds",
    source,
  );
  if (new Set(findingIds).size !== findingIds.length) {
    throw new Error(`${source} findingIds must be unique`);
  }
  if (
    findingIds.includes(PRE_BUILD_SCOPE_FINDING_ID) &&
    findingIds.length > 1
  ) {
    throw new Error(
      `${source} findingIds must not mix ${PRE_BUILD_SCOPE_FINDING_ID} with ` +
        `cited finding IDs (${findingIds
          .filter((id) => id !== PRE_BUILD_SCOPE_FINDING_ID)
          .join(", ")}); an escalation is either a pre-build scope ` +
        `discovery or a cited-finding fix`,
    );
  }

  const rawPaths = parseNonBlankStrings(input.paths, "paths", source);
  const normalizedPaths = rawPaths.map((path) =>
    normalizeAcceptanceManifestPath(path, source),
  );
  if (new Set(normalizedPaths).size !== normalizedPaths.length) {
    throw new Error(`${source} normalized paths must be unique`);
  }

  const declared = new Set(acceptanceManifestPaths(manifest));
  const alreadyDeclared = rawPaths.filter((_path, index) =>
    declared.has(normalizedPaths[index]!),
  );
  if (alreadyDeclared.length > 0) {
    throw new Error(
      `${source} paths already on the locked file scope: ${alreadyDeclared.join(", ")}`,
    );
  }

  const migrations = migrationPathsIn(normalizedPaths, options);
  if (migrations.length > 0) {
    throw new Error(
      `${source} paths include migration files (${migrations.join(", ")}); ` +
        "migration prefixes are allocated at contract lock (ADR 0028/0034)",
    );
  }

  if (typeof input.reason !== "string" || input.reason.trim() === "") {
    throw new Error(`${source} reason must be a non-blank string`);
  }

  return {
    version: 1,
    findingIds,
    paths: rawPaths.map(displayPath),
    reason: input.reason.trim(),
  };
}
