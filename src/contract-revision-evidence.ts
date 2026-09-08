/**
 * Compact revision evidence for a contract revision round (#196).
 *
 * A revision round used to inline `ContractRevisionArtifacts` as
 * `JSON.stringify(revisions, null, 2)` — complete before *and* after copies of
 * both contract artifacts. On slice #195 that single block measured 70,899
 * bytes on its own, more than the whole 65,536-byte evaluator budget, and the
 * assembled round-2 prompt reached 151,315 bytes against a round-1 prompt of
 * 45,862.
 *
 * What the round actually judges is the *delta*: whether each prior finding's
 * clear-condition is now met, and whether the revision introduced a fresh gap.
 * The prompt already requires a fresh finding to carry a `revisionCitation`
 * whose `before` text exists only in the prior artifact and whose `after` text
 * exists only in the revised one — that is, exact text from a changed region.
 * So the changed regions, reproduced verbatim, are the complete inline
 * evidence; the unchanged bulk is what a review can never cite.
 */

/** One contiguous changed region of a single artifact. */
export interface ContractRevisionRegion {
  /** 1-based first prior line of the region; 0 for a pure insertion. */
  beforeStart: number;
  /** Prior lines the revision removed or replaced. Empty for an insertion. */
  beforeLines: readonly string[];
  /** 1-based first revised line of the region; 0 for a pure deletion. */
  afterStart: number;
  /** Revised lines the revision added. Empty for a deletion. */
  afterLines: readonly string[];
}

/**
 * Cell ceiling for the line-level LCS. Two 2,000-line artifacts fit; beyond
 * that the diff degrades to one whole-body region rather than allocating a
 * matrix proportional to the product of the line counts.
 */
const LCS_CELL_CEILING = 4_000_000;

const splitLines = (text: string): string[] =>
  text.replace(/\r\n?/g, "\n").split("\n");

/**
 * Line-level changed regions between two texts. Common leading and trailing
 * lines are trimmed first, so the LCS only runs over the part that can differ.
 */
export function contractRevisionRegions(
  before: string,
  after: string,
): ContractRevisionRegion[] {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] ===
      afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const beforeMiddle = beforeLines.slice(prefix, beforeLines.length - suffix);
  const afterMiddle = afterLines.slice(prefix, afterLines.length - suffix);
  if (beforeMiddle.length === 0 && afterMiddle.length === 0) return [];

  const region = (
    beforeChunk: readonly string[],
    beforeOffset: number,
    afterChunk: readonly string[],
    afterOffset: number,
  ): ContractRevisionRegion => ({
    beforeStart: beforeChunk.length === 0 ? 0 : beforeOffset + 1,
    beforeLines: beforeChunk,
    afterStart: afterChunk.length === 0 ? 0 : afterOffset + 1,
    afterLines: afterChunk,
  });

  if (
    beforeMiddle.length === 0 ||
    afterMiddle.length === 0 ||
    beforeMiddle.length * afterMiddle.length > LCS_CELL_CEILING
  ) {
    return [region(beforeMiddle, prefix, afterMiddle, prefix)];
  }

  // Longest common subsequence over the differing middle, then backtracked
  // into runs of equal / changed lines.
  const rows = beforeMiddle.length + 1;
  const columns = afterMiddle.length + 1;
  const lengths = new Int32Array(rows * columns);
  for (let row = beforeMiddle.length - 1; row >= 0; row -= 1) {
    for (let column = afterMiddle.length - 1; column >= 0; column -= 1) {
      lengths[row * columns + column] =
        beforeMiddle[row] === afterMiddle[column]
          ? lengths[(row + 1) * columns + column + 1]! + 1
          : Math.max(
              lengths[(row + 1) * columns + column]!,
              lengths[row * columns + column + 1]!,
            );
    }
  }

  const regions: ContractRevisionRegion[] = [];
  let row = 0;
  let column = 0;
  let pendingBefore: string[] = [];
  let pendingAfter: string[] = [];
  let pendingBeforeStart = 0;
  let pendingAfterStart = 0;
  const flush = (): void => {
    if (pendingBefore.length === 0 && pendingAfter.length === 0) return;
    regions.push(
      region(
        pendingBefore,
        pendingBeforeStart + prefix,
        pendingAfter,
        pendingAfterStart + prefix,
      ),
    );
    pendingBefore = [];
    pendingAfter = [];
  };
  while (row < beforeMiddle.length || column < afterMiddle.length) {
    if (
      row < beforeMiddle.length &&
      column < afterMiddle.length &&
      beforeMiddle[row] === afterMiddle[column]
    ) {
      flush();
      row += 1;
      column += 1;
      continue;
    }
    if (pendingBefore.length === 0 && pendingAfter.length === 0) {
      pendingBeforeStart = row;
      pendingAfterStart = column;
    }
    const takeBefore =
      column >= afterMiddle.length ||
      (row < beforeMiddle.length &&
        lengths[(row + 1) * columns + column]! >=
          lengths[row * columns + column + 1]!);
    if (takeBefore) {
      pendingBefore.push(beforeMiddle[row]!);
      row += 1;
    } else {
      pendingAfter.push(afterMiddle[column]!);
      column += 1;
    }
  }
  flush();
  return regions;
}

