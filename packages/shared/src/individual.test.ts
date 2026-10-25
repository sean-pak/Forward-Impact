import { describe, expect, it } from "vitest";
import { deriveCycles, type StoredCycle } from "./answers";
import { groupCycles, individualIssues, individualNoteLines, openMarks, parseIndividual, UNNAMED_PROGRAM } from "./individual";
import { ColumnMappingSchema } from "./schemas";
import { isBlocking } from "./formCycle";

const mapping = (cols: Record<number, string>, persona = 3) =>
  ColumnMappingSchema.parse({ persona, columns: Object.entries(cols).map(([index, target]) => ({ index: Number(index), target })), unmapped_marks: [] });

const sheet = [
  ["Healing Circle - San Quentin. Completion = attended at least 80% of sessions.", "", "", "", "", ""],
  ["Name", "CDCR #", "2026-01-12", "2026-01-19", "2026-01-26", "Completed?"],
  ["Rae Quillon", "SYN00001", "X", "X", "", "Y"],
  ["Tomas Veldkamp", "", "X", "L", "", "N"],
  ["Total", "", "2", "2", "0", ""],
];

describe("parseIndividual: attendance sheet", () => {
  const m = mapping({ 0: "id_full_name", 1: "id_cdcr", 5: "completed_flag" });
  const parsed = parseIndividual(sheet, 1, m, { programs: ["Healing Circle", "Other"] });

  it("finds class dates from the headers, skips totals, and reads the notes rows", () => {
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.grain).toBe("attendance");
    expect(parsed.sessions.map((s) => s.date)).toEqual(["2026-01-12", "2026-01-19", "2026-01-26"]);
    expect(parsed.people.map((p) => p.row)).toEqual([3, 4]);
    expect(parsed.notes).toEqual({ facility_raw: "San Quentin Rehabilitation Center", program_name: "Healing Circle", rule: "attended at least 80% of sessions" });
    expect(parsed.people[0]).toMatchObject({ first: "Rae", last: "Quillon", cdcr: "SYN00001", marks: ["X", "X", ""], cbo: "yes" });
    expect(parsed.people[1]).toMatchObject({ cdcr: null, marks: ["X", "L", ""] });
  });

  it("treats a date nobody has a mark for as cancelled", () => {
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.cancelled).toEqual([false, false, true]);
    expect(parsed.counts).toMatchObject({ cancelled_sessions: 1, no_cdcr: 1 });
  });

  it("makes one cycle with the facts from the notes", () => {
    if ("error" in parsed) throw new Error(parsed.error);
    const [g, ...rest] = groupCycles(parsed);
    expect(rest).toEqual([]);
    expect(g).toMatchObject({ program_name: "Healing Circle", facility_raw: "San Quentin Rehabilitation Center", start: "2026-01-12", end: "2026-01-19", rule: "attended at least 80% of sessions" });
  });

  it("names the program unnamed when nothing says, so Sam asks", () => {
    const p = parseIndividual(sheet, 1, m, { programs: [] });
    if ("error" in p) throw new Error(p.error);
    expect(groupCycles(p)[0]!.program_name).toBe(UNNAMED_PROGRAM);
  });

  it("refuses a sheet with no marks at all", () => {
    const empty = [sheet[1]!, ["Rae Quillon", "SYN00001", "", "", "", ""]];
    expect(parseIndividual(empty, 0, m, { programs: [] })).toEqual({ error: "no marks" });
  });
});

describe("parseIndividual: one row per enrollment", () => {
  const grid = [
    ["Name", "Inmate #", "DOB", "Program", "Facility", "Start", "Grad?", "Credits", "Release", "Risk"],
    ["Pia Randolph", "syn 00010", "3/4/1985", "Reentry Readiness", "Folsom", "2025-02-03", "Y", "30", "2026-05-01", "Low"],
    ["Orin Beckett", "A12345", "1/2/1990", "Reentry Readiness", "Folsom", "2025-02-03", "maybe", "x", "2099-01-01", ""],
    ["Pia Randolph", "SYN00010", "3/4/1985", "Job Skills", "San Quentin", "2025-03-03", "N", "", "", "High"],
  ];
  const m = mapping({ 0: "id_full_name", 1: "id_cdcr", 2: "id_dob", 3: "program_name", 4: "facility_raw", 5: "start_date", 6: "completed_flag", 7: "credit_days_earned", 8: "release_date", 9: "risk_band" }, 4);
  const parsed = parseIndividual(grid, 0, m, { programs: [] });

  it("reads every column with code and counts what it could not read", () => {
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.grain).toBe("people");
    expect(parsed.people[0]).toMatchObject({ cdcr: "SYN00010", dob: "1985-03-04", credits: 30, release_date: "2026-05-01", risk: "low", cbo: "yes" });
    expect(parsed.people[1]).toMatchObject({ cdcr: null, cbo: "unknown", credits: null, release_date: "2099-01-01" });
    expect(parsed.counts).toMatchObject({ bad_cdcr: 1, no_cdcr: 1, unreadable_completed: 1, unreadable_number: 1 });
  });

  it("groups rows into cycles by program, prison and start date", () => {
    if ("error" in parsed) throw new Error(parsed.error);
    const groups = groupCycles(parsed);
    expect(groups.map((g) => [g.program_name, g.people.length])).toEqual([["Reentry Readiness", 2], ["Job Skills", 1]]);
  });
});

