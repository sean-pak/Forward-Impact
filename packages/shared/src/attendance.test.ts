import { describe, expect, it } from "vitest";
import { computeAttendance, normalizeMark, standardMeaning, type AttendanceInput } from "./attendance";

const sessions = (n: number, cancelled: number[] = []) => Array.from({ length: n }, (_, i) => ({ cancelled: cancelled.includes(i) }));
const base = (over: Partial<AttendanceInput>): AttendanceInput => ({ sessions: sessions(5), people: [], legend: {}, lateCounts: null, rule: "attended at least 80% of sessions", ...over });

describe("marks", () => {
  it("normalizes and recognises the standard marks", () => {
    expect(normalizeMark(" x ")).toBe("X");
    expect(standardMeaning("✓")).toBe("present");
    expect(standardMeaning("")).toBe("absent");
    expect(standardMeaning("E")).toBe("excused");
  });
  it("leaves L and initials for the CBO to explain", () => {
    expect(standardMeaning("L")).toBeNull();
    expect(standardMeaning("JT")).toBeNull();
  });
  it("never keeps free text", () => {
    expect(normalizeMark("Went to court on Tuesday")).toBe("?");
  });
});

describe("computeAttendance", () => {
  const p = (key: string, marks: string[], cbo: "yes" | "no" | "unknown" = "unknown") => ({ key, marks, cbo });

  it("counts attended and planned, and applies the rule", () => {
    const r = computeAttendance(base({ people: [p("a", ["X", "X", "X", "X", ""]), p("b", ["X", "", "", "A", "X"])] }));
    expect(r.unknownMarks).toEqual([]);
    expect(r.people[0]).toMatchObject({ attended: 4, planned: 5, rate: 0.8, completed: "yes", basis: "rule_applied" });
    expect(r.people[1]).toMatchObject({ attended: 2, planned: 5, completed: "no" });
    expect(r.nCompleted).toBe(1);
    expect(r.nEnrolled).toBe(2);
  });

  it("leaves cancelled dates out of attended and planned for everyone", () => {
    const r = computeAttendance(base({ sessions: sessions(5, [1]), people: [p("a", ["X", "", "X", "X", "X"])] }));
    expect(r.people[0]).toMatchObject({ attended: 4, planned: 4, completed: "yes" });
  });

  it("asks instead of guessing: unknown marks leave attendance empty", () => {
    const r = computeAttendance(base({ people: [p("a", ["X", "JT", "L", "X", "X"])] }));
    expect(r.unknownMarks).toEqual(["JT", "L"]);
    expect(r.people[0]).toMatchObject({ attended: null, rate: null, completed: "unknown" });
    expect(r.nCompleted).toBeNull();
  });

  it("does not fall back to the CBO's mark while a rule is waiting on the marks", () => {
    const r = computeAttendance(base({ people: [p("a", ["X", "L", "X", "X", "X"], "yes")] }));
    expect(r.people[0]).toMatchObject({ completed: "unknown", basis: "unknown" });
    expect(r.nCompleted).toBeNull();
  });

  it("applies the legend, excused counts as planned but not attended, and late follows the answer", () => {
    const people = [p("a", ["X", "JT", "L", "X", "X"])];
    const legend = { JT: "excused", L: "late" } as const;
    const asked = computeAttendance(base({ people, legend: { ...legend }, lateCounts: null }));
    expect(asked.unknownMarks).toEqual([]);
    expect(asked.needsLate).toBe(true);
    expect(asked.people[0]!.attended).toBeNull();
    const yes = computeAttendance(base({ people, legend: { ...legend }, lateCounts: true }));
    expect(yes.people[0]).toMatchObject({ attended: 4, planned: 5, rate: 0.8, completed: "yes" });
    const no = computeAttendance(base({ people, legend: { ...legend }, lateCounts: false }));
    expect(no.people[0]).toMatchObject({ attended: 3, planned: 5, completed: "no" });
  });

  it("the rule wins over the CBO's own mark, and the disagreement is counted", () => {
    const r = computeAttendance(base({ people: [p("a", ["X", "X", "X", "X", "X"], "no"), p("b", ["", "", "", "", "X"], "yes"), p("c", ["X", "X", "X", "X", ""], "yes")] }));
    expect(r.people.map((x) => x.completed)).toEqual(["yes", "no", "yes"]);
    expect(r.conflicts).toBe(2);
  });

  it("falls back to the CBO's mark when the rule is unstated or cannot be applied", () => {
    for (const rule of ["unstated", "finished the capstone"]) {
      const r = computeAttendance(base({ rule, people: [p("a", ["X", "X", "X", "X", "X"], "no"), p("b", ["", "", "", "", ""], "yes")] }));
      expect(r.people.map((x) => [x.completed, x.basis])).toEqual([["no", "cbo_marked"], ["yes", "cbo_marked"]]);
      expect(r.nCompleted).toBe(1);
      expect(r.ruleApplied).toBe(false);
    }
  });

  it("leaves completion unknown when there is no rule and no mark", () => {
    const r = computeAttendance(base({ rule: "unstated", people: [p("a", ["X", "X", "X", "X", "X"])] }));
    expect(r.people[0]).toMatchObject({ attended: 5, completed: "unknown", basis: "unknown" });
    expect(r.nCompleted).toBeNull();
  });
});
