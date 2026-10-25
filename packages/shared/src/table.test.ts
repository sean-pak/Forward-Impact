import { describe, expect, it } from "vitest";
import { findHeaderRow, maskValue, parseDate, profileColumns, readCount, rowsFromMapping } from "./table";
import { ColumnMappingSchema } from "./schemas";
import { extractionToRows, numberAppearsIn, scrubIdentifiers } from "./ingestText";

describe("findHeaderRow", () => {
  it("skips notes rows above the header", () => {
    const grid = [["Report"], ["Prepared by staff", ""], ["program", "prison", "n"], ["A", "SQ", "5"], ["B", "CMC", "6"]];
    expect(findHeaderRow(grid)).toBe(2);
  });

  it("accepts a header made of class dates, but not a row of plain numbers", () => {
    const attendance = [["Healing Circle notes", "", "", ""], ["Name", "2026-01-12", "1/19/2026", "Completed?"], ["Ann Example", "X", "X", "Y"]];
    expect(findHeaderRow(attendance)).toBe(1);
    expect(findHeaderRow([["1", "2", "3"], ["a", "b", "c"]])).toBe(1);
  });
});

describe("profileColumns", () => {
  const grid = [["name", "id", "mark"], ["Ann Lee", "SYN00001", "X"], ["Bo Kim", "SYN00002", "P"], ["Cy Fox", "SYN00003", ""]];
  const p = profileColumns(grid, 0);
  it("masks letters and digits", () => {
    expect(maskValue("Ann Lee")).toBe("Aaa Aaa");
    expect(p[1]!.patterns[0]!.pattern).toBe("AAA#####");
  });
  it("never contains a raw name or id", () => {
    const text = JSON.stringify(p);
    for (const raw of ["Ann", "Lee", "Bo", "Kim", "SYN00001"]) expect(text).not.toContain(raw);
  });
  it("keeps single-character marks and reports null share", () => {
    expect(p[2]!.patterns.map((x) => x.pattern).sort()).toEqual(["P", "X"]);
    expect(p[2]!.null_share).toBeCloseTo(0.33, 2);
  });
});

describe("parseDate / readCount", () => {
  it("reads ISO and US dates, nothing else", () => {
    expect(parseDate("2025-03-10")).toBe("2025-03-10");
    expect(parseDate("3/10/2025")).toBe("2025-03-10");
    expect(parseDate("3/10/25")).toBe("2025-03-10");
    expect(parseDate("13/45/2025")).toBeNull();
    expect(parseDate("spring 2025")).toBeNull();
  });
  it("flags approximate counts", () => {
    expect(readCount("about 30")).toEqual({ value: "30", approx: true });
    expect(readCount("~12")).toEqual({ value: "12", approx: true });
    expect(readCount("25")).toEqual({ value: "25", approx: false });
  });
});

describe("ColumnMapping", () => {
  it("rejects a target used twice", () => {
    const bad = { persona: 1, unmapped_marks: [], columns: [{ index: 0, target: "n_enrolled" }, { index: 1, target: "n_enrolled" }] };
    expect(ColumnMappingSchema.safeParse(bad).success).toBe(false);
  });
});

describe("rowsFromMapping", () => {
  it("builds form rows from a mapped grid", () => {
    const m = ColumnMappingSchema.parse({ persona: 1, unmapped_marks: [], columns: [{ index: 0, target: "program_name" }, { index: 1, target: "n_enrolled" }, { index: 2, target: "start_date" }] });
    const { rows } = rowsFromMapping([["p", "n", "d"], ["Art", "about 20", "3/1/2025"], ["", "", ""]], 0, m);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ program_name: "Art", n_enrolled: "20", n_enrolled_approx: true, start_date: "2025-03-01" });
  });
});

describe("text helpers", () => {
  it("finds numbers as digits or words", () => {
    expect(numberAppearsIn(30, "about 30 guys")).toBe(true);
    expect(numberAppearsIn(30, "about thirty guys")).toBe(true);
    expect(numberAppearsIn(99, "about 30 guys")).toBe(false);
    expect(numberAppearsIn(3, "we had 30 guys")).toBe(false);
  });
  it("scrubs ids and emails", () => {
    expect(scrubIdentifiers("A12345 SYN00001 a@b.org")).toBe("[id] [id] [email]");
  });
  it("drops unsupported counts", () => {
    const r = extractionToRows({ persona: 2, cycles: [{ program_name: "X", facility_raw: null, yard: null, start_date: null, end_date: null, sessions_planned: null, course_hours_planned_per_participant: null, n_enrolled: 99, n_completed: null, total_course_hours_delivered: null, n_enrolled_approx: false, n_completed_approx: false, total_course_hours_delivered_approx: false, completion_rule_stated: null, evidence: null }] }, "we had 30");
    expect(r.rows[0]!.n_enrolled).toBe("");
    expect(r.unsupported).toHaveLength(1);
  });
});
