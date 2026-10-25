import { describe, expect, it } from "vitest";
import { cleanCycleRow, type CycleFormRow, type RegistryField } from "./formCycle";
import {
  NewFieldSchema, defaultAskTemplate, fillAsk, isIdentifierHeader, matchRegistryHeader, normalizeHeader, registryQuestion, slugFieldKey, suggestableHeader,
} from "./fieldRegistry";
import type { ColumnMapping } from "./schemas";
import { findHeaderRow, rowsFromMapping } from "./table";

describe("slugFieldKey", () => {
  it("makes a key from a label", () => {
    expect(slugFieldKey("RAC eligible?")).toBe("rac_eligible");
    expect(slugFieldKey("  Hours / week (avg) ")).toBe("hours_week_avg");
    expect(slugFieldKey("???")).toBeNull();
  });
});

describe("NewFieldSchema", () => {
  const ok = (v: unknown) => NewFieldSchema.safeParse(v);
  it("builds the key and the default question from the label", () => {
    const r = ok({ label: "RAC eligible?", type: "boolean" });
    expect(r.success && r.data).toMatchObject({
      field_key: "rac_eligible", options: null, required: false, ask_template: "For {program}: RAC eligible?",
    });
  });
  it("needs two different options for a choice field", () => {
    expect(ok({ label: "Track", type: "enum" }).success).toBe(false);
    expect(ok({ label: "Track", type: "enum", options: ["A", "A"] }).success).toBe(false);
    expect(ok({ label: "Track", type: "enum", options: ["A", "B"] }).success).toBe(true);
  });
  it("rejects core, reserved and underscore keys, long labels and unknown placeholders", () => {
    expect(ok({ label: "x", field_key: "n_enrolled", type: "text" }).success).toBe(false);
    expect(ok({ label: "x", field_key: "id_cdcr", type: "text" }).success).toBe(false);
    expect(ok({ label: "x", field_key: "_completion_rule", type: "text" }).success).toBe(false);
    expect(ok({ label: "Start date", type: "text" }).success).toBe(false); // slugs to the core key start_date
    expect(ok({ label: "x".repeat(81), type: "text" }).success).toBe(false);
    expect(ok({ label: "Ok", type: "text", ask_template: "Tell me about {name}" }).success).toBe(false);
    expect(ok({ label: "Ok", type: "text", ask_template: "For {program} at {facility}: ok?" }).success).toBe(true);
  });
});

describe("fillAsk / registryQuestion", () => {
  it("fills program and facility", () => {
    expect(fillAsk("{program} at {facility}?", { program: "Writing", facility: "San Quentin" })).toBe("Writing at San Quentin?");
    expect(fillAsk("{program} at {facility}?", { program: "Writing" })).toBe("Writing at the prison?");
  });
  it("adds an answer hint by type", () => {
    const f = { label: "RAC eligible?", ask_template: defaultAskTemplate("RAC eligible?") };
    expect(registryQuestion({ ...f, type: "boolean", options: null }, { program: "Writing" })).toBe("For Writing: RAC eligible? Please reply YES or NO.");
    expect(registryQuestion({ ...f, type: "enum", options: ["A", "B"] }, { program: "Writing" })).toContain("Please choose one of: A, B.");
  });
});

