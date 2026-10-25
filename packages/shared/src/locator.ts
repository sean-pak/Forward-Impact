import { z } from "zod";

// Custody lookups (PRD 9, schema v2 7.3, 7.4 and 9). Everything here is a small pure function: the mock search, how a
// lookup becomes a custody_check row, how a check becomes an outcome date, the real locator's guards and the rate limit.

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dates are YYYY-MM-DD");
const syn = z.string().regex(/^SYN\d{5}$/, "mock locator CDCR numbers are SYN + 5 digits");

export const MockRecordSchema = z.object({
  cdcr_number: syn,
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  status: z.enum(["in_custody", "not_found"]),
  facility: z.string().nullable(),
  admission_date: day.nullable(),
  projected_release_date: day.nullable(),
});
export type MockRecord = z.infer<typeof MockRecordSchema>;

/** Muse's `mock_locator.json` (docs/SEED_CONTRACT.md). */
export const MockLocatorFileSchema = z.object({
  meta: z.record(z.string(), z.unknown()).optional(),
  records: z.array(MockRecordSchema),
  edge_cases: z.object({
    name_only_two_matches: z.object({
      query: z.object({ first_name: z.string(), last_name: z.string() }),
      matches: z.array(MockRecordSchema).min(2),
    }),
    returned_and_released_shows_not_found: z.object({ cdcr_number: syn }),
    error_response: z.object({ cdcr_number: syn, error: z.string() }),
  }),
});
export type MockLocatorFile = z.infer<typeof MockLocatorFileSchema>;

export type LocatorQuery = { cdcr?: string; first?: string; last?: string };

export type LocatorMatch = Pick<MockRecord, "cdcr_number" | "first_name" | "last_name" | "facility" | "admission_date" | "projected_release_date">;

/** What a locator says. `found` means in CDCR custody right now. `not_found` means not in custody according to this tool. */
export type LocatorResult =
  | { kind: "found"; match: LocatorMatch }
  | { kind: "not_found" }
  | { kind: "multiple"; matches: LocatorMatch[] }
  | { kind: "error"; message: string };

const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const cleanCdcrNumber = (s: string | undefined) => (s ?? "").trim().toUpperCase();

const toMatch = (r: MockRecord): LocatorMatch => ({
  cdcr_number: r.cdcr_number, first_name: r.first_name, last_name: r.last_name,
  facility: r.facility, admission_date: r.admission_date, projected_release_date: r.projected_release_date,
});

/** The mock's whole behavior, shared by the `/mock-locator/search` route and the `mockLocator` adapter. */
export function searchMock(file: MockLocatorFile, q: LocatorQuery): LocatorResult {
  const cdcr = cleanCdcrNumber(q.cdcr);
  const first = norm(q.first);
  const last = norm(q.last);
  const edge = file.edge_cases;

  if (cdcr) {
    if (cdcr === edge.error_response.cdcr_number) return { kind: "error", message: edge.error_response.error };
    // A returned-and-released person is no longer in custody, whatever the record says.
    if (cdcr === edge.returned_and_released_shows_not_found.cdcr_number) return { kind: "not_found" };
    const rec = file.records.find((r) => r.cdcr_number === cdcr);
    return rec && rec.status === "in_custody" ? { kind: "found", match: toMatch(rec) } : { kind: "not_found" };
  }

  if (!first || !last) return { kind: "error", message: "A CDCR number, or a first and last name, is required." };
  const two = edge.name_only_two_matches;
  if (norm(two.query.first_name) === first && norm(two.query.last_name) === last) {
    return { kind: "multiple", matches: two.matches.map(toMatch) };
  }
  const hits = file.records.filter((r) => norm(r.first_name) === first && norm(r.last_name) === last && r.status === "in_custody");
  if (hits.length === 0) return { kind: "not_found" };
  if (hits.length === 1) return { kind: "found", match: toMatch(hits[0]!) };
  return { kind: "multiple", matches: hits.map(toMatch) };
}

export type QueryMethod = "cdcr_number" | "name" | "name_plus_cdcr";
export type CheckResult = "found_in_custody" | "not_found" | "multiple_matches" | "error" | "blocked";
export type MatchConfidence = "exact_cdcr" | "name_and_dob" | "name_only" | "none";

export function queryMethod(q: LocatorQuery): QueryMethod {
  const hasName = Boolean(q.first?.trim() || q.last?.trim());
  if (q.cdcr?.trim()) return hasName ? "name_plus_cdcr" : "cdcr_number";
  return "name";
}

/** The analytics-side fields of a custody_check row. No identifiers: the facility and dates are about the custody record. */
export type CheckFields = {
  query_method: QueryMethod;
  result: CheckResult;
  returned_facility: string | null;
  returned_admission_date: string | null;
  returned_release_date: string | null;
  match_confidence: MatchConfidence;
};

