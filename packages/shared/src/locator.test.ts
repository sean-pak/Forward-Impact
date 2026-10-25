import { describe, expect, it } from "vitest";
import {
  MockLocatorFileSchema, checkFields, decideOutcome, eitRefusal, queryMethod, rateLimitRefusal, searchMock,
  type LocatorSubject, type MockLocatorFile,
} from "./locator";

const rec = (cdcr: string, first: string, last: string, over: Record<string, unknown> = {}) => ({
  cdcr_number: cdcr, first_name: first, last_name: last, status: "in_custody", facility: "SQ",
  admission_date: "2025-03-02", projected_release_date: "2027-01-15", ...over,
});

const FILE: MockLocatorFile = MockLocatorFileSchema.parse({
  records: [
    rec("SYN00001", "Ada", "One"),
    rec("SYN00002", "Bo", "Two", { status: "not_found", facility: null, admission_date: null, projected_release_date: null }),
    rec("SYN00003", "Cy", "Three"), // returned and released: the edge case overrides this
    rec("SYN00004", "Di", "Four"), // error edge case
    rec("SYN00005", "Twin", "Match"),
    rec("SYN00006", "Twin", "Match", { facility: "CMC" }),
    rec("SYN00007", "Eve", "Solo"),
  ],
  edge_cases: {
    name_only_two_matches: { query: { first_name: "Twin", last_name: "Match" }, matches: [rec("SYN00005", "Twin", "Match"), rec("SYN00006", "Twin", "Match", { facility: "CMC" })] },
    returned_and_released_shows_not_found: { cdcr_number: "SYN00003" },
    error_response: { cdcr_number: "SYN00004", error: "Service unavailable" },
  },
});

describe("searchMock", () => {
  it("finds a person in custody by CDCR number, ignoring case and spaces", () => {
    const r = searchMock(FILE, { cdcr: " syn00001 " });
    expect(r).toMatchObject({ kind: "found", match: { cdcr_number: "SYN00001", facility: "SQ", admission_date: "2025-03-02" } });
  });

  it("reports not found for a record that is not in custody or does not exist", () => {
    expect(searchMock(FILE, { cdcr: "SYN00002" })).toEqual({ kind: "not_found" });
    expect(searchMock(FILE, { cdcr: "SYN99999" })).toEqual({ kind: "not_found" });
  });

  it("edge cases: returned-and-released is not found, the error number errors, the twin name has two matches", () => {
    expect(searchMock(FILE, { cdcr: "SYN00003" })).toEqual({ kind: "not_found" });
    expect(searchMock(FILE, { cdcr: "SYN00004" })).toEqual({ kind: "error", message: "Service unavailable" });
    const r = searchMock(FILE, { first: "twin", last: "MATCH" });
    expect(r.kind).toBe("multiple");
    if (r.kind === "multiple") expect(r.matches.map((m) => m.cdcr_number)).toEqual(["SYN00005", "SYN00006"]);
  });

  it("a name query with one in-custody record finds it; with no name or number it errors", () => {
    expect(searchMock(FILE, { first: "Eve", last: "Solo" })).toMatchObject({ kind: "found", match: { cdcr_number: "SYN00007" } });
    expect(searchMock(FILE, { first: "Nobody", last: "Here" })).toEqual({ kind: "not_found" });
    expect(searchMock(FILE, { first: "Eve" }).kind).toBe("error");
  });

  it("the file schema rejects a non-SYN number", () => {
    expect(MockLocatorFileSchema.safeParse({ ...FILE, records: [rec("CDCR123", "A", "B")] }).success).toBe(false);
  });
});

describe("checkFields", () => {
  it("picks the query method and confidence", () => {
    expect(queryMethod({ cdcr: "SYN00001" })).toBe("cdcr_number");
    expect(queryMethod({ first: "A", last: "B" })).toBe("name");
    expect(queryMethod({ cdcr: "SYN00001", first: "A", last: "B" })).toBe("name_plus_cdcr");
    const hit = (q: Parameters<typeof searchMock>[1]) => checkFields(q, searchMock(FILE, q));
    expect(hit({ cdcr: "SYN00001" })).toMatchObject({ result: "found_in_custody", match_confidence: "exact_cdcr", returned_facility: "SQ" });
    expect(hit({ first: "Eve", last: "Solo" })).toMatchObject({ result: "found_in_custody", match_confidence: "name_only" });
    expect(hit({ first: "Twin", last: "Match" })).toMatchObject({ result: "multiple_matches", returned_facility: null });
    expect(hit({ cdcr: "SYN00002" })).toMatchObject({ result: "not_found", match_confidence: "none" });
    expect(hit({ cdcr: "SYN00004" })).toMatchObject({ result: "error", match_confidence: "none" });
  });
});

