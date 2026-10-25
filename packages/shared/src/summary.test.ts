import { describe, expect, it } from "vitest";
import { completionRate, sumParticipants, totalHours, type CycleRow } from "./summary";

function cycle(over: Partial<CycleRow> = {}): CycleRow {
  return {
    cycle_id: "c1",
    org_id: "o1",
    org_name: "Org",
    program_name: "Prog",
    completion_rule: "attendance >= 80%",
    facility_code: "SQ",
    facility_name: "San Quentin",
    start_date: "2025-01-01",
    end_date: null,
    course_hours_planned_per_participant: 20,
    n_enrolled: 10,
    n_completed: 8,
    total_course_hours_delivered: null,
    n_enrolled_approx: 0,
    n_completed_approx: 0,
    total_course_hours_delivered_approx: 0,
    ...over,
  };
}

describe("sumParticipants", () => {
  it("sums known enrollments and skips nulls", () => {
    expect(sumParticipants([cycle(), cycle({ n_enrolled: null }), cycle({ n_enrolled: 5 })])).toEqual({
      value: 15,
      isEstimate: false,
    });
  });
  it("flags approximate inputs", () => {
    expect(sumParticipants([cycle({ n_enrolled_approx: 1 })]).isEstimate).toBe(true);
  });
});

describe("completionRate", () => {
  it("returns numerator and denominator", () => {
    const r = completionRate([cycle(), cycle({ n_enrolled: 20, n_completed: 10 })]);
    expect(r).toMatchObject({ numerator: 18, denominator: 30, cyclesExcluded: 0 });
    expect(r.value).toBeCloseTo(0.6);
  });
  it("excludes unstated rules and missing counts instead of guessing", () => {
    const r = completionRate([
      cycle(),
      cycle({ completion_rule: "unstated" }),
      cycle({ n_completed: null }),
    ]);
    expect(r).toMatchObject({ numerator: 8, denominator: 10, cyclesExcluded: 2 });
  });
  it("is null with no qualifying cycles", () => {
    expect(completionRate([cycle({ completion_rule: "unstated" })]).value).toBeNull();
    expect(completionRate([]).value).toBeNull();
  });
});

describe("totalHours", () => {
  it("prefers delivered hours, falls back to planned as an estimate", () => {
    const h = totalHours([
      cycle({ total_course_hours_delivered: 100 }),
      cycle({ course_hours_planned_per_participant: 24, n_enrolled: 10 }),
    ]);
    expect(h).toMatchObject({ value: 340, isEstimate: true, cyclesDelivered: 1, cyclesPlanned: 1 });
  });
  it("counts cycles with no hours info as unknown, not zero", () => {
    const h = totalHours([cycle({ course_hours_planned_per_participant: null })]);
    expect(h).toMatchObject({ value: 0, cyclesUnknown: 1, isEstimate: false });
  });
});
