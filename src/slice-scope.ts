import type { Slice } from "./issues-parser.js";

export interface PersistedScopeSlice {
  number: string;
  ghIssue: string;
}

export interface PersistedRunScope {
  mode: "all-afk" | "explicit";
  slices: PersistedScopeSlice[];
}

export type SliceSkipReason = "hitl" | "not-selected";

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

function scopeIdentity(slices: readonly Slice[]): string {
  return slices
    .map((slice) => `${canonicalNumber(slice.number)}:#${slice.ghIssue}`)
    .sort()
    .join(",");
}

/**
 * Resolve the executable AFK set. Once persisted, the resolved identities
 * win over a changed manifest so a retry cannot silently gain work.
 */
export function resolveRunScope(
  slices: Slice[],
  requested: readonly string[] | undefined,
  persisted?: PersistedRunScope,
): ResolvedRunScope {
  const requestedSlices =
    requested === undefined ? undefined : resolveRequested(slices, requested);

  let selected: Slice[];
  let resolved: PersistedRunScope;
  if (persisted) {
    selected = restorePersisted(slices, persisted);
    if (
      requestedSlices &&
      scopeIdentity(requestedSlices) !== scopeIdentity(selected)
    ) {
      throw new Error(
        "Requested slices do not match the persisted run scope; use the original selection or start with a new run-state file",
      );
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
      reason: slice.type === "HITL" ? "hitl" : "not-selected",
    })) satisfies SkippedSlice[];

  return { persisted: resolved, selected, skipped };
}