describe("decideOutcome", () => {
  const found = { result: "found_in_custody" as const, match_confidence: "exact_cdcr" as const, returned_admission_date: "2025-03-02" };
  const base = { verified: false, releaseDate: "2024-01-01", checkedOn: "2026-10-24", lastNegativeCheck: null };

  it("an admission after release is an exact return, with days and the 3-year flag", () => {
    expect(decideOutcome({ ...base, check: found })).toEqual({
      status: "outcome",
      draft: { outcome_date: "2025-03-02", outcome_date_precision: "exact", outcome_date_earliest: null, days_to_outcome: 426, within_3yr: true },
    });
  });

  it("an admission on or before release is not a return", () => {
    expect(decideOutcome({ ...base, check: { ...found, returned_admission_date: "2024-01-01" } })).toEqual({ status: "none" });
    expect(decideOutcome({ ...base, check: { ...found, returned_admission_date: "2023-06-01" } })).toEqual({ status: "none" });
  });

  it("a return after more than 1,095 days is outside the 3-year window", () => {
    const r = decideOutcome({ ...base, releaseDate: "2020-01-01", check: { ...found, returned_admission_date: "2023-06-01" } });
    expect(r.status === "outcome" && r.draft.within_3yr).toBe(false);
  });

  it("no admission date: interval between the last negative check and now, midpoint as the date", () => {
    const r = decideOutcome({ ...base, check: { ...found, returned_admission_date: null }, lastNegativeCheck: "2025-01-01", checkedOn: "2025-01-11" });
    expect(r).toEqual({
      status: "outcome",
      draft: { outcome_date: "2025-01-06", outcome_date_precision: "interval", outcome_date_earliest: "2025-01-01", days_to_outcome: 371, within_3yr: true },
    });
  });

  it("no admission date and no negative check: the interval starts at the release date", () => {
    const r = decideOutcome({ ...base, check: { ...found, returned_admission_date: null }, releaseDate: "2025-01-01", checkedOn: "2025-01-11" });
    expect(r.status === "outcome" && r.draft.outcome_date_earliest).toBe("2025-01-01");
  });

  it("not found and errors make no outcome", () => {
    expect(decideOutcome({ ...base, check: { result: "not_found", match_confidence: "none", returned_admission_date: null } })).toEqual({ status: "none" });
    expect(decideOutcome({ ...base, check: { result: "error", match_confidence: "none", returned_admission_date: null } })).toEqual({ status: "none" });
  });

  it("name-only and multiple matches wait for a human; verified name-only counts", () => {
    const nameOnly = { ...found, match_confidence: "name_only" as const };
    expect(decideOutcome({ ...base, check: nameOnly })).toEqual({ status: "needs_verification" });
    expect(decideOutcome({ ...base, check: { result: "multiple_matches", match_confidence: "name_only", returned_admission_date: null } })).toEqual({ status: "needs_verification" });
    expect(decideOutcome({ ...base, verified: true, check: nameOnly }).status).toBe("outcome");
  });
});

describe("rateLimitRefusal", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  it("the real locator waits 3 seconds between queries", () => {
    expect(rateLimitRefusal("eit_locator", [now - 1000], now)).toMatch(/Wait 2 seconds/);
    expect(rateLimitRefusal("eit_locator", [now - 3000], now)).toBeNull();
  });
  it("200 a day for the real locator; older queries do not count", () => {
    const day = Array.from({ length: 200 }, (_, i) => now - 10_000 - i);
    expect(rateLimitRefusal("eit_locator", day, now)).toMatch(/Daily limit of 200/);
    expect(rateLimitRefusal("eit_locator", day.map((t) => t - 86_400_000), now)).toBeNull();
  });
  it("the mock has no pause between lookups", () => {
    expect(rateLimitRefusal("mock_locator", [now - 1], now)).toBeNull();
  });
});

describe("eitRefusal", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  const real: LocatorSubject = { isSynthetic: false, cdcrNumber: "A12345", consentFollowup: true, consentRevoked: false };
  const ok = { enabled: true, subject: real, query: { cdcr: "A12345" }, recentMs: [] as number[], nowMs: now };

  it("passes only when every guard passes", () => {
    expect(eitRefusal(ok)).toBeNull();
  });
  it("refuses when the flag is off", () => {
    expect(eitRefusal({ ...ok, enabled: false })).toMatch(/disabled/);
  });
  it("refuses a synthetic person", () => {
    expect(eitRefusal({ ...ok, subject: { ...real, isSynthetic: true } })).toMatch(/Synthetic/);
  });
  it("refuses any SYN number, from the person or the query, in any case", () => {
    expect(eitRefusal({ ...ok, subject: { ...real, cdcrNumber: "SYN00001" } })).toMatch(/SYN/);
    expect(eitRefusal({ ...ok, query: { cdcr: "syn00001" } })).toMatch(/SYN/);
  });
  it("refuses without active consent or with a revoked one", () => {
    expect(eitRefusal({ ...ok, subject: { ...real, consentFollowup: false } })).toMatch(/consent/);
    expect(eitRefusal({ ...ok, subject: { ...real, consentRevoked: true } })).toMatch(/consent/);
  });
  it("refuses over the rate limit", () => {
    expect(eitRefusal({ ...ok, recentMs: [now - 500] })).toMatch(/Wait/);
  });
});
