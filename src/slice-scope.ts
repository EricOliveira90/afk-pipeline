import type { Slice } from "./issues-parser.js";

export interface PersistedScopeSlice {
  number: string;
  ghIssue: string;
}

export interface PersistedRunScope {
  mode: "all-afk" | "explicit";
  slices: PersistedScopeSlice[];
}

/**
 * Why a manifest slice is not part of this invocation.
 *
 *  - `hitl`         — declared HITL; AFK never runs it.
 *  - `not-selected` — never entered the run's scope of record.
 *  - `narrowed`     — a member of the persisted scope that this
 *                     invocation deliberately left out (`--slices` on a
 *                     subset, or `--only-failed`). Distinct from
 *                     `not-selected`: the slice is still in the run's
 *                     scope of record, so a later full re-run picks it
 *                     up without any flag.
 */
export type SliceSkipReason = "hitl" | "not-selected" | "narrowed";

export interface SkippedSlice {
  slice: Slice;
  reason: SliceSkipReason;
}

export interface ResolvedRunScope {
  persisted: PersistedRunScope;
  selected: Slice[];
  skipped: SkippedSlice[];
}

function canonicalNumber(value: string): string {
  if (!/^\d+$/.test(value)) return value;
  return String(Number(value));
}

function indexSlices(slices: Slice[]): Map<string, Slice> {
  const byNumber = new Map<string, Slice>();
  const issues = new Set<string>();
  for (const slice of slices) {
    const key = canonicalNumber(slice.number);
    if (byNumber.has(key)) {
      throw new Error(`Duplicate slice number in manifest: ${slice.number}`);
    }
    if (issues.has(slice.ghIssue)) {
      throw new Error(`Duplicate GitHub issue in manifest: #${slice.ghIssue}`);
    }
    byNumber.set(key, slice);
    issues.add(slice.ghIssue);
  }
  return byNumber;
}

function resolveRequested(
  slices: Slice[],
  requested: readonly string[],
): Slice[] {
  const byNumber = indexSlices(slices);
  const requestedKeys = new Set<string>();
  for (const number of requested) {
    const key = canonicalNumber(number);
    if (requestedKeys.has(key)) {
      throw new Error(`Slice ${number} was selected more than once`);
    }
    const slice = byNumber.get(key);
    if (!slice) {
      throw new Error(`Selected slice ${number} is not declared in issues.md`);
    }
    if (slice.type !== "AFK") {
      throw new Error(
        `Selected slice ${slice.number} is declared ${slice.type}; only AFK slices can run`,
      );
    }
    requestedKeys.add(key);
  }
  return slices.filter((slice) =>
    requestedKeys.has(canonicalNumber(slice.number)),
  );
}

function restorePersisted(
  slices: Slice[],
  persisted: PersistedRunScope,
): Slice[] {
  if (persisted.mode !== "all-afk" && persisted.mode !== "explicit") {
    throw new Error("Run state contains an invalid slice scope mode");
  }
  if (!Array.isArray(persisted.slices)) {
    throw new Error("Run state contains an invalid slice scope");
  }

  const byNumber = indexSlices(slices);
  const selected: Slice[] = [];
  for (const saved of persisted.slices) {
    if (
      !saved ||
      typeof saved.number !== "string" ||
      typeof saved.ghIssue !== "string"
    ) {
      throw new Error("Run state contains an invalid scoped slice");
    }
    const slice = byNumber.get(canonicalNumber(saved.number));
    if (!slice || slice.ghIssue !== saved.ghIssue) {
      throw new Error(
        `Persisted scope slice ${saved.number} (#${saved.ghIssue}) no longer matches issues.md`,
      );
    }
    if (slice.type !== "AFK") {
      throw new Error(
        `Persisted scope slice ${slice.number} is now declared ${slice.type}; refusing to run it`,
      );
    }
    selected.push(slice);
  }
  return selected;
}

/**
 * Slice numbers of the persisted scope's members that the run state does
 * not record as complete. This is what `--only-failed` selects: sugar
 * over the subset rule in {@link resolveRunScope}, producing exactly the
 * selection an operator would type by hand.
 */
export function resolveOnlyFailedSelection(
  persisted: PersistedRunScope,
  isComplete: (ghIssue: string) => boolean,
): string[] {
  return persisted.slices
    .filter((slice) => !isComplete(slice.ghIssue))
    .map((slice) => slice.number);
}

/**
 * Resolve the executable AFK set. Once persisted, the resolved identities
 * win over a changed manifest so a retry cannot silently gain work.
 *
 * A requested selection may **narrow** a persisted scope to a strict
 * subset — that is how "re-run only what failed" is expressed. The
 * invariant the check protects is that a retry cannot silently *gain*
 * work, which a narrowing does not violate; supersets and disjoint
 * selections still throw. Narrowing never rewrites the persisted scope:
 * the original stays the run's scope of record, and its excluded members
 * are reported skipped under the `narrowed` reason.
 */
export function resolveRunScope(
  slices: Slice[],
  requested: readonly string[] | undefined,
  persisted?: PersistedRunScope,
): ResolvedRunScope {
  const requestedSlices =
    requested === undefined ? undefined : resolveRequested(slices, requested);

  let selected: Slice[];
  const scopeOfRecord = new Set<string>();
  let resolved: PersistedRunScope;
  if (persisted) {
    selected = restorePersisted(slices, persisted);
    for (const slice of selected) scopeOfRecord.add(slice.ghIssue);
    if (requestedSlices) {
      const outside = requestedSlices.filter(
        (slice) => !scopeOfRecord.has(slice.ghIssue),
      );
      if (outside.length > 0) {
        throw new Error(
          `Requested slices do not match the persisted run scope: ${outside
            .map((slice) => `${slice.number} (#${slice.ghIssue})`)
            .join(", ")} ${outside.length === 1 ? "is" : "are"} outside it. ` +
            "A re-run may narrow the scope to a subset but never add to it; " +
            "use the original selection or start with a new run-state file",
        );
      }
      const requestedIssues = new Set(
        requestedSlices.map((slice) => slice.ghIssue),
      );
      selected = selected.filter((slice) => requestedIssues.has(slice.ghIssue));
    }
    resolved = persisted;
  } else {
    selected =
      requestedSlices ?? slices.filter((slice) => slice.type === "AFK");
    resolved = {
      mode: requested === undefined ? "all-afk" : "explicit",
      slices: selected.map(({ number, ghIssue }) => ({ number, ghIssue })),
    };
  }

  const selectedIssues = new Set(selected.map((slice) => slice.ghIssue));
  const skipped = slices
    .filter((slice) => !selectedIssues.has(slice.ghIssue))
    .map((slice) => ({
      slice,
      reason:
        slice.type === "HITL"
          ? "hitl"
          : scopeOfRecord.has(slice.ghIssue)
            ? "narrowed"
            : "not-selected",
    })) satisfies SkippedSlice[];

  return { persisted: resolved, selected, skipped };
}
