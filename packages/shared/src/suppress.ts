/** Small-cell suppression (PRD 10, schema-v2 section 3). Applies outside the owning org. */
export const SUPPRESSED = "suppressed" as const;

export const MIN_RATE_DENOMINATOR = 30;
export const MIN_COUNT_SHOWN = 11; // counts 1 to 10 are suppressed; 0 and 11+ are shown
export const MIN_ORGS_PER_FACILITY = 3;

/** A rate is hidden when its denominator is under 30. Pool counts first, then call this. */
export function isRateSuppressed(denominator: number): boolean {
  return denominator < MIN_RATE_DENOMINATOR;
}

/** A count between 1 and 10 is hidden. Zero is a real zero and stays visible. */
export function isCountSuppressed(count: number): boolean {
  return count >= 1 && count < MIN_COUNT_SHOWN;
}

/** A facility cell is hidden when fewer than 3 orgs contribute to it. */
export function isFacilitySuppressed(orgCount: number): boolean {
  return orgCount < MIN_ORGS_PER_FACILITY;
}