export function checkFields(q: LocatorQuery, r: LocatorResult): CheckFields {
  const base = { query_method: queryMethod(q), returned_facility: null, returned_admission_date: null, returned_release_date: null };
  switch (r.kind) {
    case "found":
      return {
        ...base, result: "found_in_custody", returned_facility: r.match.facility, returned_admission_date: r.match.admission_date,
        returned_release_date: r.match.projected_release_date,
        // The locator was asked for this number, so a hit is exact. A name-only hit has no DOB to back it.
        match_confidence: q.cdcr?.trim() ? "exact_cdcr" : "name_only",
      };
    case "multiple":
      return { ...base, result: "multiple_matches", match_confidence: "name_only" };
    case "not_found":
      return { ...base, result: "not_found", match_confidence: "none" };
    case "error":
      return { ...base, result: "error", match_confidence: "none" };
  }
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export type OutcomeDraft = {
  outcome_date: string;
  outcome_date_precision: "exact" | "interval";
  /** Interval only: the last date known to be negative (or the release date when there was no negative check). */
  outcome_date_earliest: string | null;
  days_to_outcome: number;
  within_3yr: boolean;
};

export type OutcomeDecision =
  | { status: "outcome"; draft: OutcomeDraft }
  | { status: "none" }
  | { status: "needs_verification" };

/**
 * Schema v2 9.3. A custody hit is a return only if the admission is after the release. With no admission date the
 * outcome is somewhere between the last negative check and this one, so store both and use the midpoint.
 * A name-only hit (or several matches) is never turned into an outcome until a human verifies it.
 */
export function decideOutcome(input: {
  check: Pick<CheckFields, "result" | "match_confidence" | "returned_admission_date">;
  verified: boolean;
  releaseDate: string;
  checkedOn: string;
  lastNegativeCheck: string | null;
}): OutcomeDecision {
  const { check, verified, releaseDate, checkedOn } = input;
  if (check.result === "multiple_matches") return { status: "needs_verification" };
  if (check.result !== "found_in_custody") return { status: "none" };
  if (check.match_confidence === "name_only" && !verified) return { status: "needs_verification" };

  const finish = (outcomeDate: string, precision: OutcomeDraft["outcome_date_precision"], earliest: string | null): OutcomeDecision => {
    const days = daysBetween(releaseDate, outcomeDate);
    return {
      status: "outcome",
      draft: { outcome_date: outcomeDate, outcome_date_precision: precision, outcome_date_earliest: earliest, days_to_outcome: days, within_3yr: days <= 1095 },
    };
  };

  const admitted = check.returned_admission_date;
  if (admitted) return admitted > releaseDate ? finish(admitted, "exact", null) : { status: "none" };

  if (checkedOn <= releaseDate) return { status: "none" };
  const earliest = input.lastNegativeCheck && input.lastNegativeCheck > releaseDate ? input.lastNegativeCheck : releaseDate;
  const span = Math.max(0, daysBetween(earliest, checkedOn));
  return finish(addDays(earliest, Math.floor(span / 2)), "interval", earliest);
}

export type LocatorSource = "mock_locator" | "eit_locator";

/** PRD 9: one query every 3 seconds and 200 a day for the real locator. The mock has no pause, so a cohort runs at once. */
export const RATE_LIMITS: Record<LocatorSource, { minGapMs: number; perDay: number }> = {
  eit_locator: { minGapMs: 3_000, perDay: 200 },
  mock_locator: { minGapMs: 0, perDay: 500 },
};

/** `recentMs`: when this source was queried in the last 24 hours (epoch ms). Returns a plain-language refusal, or null. */
export function rateLimitRefusal(source: LocatorSource, recentMs: number[], nowMs: number): string | null {
  const limit = RATE_LIMITS[source];
  const day = recentMs.filter((t) => nowMs - t < 86_400_000);
  if (day.length >= limit.perDay) return `Daily limit of ${limit.perDay} lookups reached.`;
  const last = day.length ? Math.max(...day) : null;
  if (last !== null && nowMs - last < limit.minGapMs) return `Wait ${Math.ceil((limit.minGapMs - (nowMs - last)) / 1000)} seconds between lookups.`;
  return null;
}

/** Everything the real locator's guards need to know about the person being looked up. */
export type LocatorSubject = {
  isSynthetic: boolean;
  cdcrNumber: string | null;
  consentFollowup: boolean;
  consentRevoked: boolean;
};

/**
 * PRD 9 hard guards for the EIT locator, which holds real CDCR data. Returns why the lookup is refused, or null when
 * every guard passes. A synthetic name can match a real person and create a false record about them, so synthetic
 * people and `SYN` numbers never reach it.
 */
export function eitRefusal(input: {
  enabled: boolean;
  subject: LocatorSubject;
  query: LocatorQuery;
  recentMs: number[];
  nowMs: number;
}): string | null {
  const { subject, query } = input;
  if (!input.enabled) return "The real locator is disabled (REAL_LOCATOR_ENABLED is not true).";
  if (subject.isSynthetic) return "Synthetic people are never sent to the real locator.";
  if (/^SYN/i.test(cleanCdcrNumber(subject.cdcrNumber ?? "")) || /^SYN/i.test(cleanCdcrNumber(query.cdcr))) {
    return "SYN CDCR numbers are never sent to the real locator.";
  }
  if (!subject.consentFollowup || subject.consentRevoked) return "No active follow-up consent for this person.";
  return rateLimitRefusal("eit_locator", input.recentMs, input.nowMs);
}
