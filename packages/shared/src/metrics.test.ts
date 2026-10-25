import { describe, expect, it } from "vitest";
import { buildDashboard, byFacility, completionMetric, guardCount, guardRate, hoursMetric, participantsMetric } from "./metrics";
import type { CycleRow } from "./summary";

function cycle(over: Partial<CycleRow> = {}): CycleRow {
  return {
    cycle_id: "c1", org_id: "o1", org_name: "Org", program_name: "Prog",
    completion_rule: "attendance >= 80%", facility_code: "SQ", facility_name: "San Quentin",
    start_date: "2025-01-01", end_date: null, course_hours_planned_per_participant: 20,
    n_enrolled: 40, n_completed: 30, total_course_hours_delivered: null,
    n_enrolled_approx: 0, n_completed_approx: 0, total_course_hours_delivered_approx: 0,
    ...over,
  };
}
const facilities = [
  { facility_code: "SQ", facility_name: "San Quentin" },
  { facility_code: "SATF", facility_name: "SATF" },
];

describe("metrics", () => {
  it("participants, completion, hours carry the Metric shape", () => {
    const cs = [cycle(), cycle({ cycle_id: "c2", n_enrolled: 10, n_completed: 5, n_enrolled_approx: 1 })];
    expect(participantsMetric(cs)).toEqual({ value: 50, isEstimate: true, suppressed: false });
    expect(completionMetric(cs)).toMatchObject({ value: 35 / 50, numerator: 35, denominator: 50, suppressed: false });
    expect(hoursMetric(cs)).toMatchObject({ value: 20 * 50, isEstimate: true, suppressed: false });
  });
  it("guardRate hides numerator and denominator too", () => {
    const m = guardRate(completionMetric([cycle({ n_enrolled: 20, n_completed: 10 })]));
    expect(m).toEqual({ value: null, isEstimate: false, suppressed: true });
  });
  it("guardRate leaves a no-data rate as null, not suppressed", () => {
    expect(guardRate(completionMetric([cycle({ completion_rule: "unstated" })])).suppressed).toBe(false);
  });
  it("guardCount hides 1 to 10 and keeps 0", () => {
    expect(guardCount({ value: 7, isEstimate: false, suppressed: false }).suppressed).toBe(true);
    expect(guardCount({ value: 0, isEstimate: false, suppressed: false }).suppressed).toBe(false);
  });
});

describe("byFacility", () => {
  const three = ["o1", "o2", "o3"].map((o, i) => cycle({ cycle_id: `c${i}`, org_id: o }));
  it("public: facility with under 3 orgs is wholly suppressed and exposes no org count", () => {
    const row = byFacility([cycle(), cycle({ cycle_id: "c2", org_id: "o2" })], "public")[0]!;
    expect(row.suppressed).toBe(true);
    expect(row.participants.suppressed && row.completion.suppressed && row.hours.suppressed).toBe(true);
    expect(row.orgs).toBeNull();
    expect(JSON.stringify(row)).not.toContain("80");
  });
  it("public: 3 orgs with big denominators are shown", () => {
    const row = byFacility(three, "public")[0]!;
    expect(row.suppressed).toBe(false);
    expect(row.participants.value).toBe(120);
    expect(row.completion).toMatchObject({ numerator: 90, denominator: 120, suppressed: false });
  });
  it("public: small pooled denominator hides the rate, small count hides hours", () => {
    const small = ["o1", "o2", "o3"].map((o, i) => cycle({ cycle_id: `s${i}`, org_id: o, n_enrolled: 3, n_completed: 2 }));
    const row = byFacility(small, "public")[0]!;
    expect(row.completion.suppressed).toBe(true);
    expect(row.participants.value).toBeNull(); // 9 is within 1 to 10
    expect(row.hours.suppressed).toBe(true);
  });
  it("staff: nothing suppressed, org count visible", () => {
    const row = byFacility([cycle({ n_enrolled: 3, n_completed: 2 })], "staff")[0]!;
    expect(row.suppressed).toBe(false);
    expect(row.participants.value).toBe(3);
    expect(row.orgs).toBe(1);
  });
});

describe("buildDashboard", () => {
  it("staff keeps cycles; public drops them and suppresses small totals", () => {
    const cs = [cycle({ n_enrolled: 8, n_completed: 6 })];
    const staff = buildDashboard(cs, facilities, "staff");
    expect(staff.cycles).toHaveLength(1);
    expect(staff.participants.value).toBe(8);
    const pub = buildDashboard(cs, facilities, "public");
    expect(pub.cycles).toEqual([]);
    expect(pub.participants).toMatchObject({ value: null, suppressed: true });
    expect(pub.completion.suppressed).toBe(true);
    expect(pub.hours.suppressed).toBe(true);
  });
  it("reports prisons covered and deserts", () => {
    const d = buildDashboard([cycle()], facilities, "staff");
    expect(d.prisons).toEqual({ covered: 1, total: 2 });
    expect(d.deserts).toEqual([{ facility_code: "SATF", facility_name: "SATF" }]);
  });
  it("public shows large pooled totals", () => {
    const cs = ["o1", "o2"].map((o, i) => cycle({ cycle_id: `c${i}`, org_id: o }));
    const pub = buildDashboard(cs, facilities, "public");
    expect(pub.participants.value).toBe(80);
    expect(pub.completion).toMatchObject({ numerator: 60, denominator: 80, suppressed: false });
  });
});
