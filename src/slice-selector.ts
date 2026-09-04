/**
 * True when a list of operator-supplied slice selectors names this
 * slice — by slice number (zero padding optional: `5` matches `05`) or
 * by GH issue id.
 */
export function matchesSliceSelector(
  selectors: readonly string[] | undefined,
  slice: { number: string; ghIssue: string },
): boolean {
  if (!selectors) return false;
  return selectors.some(
    (value) =>
      value === slice.ghIssue ||
      value === slice.number ||
      Number(value) === Number(slice.number),
  );
}
