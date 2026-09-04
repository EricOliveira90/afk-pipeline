import { join } from "node:path";

/** Provider-qualified branch, state, and worktree identities (ADR 0002). */
export function sliceBranchPrefixForProviderName(
  providerName: string,
): string {
  return providerName === "kiro" ? "afk" : `afk-${providerName}`;
}

export function featureBranchPrefixForProviderName(
  providerName: string,
): string {
  return providerName === "kiro" ? "feat" : `feat-${providerName}`;
}

export function featureBranchForProviderName(
  prdSlug: string,
  providerName: string,
): string {
  return `${featureBranchPrefixForProviderName(providerName)}/${prdSlug}`;
}

export function runSlugForProviderName(
  prdSlug: string,
  providerName: string,
): string {
  return providerName === "kiro" ? prdSlug : `${prdSlug}-${providerName}`;
}

/** The provider name carried by a run slug. */
export function providerNameFromRunSlug(
  prdSlug: string,
  runSlug: string,
): string {
  return runSlug === prdSlug ? "kiro" : runSlug.slice(prdSlug.length + 1);
}

export function sliceWorktreeDirForProviderName(
  repoRoot: string,
  prdSlug: string,
  sliceNumber: string,
  providerName: string,
): string {
  return join(
    repoRoot,
    ".afk",
    "worktrees",
    `${sliceBranchPrefixForProviderName(providerName)}-${prdSlug}-s${sliceNumber}`,
  );
}
