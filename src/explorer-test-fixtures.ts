/** Canonical valid explorer artifact for scenarios unrelated to parsing. */
export function validExplorerContext(label = "fixture"): string {
  return [
    "## Files and current behavior",
    "",
    `- ${label}`,
    "",
    "## Patterns and test harness",
    "",
    "- Existing fixture patterns",
    "",
    "## Unknowns",
    "",
  ].join("\n");
}