describe("individualIssues", () => {
  const cycle = { program_name: "Healing Circle", completion_rule: "attended at least 80% of sessions" };
  it("asks what each unknown mark means, and about late in the same question", () => {
    const [i, ...rest] = individualIssues({ _individual: "attendance", _marks_unknown: ["JT", "L"] }, cycle);
    expect(rest).toEqual([]);
    expect(i).toMatchObject({ field_name: "attendance_legend", issue_type: "ambiguous_mapping" });
    expect(i!.message).toBe("What do 'JT' and 'L' mean in the attendance sheet for Healing Circle? For each one, is it present, absent, excused or late? And does a late count as attended?");
    expect(isBlocking(i!)).toBe(true);
  });

  it("stops asking about marks once they are answered, then asks only about late", () => {
    const extra = { _individual: "attendance" as const, _marks_unknown: ["JT", "L"], _legend: { JT: "excused", L: "late" } as const };
    expect(openMarks(extra)).toEqual([]);
    expect(individualIssues(extra, cycle).map((i) => i.field_name)).toEqual(["late_counts"]);
    expect(individualIssues({ ...extra, _late_counts: true }, cycle)).toEqual([]);
    expect(individualIssues({ ...extra, _late_counts: false }, cycle)).toEqual([]);
  });

  it("does not ask about late when the CBO already said what L is without a late meaning", () => {
    const extra = { _individual: "attendance" as const, _marks_unknown: ["L"], _legend: { L: "excused" } as const };
    expect(individualIssues(extra, cycle)).toEqual([]);
  });

  it("asks about one possible duplicate at a time and does not block on it", () => {
    const pairs = [{ id: "a|b", a: "a", b: "b", rows: [12, 41] as [number, number] }, { id: "c|d", a: "c", b: "d", rows: [5, 6] as [number, number] }];
    const [first] = individualIssues({ _individual: "attendance", _dup_pairs: pairs }, cycle);
    expect(first!.message).toContain("Lines 12 and 41");
    expect(isBlocking(first!)).toBe(false);
    const [second] = individualIssues({ _individual: "attendance", _dup_pairs: pairs, _dup_resolved: { "a|b": "same" } }, cycle);
    expect(second!.message).toContain("Lines 5 and 6");
    expect(individualIssues({ _individual: "attendance", _dup_pairs: pairs, _dup_resolved: { "a|b": "same", "c|d": "different" } }, cycle)).toEqual([]);
  });

  it("asks for an unstated completion rule on an attendance sheet, and for an unnamed program", () => {
    const issues = individualIssues({ _individual: "attendance" }, { program_name: UNNAMED_PROGRAM, completion_rule: "unstated" });
    expect(issues.map((i) => i.field_name)).toEqual(["completion_rule", "program_name"]);
    expect(issues.some(isBlocking)).toBe(false);
  });

  it("never lists a mark more than once or leaks free text", () => {
    const [i] = individualIssues({ _individual: "attendance", _marks_unknown: ["?"] }, cycle);
    expect(i!.message).toContain("longer text entries");
  });
});

describe("deriveCycles with individual cycles", () => {
  const st = (over: Partial<StoredCycle>): StoredCycle => ({
    cycle_id: "c1", program_id: "p1", program_name: "Healing Circle", facility_code: "SQ", facility_raw: null, yard: null,
    start_date: "2026-01-12", end_date: "2026-01-26", sessions_planned: 3, course_hours_planned_per_participant: null,
    n_enrolled: 60, n_completed: null, total_course_hours_delivered: null,
    n_enrolled_approx: false, n_completed_approx: false, total_course_hours_delivered_approx: false,
    source_grain: "derived_from_individuals", extra: { _individual: "attendance", _completion_rule: "attended at least 80% of sessions", _marks_unknown: ["JT"] }, ...over,
  });
  it("never asks for a typed completed count, and blocks on the legend", () => {
    const [d] = deriveCycles("o1", [st({})], [], "2026-10-24");
    expect(d!.issues.map((i) => i.field_name)).toEqual(["attendance_legend"]);
    expect(d!.blocked).toBe(true);
  });
  it("is clear once the marks are explained", () => {
    const [d] = deriveCycles("o1", [st({ n_completed: 40, extra: { _individual: "attendance", _completion_rule: "attended at least 80% of sessions", _marks_unknown: ["JT"], _legend: { JT: "excused" } } })], [], "2026-10-24");
    expect(d!.issues).toEqual([]);
    expect(d!.blocked).toBe(false);
  });
});

describe("individualNoteLines", () => {
  it("adds counters across cycles and skips zeros", () => {
    const lines = individualNoteLines([{ future_release: 2, no_cdcr: 1 }, { future_release: 3, bad_cdcr: 0 }]);
    expect(lines).toEqual([
      "1 person has no CDCR number, so they are matched by name inside your organization only.",
      "5 release dates were in the future, so I saved them as expected release dates.",
    ]);
  });
});
