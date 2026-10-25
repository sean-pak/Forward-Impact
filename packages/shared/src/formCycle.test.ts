import { describe, expect, it } from "vitest";
import { cleanCycleRow, cycleKey, timeAgo, isBlankRow, isBlocking, needsCompletedCount, parseIsoDate, type CycleFormRow } from "./formCycle";

const row = (o: Partial<CycleFormRow> = {}): CycleFormRow => ({
  program_id: "p1", program_name: "Writing Circle", facility_raw: "San Quentin", yard: "", start_date: "2025-02-01",
  end_date: "", sessions_planned: "", course_hours_planned_per_participant: "", n_enrolled: "30", n_completed: "",
  total_course_hours_delivered: "", n_enrolled_approx: false, n_completed_approx: false,
  total_course_hours_delivered_approx: false, completion_rule: "attendance >= 80%", extra: {}, ...o,
});

describe("cleanCycleRow", () => {
  it("reads a good row with no issues", () => {
    const { cycle, issues } = cleanCycleRow(row({ n_completed: "24" }), []);
    expect(issues).toEqual([]);
    expect(cycle).toMatchObject({ facility_code: "SQ", n_enrolled: 30, n_completed: 24, start_date: "2025-02-01" });
  });

  it("resolves a facility alias", () => {
    expect(cleanCycleRow(row({ facility_raw: "Men's Colony" }), []).cycle.facility_code).toBe("CMC");
  });

  it("flags an unmatched facility as ambiguous and keeps it null", () => {
    const { cycle, issues } = cleanCycleRow(row({ facility_raw: "Soledad" }), []);
    expect(cycle.facility_code).toBeNull();
    expect(issues).toEqual([expect.objectContaining({ field_name: "facility_code", issue_type: "ambiguous_mapping", raw_value: "Soledad" })]);
  });

  it("never invents missing required values", () => {
    const { cycle, issues } = cleanCycleRow(row({ n_enrolled: "", facility_raw: "", start_date: "" }), []);
    expect(cycle).toMatchObject({ n_enrolled: null, facility_code: null, start_date: null });
    expect(issues.map((i) => i.field_name).sort()).toEqual(["facility_code", "n_enrolled", "start_date"]);
    expect(issues.every(isBlocking)).toBe(true);
  });

  it("rejects 'about 30' as text and keeps the approx flag only with a value", () => {
    const a = cleanCycleRow(row({ n_enrolled: "about 30" }), []);
    expect(a.cycle.n_enrolled).toBeNull();
    expect(a.issues[0]).toMatchObject({ issue_type: "invalid_value", raw_value: "about 30" });
    const b = cleanCycleRow(row({ n_enrolled: "30", n_enrolled_approx: true }), []);
    expect(b.cycle).toMatchObject({ n_enrolled: 30, n_enrolled_approx: true });
    expect(cleanCycleRow(row({ n_enrolled: "", n_enrolled_approx: true }), []).cycle.n_enrolled_approx).toBe(false);
  });

  it("checks completed <= enrolled and end >= start", () => {
    const { issues } = cleanCycleRow(row({ n_completed: "31", end_date: "2025-01-01" }), []);
    expect(issues.map((i) => [i.field_name, i.issue_type])).toEqual([["n_completed", "out_of_range"], ["end_date", "out_of_range"]]);
  });

  it("stores 'unstated' and flags it only when completions were given; not blocking", () => {
    const none = cleanCycleRow(row({ completion_rule: "" }), []);
    expect(none.cycle.completion_rule).toBe("unstated");
    expect(none.issues).toEqual([]);
    const some = cleanCycleRow(row({ completion_rule: "", n_completed: "20" }), []);
    expect(some.issues).toEqual([expect.objectContaining({ field_name: "completion_rule", issue_type: "missing_required" })]);
    expect(isBlocking(some.issues[0]!)).toBe(false);
  });

  it("validates registry fields by type", () => {
    const registry = [
      { field_key: "n_graduated_ged", label: "GED graduates", type: "integer" as const, options: null, required: false },
      { field_key: "setting", label: "Setting", type: "enum" as const, options: ["classroom", "yard"], required: true },
    ];
    const ok = cleanCycleRow(row({ extra: { n_graduated_ged: "4", setting: "yard" } }), registry);
    expect(ok.cycle.extra).toEqual({ n_graduated_ged: 4, setting: "yard" });
    const bad = cleanCycleRow(row({ extra: { n_graduated_ged: "x", setting: "" } }), registry);
    expect(bad.issues.map((i) => [i.field_name, i.issue_type])).toEqual([["n_graduated_ged", "invalid_value"], ["setting", "missing_required"]]);
    expect(bad.issues.some(isBlocking)).toBe(true);
    expect(isBlocking(bad.issues[1]!)).toBe(false);
  });
});

describe("helpers", () => {
  it("isBlankRow ignores pre-filled program details", () => {
    expect(isBlankRow(row({ start_date: "", n_enrolled: "" }))).toBe(true);
    expect(isBlankRow(row())).toBe(false);
  });
  it("parseIsoDate is strict", () => {
    expect(parseIsoDate("2025-02-29")).toBeNull();
    expect(parseIsoDate("2024-02-29")).toBe("2024-02-29");
    expect(parseIsoDate("2/1/2025")).toBeNull();
  });
  it("cycleKey uses 'unknown' for gaps", () => {
    expect(cycleKey("o1", "p1", null, "2025-01-01")).toBe("o1|p1|unknown|2025-01-01");
  });
});

describe("timeAgo", () => {
  const now = new Date("2025-03-01T12:00:00Z");
  it("reads naturally", () => {
    expect(timeAgo("2025-03-01T11:59:40Z", now)).toBe("just now");
    expect(timeAgo("2025-03-01T11:59:00Z", now)).toBe("1 minute ago");
    expect(timeAgo("2025-03-01T11:45:00Z", now)).toBe("15 minutes ago");
    expect(timeAgo("2025-03-01T10:00:00Z", now)).toBe("2 hours ago");
    expect(timeAgo("2025-02-26T12:00:00Z", now)).toBe("3 days ago");
  });
});

describe("needsCompletedCount", () => {
  it("asks when completed is blank and the cycle is finished or its end is unknown", () => {
    expect(needsCompletedCount({ n_completed: null, end_date: "2025-06-09" }, "2025-10-24")).toBe(true);
    expect(needsCompletedCount({ n_completed: null, end_date: null }, "2025-10-24")).toBe(true);
  });
  it("does not ask for a cycle still running, or when a count exists (including 0)", () => {
    expect(needsCompletedCount({ n_completed: null, end_date: "2026-01-01" }, "2025-10-24")).toBe(false);
    expect(needsCompletedCount({ n_completed: 0, end_date: null }, "2025-10-24")).toBe(false);
  });
});