describe("headers", () => {
  const registry = [{ field_key: "rac_eligible", label: "RAC eligible?" }];
  it("matches by label or key, ignoring case and punctuation", () => {
    expect(normalizeHeader(" RAC  Eligible? ")).toBe("rac eligible");
    expect(matchRegistryHeader("rac eligible", registry)).toBe("rac_eligible");
    expect(matchRegistryHeader("RAC_ELIGIBLE", registry)).toBe("rac_eligible");
    expect(matchRegistryHeader("RAC status", registry)).toBeNull();
  });
  it("never suggests an identifier-like header", () => {
    for (const h of ["Name", "First Name", "Participant name", "CDCR #", "CDCR Number", "DOB", "Date of Birth", "SSN", "Email", "Phone", "id_cdcr", "ID", "Inmate ID", "Contact email", "Mobile", "Tel 5551234567"]) {
      expect(isIdentifierHeader(h), h).toBe(true);
      expect(suggestableHeader(h), h).toBeNull();
    }
    expect(suggestableHeader("RAC eligible?")).toEqual({ key: "rac_eligible", label: "RAC eligible?" });
    expect(suggestableHeader("Grant year")).toEqual({ key: "grant_year", label: "Grant year" });
  });
  it("does not suggest a built-in key or a blank", () => {
    expect(suggestableHeader("Start date")).toBeNull();
    expect(suggestableHeader("")).toBeNull();
    expect(suggestableHeader("7")).toBeNull();
  });
});

describe("required registry message", () => {
  const blank: CycleFormRow = {
    program_id: "p", program_name: "Writing", facility_raw: "San Quentin", yard: "", start_date: "2026-01-05", end_date: "", sessions_planned: "",
    course_hours_planned_per_participant: "", n_enrolled: "20", n_completed: "", total_course_hours_delivered: "", n_enrolled_approx: false,
    n_completed_approx: false, total_course_hours_delivered_approx: false, completion_rule: "", extra: {},
  };
  const f: RegistryField = { field_key: "rac_eligible", label: "RAC eligible?", type: "boolean", options: null, required: true, ask_template: "For {program} at {facility}: RAC eligible?" };
  it("uses the ask template, and the old wording without one", () => {
    expect(cleanCycleRow(blank, [f]).issues.find((i) => i.field_name === "rac_eligible")?.message)
      .toBe("For Writing at San Quentin Rehabilitation Center: RAC eligible? Please reply YES or NO.");
    const { ask_template: _drop, ...bare } = f;
    expect(cleanCycleRow(blank, [bare]).issues.find((i) => i.field_name === "rac_eligible")?.message).toBe("RAC eligible? is needed for Writing.");
  });
  it("does not nag about an optional field (the form path)", () => {
    expect(cleanCycleRow(blank, [{ ...f, required: false }]).issues.some((i) => i.field_name === "rac_eligible")).toBe(false);
  });
});

describe("rowsFromMapping with a registry", () => {
  const grid = [
    ["Program", "Prison", "Start", "Enrolled", "RAC Eligible", "Grant year", "Participant Name", "Notes"],
    ["Writing", "San Quentin", "2026-01-05", "20", "Yes", "2026", "Jane Roe", "x"],
    ["Art", "CMF", "2026-02-02", "12", "", "2026", "John Doe", ""],
  ];
  const mapping: ColumnMapping = {
    persona: 1,
    columns: [
      { index: 0, target: "program_name" }, { index: 1, target: "facility_raw" }, { index: 2, target: "start_date" }, { index: 3, target: "n_enrolled" },
      { index: 4, target: "ignore" }, { index: 5, target: "ignore" }, { index: 6, target: "ignore" },
    ],
    unmapped_marks: [],
  };
  it("fills extra from a matching ignored column and reports only suggestable headers", () => {
    const r = rowsFromMapping(grid, 0, mapping, [{ field_key: "rac_eligible", label: "RAC eligible?" }]);
    expect(r.rows.map((x) => x.extra)).toEqual([{ rac_eligible: "Yes" }, {}]);
    // "Grant year" and "Notes" (not listed in the mapping) are suggestable; the name column never is.
    expect(r.unmatchedHeaders.map((h) => h.key)).toEqual(["grant_year", "notes"]);
    expect(JSON.stringify(r.unmatchedHeaders)).not.toMatch(/Jane|John|Name/);
  });
  it("without a registry nothing fills extra", () => {
    expect(rowsFromMapping(grid, findHeaderRow(grid), mapping).rows[0]!.extra).toEqual({});
  });
});
