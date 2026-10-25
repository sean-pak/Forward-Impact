import { describe, expect, it } from "vitest";
import { deriveCycles, overlayAnswer, suggestFacility, toFormRow, type StoredCycle } from "./answers";

const stored = (over: Partial<StoredCycle> = {}): StoredCycle => ({
  cycle_id: "c1", program_id: "p1", program_name: "Writing Class", facility_code: "CMC", facility_raw: null, yard: null,
  start_date: "2025-02-03", end_date: null, sessions_planned: null, course_hours_planned_per_participant: null,
  n_enrolled: 30, n_completed: 22, total_course_hours_delivered: null,
  n_enrolled_approx: true, n_completed_approx: false, total_course_hours_delivered_approx: false,
  source_grain: "aggregate", extra: { _completion_rule: "unstated" }, ...over,
});
const today = "2026-10-24";

describe("deriveCycles", () => {
  it("reports what is still missing, deterministically", () => {
    const [d] = deriveCycles("o1", [stored()], [], today);
    expect(d!.issues.map((i) => i.field_name)).toEqual(["completion_rule"]);
    expect(d!.blocked).toBe(false);
    expect(d!.cycle.n_enrolled_approx).toBe(true);
  });

  it("a blank completed count is asked unless the cycle is still running", () => {
    expect(deriveCycles("o1", [stored({ n_completed: null })], [], today)[0]!.issues.map((i) => i.field_name)).toEqual(["n_completed"]);
    expect(deriveCycles("o1", [stored({ n_completed: null, end_date: "2027-01-01" })], [], today)[0]!.issues).toEqual([]);
  });

  it("an unmatched prison comes back as ambiguous and blocks", () => {
    const [d] = deriveCycles("o1", [stored({ facility_code: null, facility_raw: "Soledad" })], [], today);
    expect(d!.issues.find((i) => i.field_name === "facility_code")).toMatchObject({ issue_type: "ambiguous_mapping", raw_value: "Soledad" });
    expect(d!.blocked).toBe(true);
  });

  it("flags the later of two cycles with the same key", () => {
    const [a, b] = deriveCycles("o1", [stored({ cycle_id: "c1" }), stored({ cycle_id: "c2" })], [], today);
    expect(a!.issues.some((i) => i.issue_type === "conflict")).toBe(false);
    expect(b!.issues.some((i) => i.issue_type === "conflict")).toBe(true);
  });
});

describe("overlayAnswer", () => {
  const row = toFormRow(stored({ n_completed: null }));

  it("sets a count and its approximate flag, then cleaning accepts it", () => {
    const next = overlayAnswer(row, "n_completed", "1,200", false, [])!;
    expect(next.n_completed).toBe("1200");
    const [d] = deriveCycles("o1", [stored({ n_completed: null })], [], today, new Map([["c1", next]]));
    expect(d!.cycle.n_completed).toBe(1200); // then flagged as above enrolled, never silently dropped
    expect(d!.issues.some((i) => i.issue_type === "out_of_range")).toBe(true);
  });

  it("keeps an approximate answer approximate", () => {
    expect(overlayAnswer(row, "n_enrolled", "30", true, [])!.n_enrolled_approx).toBe(true);
    expect(overlayAnswer(row, "n_enrolled", "31", false, [])!.n_enrolled_approx).toBe(false);
  });

  it("a completion rule answer resolves the missing-rule issue", () => {
    const next = overlayAnswer(row, "completion_rule", "attended 80% of sessions", false, [])!;
    const [d] = deriveCycles("o1", [stored()], [], today, new Map([["c1", { ...next, n_completed: "22" }]]));
    expect(d!.issues).toEqual([]);
    expect(d!.cycle.completion_rule).toBe("attended 80% of sessions");
  });

  it("a garbled answer becomes an issue, not a stored value", () => {
    const next = overlayAnswer(row, "n_completed", "lots", false, [])!;
    const [d] = deriveCycles("o1", [stored({ n_completed: null })], [], today, new Map([["c1", next]]));
    expect(d!.cycle.n_completed).toBeNull();
    expect(d!.issues.some((i) => i.issue_type === "invalid_value")).toBe(true);
  });

  it("refuses fields it does not know and empty values", () => {
    expect(overlayAnswer(row, "person_key", "x", false, [])).toBeNull();
    expect(overlayAnswer(row, "n_completed", "  ", false, [])).toBeNull();
  });

  it("sets an active registry field", () => {
    const reg = [{ field_key: "funding", label: "Funding", type: "text" as const, options: null, required: false }];
    expect(overlayAnswer(row, "funding", "grant", false, reg)!.extra.funding).toBe("grant");
  });
});

describe("suggestFacility", () => {
  it("offers the prison the program's other run used", () => {
    const d = deriveCycles("o1", [stored({ facility_code: "SQ" }), stored({ cycle_id: "c2", facility_code: null, start_date: "2025-09-08" })], [], today);
    expect(suggestFacility("c2", d)).toEqual({ code: "SQ", name: "San Quentin Rehabilitation Center" });
    expect(suggestFacility("c1", d)).toBeNull();
  });

  it("offers nothing when the other runs were at different prisons", () => {
    const d = deriveCycles("o1", [
      stored({ facility_code: "SQ" }), stored({ cycle_id: "c2", facility_code: "CMC", start_date: "2025-05-01" }),
      stored({ cycle_id: "c3", facility_code: null, start_date: "2025-09-08" }),
    ], [], today);
    expect(suggestFacility("c3", d)).toBeNull();
  });
});