/** A fence long enough to hold `body` verbatim without terminating early. */
function fenceFor(body: string): string {
  const longest = [...body.matchAll(/`+/g)].reduce(
    (widest, run) => Math.max(widest, run[0].length),
    0,
  );
  return "`".repeat(Math.max(3, longest + 1));
}

function renderQuotedBody(label: string, lines: readonly string[]): string {
  const body = lines.join("\n");
  const fence = fenceFor(body);
  return `${label}\n\n${fence}text\n${body}\n${fence}\n`;
}

function renderRegion(
  index: number,
  artifact: string,
  region: ContractRevisionRegion,
): string {
  const anchor =
    region.beforeLines.length === 0
      ? `inserted at revised line ${region.afterStart}`
      : region.afterLines.length === 0
        ? `prior lines ${region.beforeStart}-${region.beforeStart + region.beforeLines.length - 1} removed`
        : `prior lines ${region.beforeStart}-${region.beforeStart + region.beforeLines.length - 1} ` +
          `became revised lines ${region.afterStart}-${region.afterStart + region.afterLines.length - 1}`;
  const parts = [`### ${artifact} change ${index} — ${anchor}\n`];
  if (region.beforeLines.length > 0) {
    parts.push(
      renderQuotedBody(
        "Prior text (exact; usable as `revisionCitation.before`):",
        region.beforeLines,
      ),
    );
  }
  if (region.afterLines.length > 0) {
    parts.push(
      renderQuotedBody(
        "Revised text (exact; usable as `revisionCitation.after`):",
        region.afterLines,
      ),
    );
  }
  return parts.join("\n");
}

export interface ContractRevisionEvidenceInput {
  readonly [artifact: string]: { before: string; after: string };
}

/**
 * Render the revision's changed regions, newest artifact first, within
 * `maxBytes`. Whole regions are kept or dropped — never half a region, which
 * would put text in the prompt that exists in neither artifact and so cannot
 * be cited. A drop is always named, with the count and the budget that caused
 * it, so a thin round is diagnosable rather than silently thin.
 */
export function renderContractRevisionEvidence(
  revisions: ContractRevisionEvidenceInput | null | undefined,
  maxBytes: number,
): string {
  if (maxBytes <= 0) return "";
  if (revisions === null || revisions === undefined) {
    return "(no revision evidence was recorded for this round)";
  }
  const bytes = (text: string): number => Buffer.byteLength(text, "utf-8");
  /**
   * Held back so the omission note can never be the thing that overflows the
   * budget it exists to report.
   */
  const cap = Math.max(1, maxBytes - 384);

  const blocks: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const [artifact, { before, after }] of Object.entries(revisions)) {
    const regions = contractRevisionRegions(before, after);
    const header =
      regions.length === 0
        ? `## ${artifact}\n\nThis revision left \`${artifact}\` unchanged, so no fresh ` +
          `finding can cite it.\n`
        : `## ${artifact}\n\n${regions.length} changed ` +
          `region${regions.length === 1 ? "" : "s"}. Prior text: ` +
          `${bytes(before)} bytes. Revised text: ${bytes(after)} bytes.\n`;
    if (used + bytes(header) > cap) {
      omitted += regions.length;
      continue;
    }
    blocks.push(header);
    used += bytes(header) + 1;
    regions.forEach((region, index) => {
      const rendered = renderRegion(index + 1, artifact, region);
      if (used + bytes(rendered) > cap) {
        omitted += 1;
        return;
      }
      blocks.push(rendered);
      used += bytes(rendered) + 1;
    });
  }
  if (omitted > 0) {
    blocks.push(
      `## ${omitted} changed region${omitted === 1 ? "" : "s"} omitted\n\n` +
        `The revision evidence this round had room for is ${cap} bytes, ` +
        `which the regions above consume. A fresh finding must cite text ` +
        `reproduced above; read the artifacts named at the top of this prompt ` +
        `for anything else.\n`,
    );
  }
  return blocks.join("\n").trimEnd();
}
