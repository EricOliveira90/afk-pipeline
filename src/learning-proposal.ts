/**
 * The learning-proposal schema: the `learning-proposals.json` document that
 * PRD 6's recurring-finding loop (plan §3d item 19) writes on the second
 * exact occurrence of a stable finding class, and that rumo-app's Close
 * learning pass (`post-merge-cleanup`, rumo-app #809) produces when its
 * findings ledger reaches count 2. One shape, defined here, consumed in both
 * repositories through the package's `./learning-proposal` entry — the same
 * mechanism ADR 0034 established for `./afk-manifest`. See ADR 0066.
 *
 * Landed by hand on `main` rather than as a PRD 7 slice
 * (`docs/specs/afk-v2-plan-debate.md` §7, R1): it shares no code with the eval
 * runner and is smaller than one round's overhead.
 */

/**
 * The version every document this module writes carries, and the newest one
 * {@link parseLearningProposals} accepts.
 *
 * Bump rule (ADR 0066): AFK holds the canonical definition. Any change to the
 * field set — adding, removing, renaming or re-typing a field — is an AFK
 * commit that bumps this constant, appends the new number to
 * {@link SUPPORTED_LEARNING_PROPOSAL_VERSIONS} (or replaces the list when the
 * old shape is retired) and files an issue in each consuming repository
 * naming the field change. A consumer picks the change up when it moves the
 * `afk-pipeline` commit it pins; until then it keeps reading the version it
 * was built against. A reader that meets a version outside its supported
 * list refuses the document — it never guesses at a shape it has not seen
 * (`docs/PRODUCT.md`, fail closed).
 *
 * - **1** — the five-field proposal: `findingClass`, `occurrenceCount`,
 *   `occurrences`, `targetAsset`, `proposedChange`. All required.
 */
export const LEARNING_PROPOSAL_VERSION = 1;

/** Every document version a reader in this process accepts. */
export const SUPPORTED_LEARNING_PROPOSAL_VERSIONS = [1] as const;

export type LearningProposalVersion =
  (typeof SUPPORTED_LEARNING_PROPOSAL_VERSIONS)[number];

/**
 * One proposal: a finding class that has recurred, the evidence that it has,
 * the asset the proposer wants changed and the change itself. The five fields
 * are the ones item 19 names (class, count, target asset, proposed diff) plus
 * provenance (`occurrences`), and each is fillable from a rumo-app findings
 * ledger entry together with the `post-merge-cleanup` skill's five prose
 * items. Ledger-only fields (`validation`, `date`, `prdSlug`, `disposition`)
 * are deliberately absent: they belong to the occurrence record and to the
 * PR body, and every extra field here is a permanent cross-repo coordination
 * cost (`decisions-review.md` D26).
 */
export interface LearningProposal {
  /**
   * Stable kebab-case identifier of the finding class — the same identifier
   * rumo-app's ledger keys on, so a proposal and its ledger entries match by
   * string equality. Lowercase letters and digits separated by single
   * hyphens; no leading, trailing or doubled hyphen.
   */
  findingClass: string;
  /**
   * How many exact occurrences of `findingClass` the proposer has seen.
   * An integer, at least 2 — a proposal exists *because* something happened
   * twice — and exactly `occurrences.length`.
   */
  occurrenceCount: number;
  /**
   * One link per occurrence (an issue, PR, review artifact or ledger entry
   * URL or repo-relative path), at least two. This is the evidence for
   * "second occurrence"; a proposal a reader cannot trace to its incidents
   * is an opinion.
   */
  occurrences: string[];
  /**
   * What the proposal wants changed. A repo-relative path when the target is
   * a file (`AGENTS.md`, `prompts/planner.md`, `docs/CONVENTIONS.md`);
   * otherwise a stable token such as `skill:<name>`, `gate:<id>` or
   * `eval-scenario`. A free string on purpose: nobody routes on it
   * mechanically in v1, and an enum neither repository fully uses would be
   * speculative surface (`decisions-review.md` D27).
   */
  targetAsset: string;
  /**
   * The change itself. A unified diff when `targetAsset` is a file; prose
   * describing the change otherwise (a new eval scenario, a gate to declare).
   * Never applied automatically — a human reads it in the run summary or the
   * draft PR and decides (`docs/PRODUCT.md`, "No automatic edits to steering
   * or memory files").
   */
  proposedChange: string;
}

/** The whole `learning-proposals.json` document. */
export interface LearningProposalsFile {
  version: LearningProposalVersion;
  proposals: LearningProposal[];
}

const TOP_LEVEL_FIELDS: ReadonlySet<string> = new Set(["version", "proposals"]);

const PROPOSAL_FIELDS: ReadonlySet<string> = new Set([
  "findingClass",
  "occurrenceCount",
  "occurrences",
  "targetAsset",
  "proposedChange",
]);

