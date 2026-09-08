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
 * whose non-empty `before` text exists only in the prior artifact and whose
 * non-empty `after` text exists only in the revised one — that is, exact text
 * from a changed region. Insertions use an empty `before`; deletions use an
 * empty `after`. So the changed regions, reproduced verbatim after line-ending
 * normalization, are the complete inline evidence; the unchanged bulk is what
 * a review can never cite.
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

const normalizedText = (text: string): string =>
  text.replace(/\r\n?/g, "\n");

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

/**
 * A replacement region may quote text that also occurs elsewhere in the
 * opposite artifact. Expand it with adjacent context until both quotes identify
 * this revision rather than merely a repeated line. Insertions and deletions
 * stay one-sided: their empty side is meaningful citation data.
 */
function citationReadyRegion(
  before: string,
  after: string,
  changed: ContractRevisionRegion,
): ContractRevisionRegion {
  if (changed.beforeLines.length === 0 || changed.afterLines.length === 0) {
    return changed;
  }
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const beforeText = normalizedText(before);
  const afterText = normalizedText(after);
  let beforeStart = changed.beforeStart - 1;
  let afterStart = changed.afterStart - 1;
  let beforeEnd = beforeStart + changed.beforeLines.length;
  let afterEnd = afterStart + changed.afterLines.length;
  const identifiesChange = (): boolean => {
    const prior = beforeLines.slice(beforeStart, beforeEnd).join("\n");
    const revised = afterLines.slice(afterStart, afterEnd).join("\n");
    return (
      prior !== revised &&
      !afterText.includes(prior) &&
      !beforeText.includes(revised)
    );
  };

  while (!identifiesChange()) {
    const canExpandLeft = beforeStart > 0 || afterStart > 0;
    const canExpandRight =
      beforeEnd < beforeLines.length || afterEnd < afterLines.length;
    if (!canExpandLeft && !canExpandRight) break;
    if (canExpandLeft) {
      beforeStart = Math.max(0, beforeStart - 1);
      afterStart = Math.max(0, afterStart - 1);
    }
    if (canExpandRight) {
      beforeEnd = Math.min(beforeLines.length, beforeEnd + 1);
      afterEnd = Math.min(afterLines.length, afterEnd + 1);
    }
  }

  return {
    beforeStart: beforeStart + 1,
    beforeLines: beforeLines.slice(beforeStart, beforeEnd),
    afterStart: afterStart + 1,
    afterLines: afterLines.slice(afterStart, afterEnd),
  };
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
  } else {
    parts.push(
      'Prior text: `""` (empty because this region is an insertion).\n',
    );
  }
  if (region.afterLines.length > 0) {
    parts.push(
      renderQuotedBody(
        "Revised text (exact; usable as `revisionCitation.after`):",
        region.afterLines,
      ),
    );
  } else {
    parts.push(
      'Revised text: `""` (empty because this region is a deletion).\n',
    );
  }
  return parts.join("\n");
}

export interface ContractRevisionEvidenceInput {
  readonly [artifact: string]: { before: string; after: string };
}

/**
 * Render the revision's changed regions within `maxBytes`. Whole regions are
 * kept or dropped — never half a region, which would put text in the prompt
 * that exists in neither artifact and so cannot be cited. A drop is named when
 * the budget can hold the omission note; below that minimum the block is empty
 * rather than overflowing the prompt it is meant to protect.
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
    const regions = contractRevisionRegions(before, after).map((region) =>
      citationReadyRegion(before, after, region),
    );
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
    const omission = (
      `## ${omitted} changed region${omitted === 1 ? "" : "s"} omitted\n\n` +
        `The revision evidence this round had room for is ${cap} bytes, ` +
        `which the regions above consume. A fresh finding must cite text ` +
        `reproduced above; read the artifacts named at the top of this prompt ` +
        `for anything else.\n`
    );
    const withOmission = [...blocks, omission].join("\n").trimEnd();
    if (bytes(withOmission) <= maxBytes) return withOmission;
    const withoutOmission = blocks.join("\n").trimEnd();
    return bytes(withoutOmission) <= maxBytes ? withoutOmission : "";
  }
  return blocks.join("\n").trimEnd();
}
