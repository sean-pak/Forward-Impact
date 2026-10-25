import { describe, expect, it } from "vitest";
import { ageBandAt, fiscalYear, nameVariants, readCdcr, readCompleted, readRisk, readSupervision, splitName } from "./people";

describe("readCdcr", () => {
  it("accepts only SYN test numbers, normalized", () => {
    expect(readCdcr("syn-04817")).toEqual({ kind: "ok", value: "SYN04817" });
    expect(readCdcr("")).toEqual({ kind: "none" });
    expect(readCdcr("A12345")).toEqual({ kind: "refused" });
  });
});

describe("splitName", () => {
  it.each([
    ["Dana Rivera", "Dana", "Rivera"],
    ["Rivera, Dana", "Dana", "Rivera"],
    ["Mary Ann Okafor", "Mary Ann", "Okafor"],
  ])("%s", (raw, first, last) => expect(splitName(raw)).toEqual({ first, last }));
  it("handles one word and blanks", () => {
    expect(splitName("Cher")).toEqual({ first: "Cher", last: null });
    expect(splitName("  ")).toEqual({ first: null, last: null });
  });
});

describe("nameVariants", () => {
  const row = (key: string, row: number, first: string, last: string, cdcr: string | null = null, dob: string | null = null) => ({ key, row, first, last, cdcr, dob });
  it("flags one-letter spelling variants and nothing else", () => {
    const pairs = nameVariants([row("a", 3, "Jon", "Smithers"), row("b", 9, "John", "Smithers"), row("c", 5, "Maria", "Lopez"), row("d", 6, "Marta", "Lopez")]);
    expect(pairs.map(([x, y]) => [x.row, y.row])).toEqual([[3, 9], [5, 6]]);
  });
  it("does not flag two exact name matches with different keys (the key decides) or different identifiers", () => {
    expect(nameVariants([row("a", 1, "Jon", "Smith"), row("b", 2, "Jon", "Smith")])).toEqual([]);
    expect(nameVariants([row("a", 1, "Jon", "Smith", "SYN00001"), row("b", 2, "John", "Smith", "SYN00002")])).toEqual([]);
    expect(nameVariants([row("a", 1, "Jon", "Smith", null, "1980-01-01"), row("b", 2, "John", "Smith", null, "1981-01-01")])).toEqual([]);
  });
  it("needs both name parts", () => {
    expect(nameVariants([row("a", 1, "Jon", ""), row("b", 2, "John", "")])).toEqual([]);
  });
});

describe("column readers", () => {
  it("completed", () => {
    expect(readCompleted("Y").value).toBe("yes");
    expect(readCompleted("Graduated").value).toBe("yes");
    expect(readCompleted("no").value).toBe("no");
    expect(readCompleted("in progress").value).toBe("in_progress");
    expect(readCompleted("")).toEqual({ value: "unknown", readable: true });
    expect(readCompleted("sort of")).toEqual({ value: "unknown", readable: false });
  });
  it("risk and supervision", () => {
    expect(readRisk("Med").value).toBe("moderate");
    expect(readRisk("")).toEqual({ value: "unknown", readable: true });
    expect(readRisk("7")).toEqual({ value: "unknown", readable: false });
    expect(readSupervision("PRCS").value).toBe("prcs");
    expect(readSupervision("Parole").value).toBe("parole");
  });
});

describe("dates", () => {
  it("fiscal year runs July 1 to June 30", () => {
    expect(fiscalYear("2023-03-01")).toBe("FY2022_23");
    expect(fiscalYear("2022-07-01")).toBe("FY2022_23");
    expect(fiscalYear("2022-06-30")).toBe("FY2021_22");
    expect(fiscalYear("1999-12-31")).toBe("FY1999_00");
  });
  it("age band uses whole years at the date", () => {
    expect(ageBandAt("1990-06-15", "2024-06-14")).toBe("30_34");
    expect(ageBandAt("1990-06-15", "2024-06-15")).toBe("30_34");
    expect(ageBandAt("1990-06-15", "2025-06-14")).toBe("30_34");
    expect(ageBandAt("1990-06-15", "2025-06-15")).toBe("35_39");
    expect(ageBandAt("2010-01-01", "2024-01-01")).toBe("unknown");
    expect(ageBandAt("1950-01-01", "2024-01-01")).toBe("60_plus");
    expect(ageBandAt("nope", "2024-01-01")).toBe("unknown");
  });
});