/**
 * rumo-app's ledger rule for a finding class, restated as one regex so both
 * repositories accept the same identifiers: lowercase alphanumeric segments
 * joined by single hyphens.
 */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function nonBlankField(
  value: unknown,
  field: string,
  where: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where} requires a non-blank ${field}`);
  }
  return value.trim();
}

function unknownFields(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
): string[] {
  return Object.keys(value).filter((key) => !known.has(key));
}

function normalizeProposal(
  entry: unknown,
  index: number,
  source: string,
): LearningProposal {
  const where = `${source} proposals[${index}]`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(
      `${where} must be a JSON object holding findingClass, occurrenceCount, ` +
        `occurrences, targetAsset and proposedChange`,
    );
  }
  const value = entry as Record<string, unknown>;

  // Refuse, never ignore, a field this version does not define: a proposal
  // carrying a field the reader drops is a proposal whose author believed
  // something the consumer never saw (PRD 4 D1's rule for persisted shapes).
  const unknown = unknownFields(value, PROPOSAL_FIELDS);
  if (unknown.length > 0) {
    throw new Error(
      `${where} carries fields version ${LEARNING_PROPOSAL_VERSION} does not ` +
        `define: ${unknown.join(", ")}`,
    );
  }

  const findingClass = nonBlankField(value.findingClass, "findingClass", where);
  if (!KEBAB_CASE.test(findingClass)) {
    throw new Error(
      `${where} findingClass "${findingClass}" is not kebab-case; a finding ` +
        `class is a stable lowercase identifier such as ` +
        `"missing-migration-rollback" so ledger entries and proposals match ` +
        `by string equality`,
    );
  }

  const occurrenceCount = value.occurrenceCount;
  if (
    typeof occurrenceCount !== "number" ||
    !Number.isInteger(occurrenceCount) ||
    occurrenceCount < 2
  ) {
    throw new Error(
      `${where} occurrenceCount must be an integer of at least 2; a proposal ` +
        `exists because a finding class recurred`,
    );
  }

  if (!Array.isArray(value.occurrences)) {
    throw new Error(`${where} occurrences must be an array of links`);
  }
  const occurrences = value.occurrences.map((link, linkIndex) =>
    nonBlankField(link, `occurrences[${linkIndex}]`, where),
  );
  if (occurrences.length < 2) {
    throw new Error(
      `${where} occurrences must name at least two links; they are the ` +
        `evidence for the second occurrence`,
    );
  }
  // The count and the evidence describe the same fact, so a document where
  // they disagree is wrong on one side and the reader cannot tell which.
  // Refuse rather than trust either: deriving the count from the links would
  // silently accept a ledger that mis-tallied, and trusting the count would
  // accept a proposal whose evidence is missing.
  if (occurrences.length !== occurrenceCount) {
    throw new Error(
      `${where} occurrenceCount (${occurrenceCount}) must equal the number ` +
        `of occurrences (${occurrences.length}); the count is the tally of ` +
        `the links, not a separate claim`,
    );
  }

  return {
    findingClass,
    occurrenceCount,
    occurrences,
    targetAsset: nonBlankField(value.targetAsset, "targetAsset", where),
    proposedChange: nonBlankField(value.proposedChange, "proposedChange", where),
  };
}

/**
 * Parse and validate a `learning-proposals.json` document. Accepts the raw
 * file text or an already-parsed value, exactly like `parseAfkManifest`, and
 * throws on the first defect it finds — a proposal is refused, never skipped,
 * because a skipped proposal is a recurrence nobody hears about.
 *
 * Refuses: invalid JSON; a non-object document; a `version` outside
 * {@link SUPPORTED_LEARNING_PROPOSAL_VERSIONS}; any top-level or per-proposal
 * field this version does not define; a missing or blank required field; an
 * `occurrenceCount` that is not an integer of at least 2; fewer than two
 * `occurrences`; a `findingClass` that is not kebab-case; and an
 * `occurrenceCount` that differs from `occurrences.length`.
 */
export function parseLearningProposals(
  value: string | unknown,
  source = "learning-proposals.json",
): LearningProposalsFile {
  let document: unknown;
  try {
    document = typeof value === "string" ? JSON.parse(value) : value;
  } catch (error) {
    throw new Error(
      `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`${source} must contain a JSON object`);
  }
  const input = document as Record<string, unknown>;

  const unknown = unknownFields(input, TOP_LEVEL_FIELDS);
  if (unknown.length > 0) {
    throw new Error(
      `${source} carries top-level fields version ` +
        `${LEARNING_PROPOSAL_VERSION} does not define: ${unknown.join(", ")}`,
    );
  }

  const version = input.version;
  if (
    !SUPPORTED_LEARNING_PROPOSAL_VERSIONS.includes(
      version as LearningProposalVersion,
    )
  ) {
    throw new Error(
      `${source} declares version ${JSON.stringify(version)}; this reader ` +
        `accepts ${SUPPORTED_LEARNING_PROPOSAL_VERSIONS.join(", ")} and refuses ` +
        `a shape it has not seen`,
    );
  }

  if (!Array.isArray(input.proposals)) {
    throw new Error(`${source} proposals must be an array`);
  }
  const proposals = input.proposals.map((entry, index) =>
    normalizeProposal(entry, index, source),
  );

  return { version: version as LearningProposalVersion, proposals };
}
