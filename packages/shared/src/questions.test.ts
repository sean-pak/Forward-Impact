import { describe, expect, it } from "vitest";
import { isPlainYes, pickQuestion, rank, type Candidate } from "./questions";

const base = { cycle_id: "c1", program_id: "p1", program_name: "Writing Class", facility_name: "California Men's Colony", start_date: "2025-02-03" };
const issue = (field_name: string, issue_type: Candidate["issue_type"], over: Partial<Candidate> = {}): Candidate =>
  ({ ...base, kind: "issue", field_name, issue_type, message: `Q about ${field_name}`, ...over });
const approx = (field_name: string, over: Partial<Candidate> = {}): Candidate =>
  ({ ...base, kind: "approx", field_name, issue_type: null, message: "30", ...over });

describe("pickQuestion (PRD 7.7 order)", () => {
  it("returns null when nothing is open", () => expect(pickQuestion([])).toBeNull());

  it("ranks required core > conflict > ambiguous > approximate > other required > registry", () => {
    const order = [
      issue("n_enrolled", "missing_required"),
      issue("n_completed", "out_of_range"),
      issue("facility_code", "ambiguous_mapping"),
      approx("n_enrolled"),
      issue("completion_rule", "missing_required"),
      issue("funding_source", "missing_required"),
    ];
    expect(order.map(rank)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pickQuestion([...order].reverse())!.field_name).toBe("n_enrolled");
    expect(pickQuestion(order.slice(1))!.field_name).toBe("n_completed");
    expect(pickQuestion(order.slice(2))!.field_name).toBe("facility_code");
    expect(pickQuestion(order.slice(3))!.kind).toBe("approx");
    expect(pickQuestion(order.slice(4))!.field_name).toBe("completion_rule");
    expect(pickQuestion(order.slice(5))!.field_name).toBe("funding_source");
  });

  it("asks one question: a completion rule covers every cycle of the program, other fields only their cycle", () => {
    const q = pickQuestion([
      issue("completion_rule", "missing_required", { cycle_id: "c1" }),
      issue("completion_rule", "missing_required", { cycle_id: "c2" }),
      issue("completion_rule", "missing_required", { cycle_id: "c3", program_id: "p2", program_name: "Zine Club" }),
    ])!;
    expect(q.cycle_ids).toEqual(["c1", "c2"]);
    expect(q.text).toContain("What counts as completing Writing Class?");
    const c = pickQuestion([issue("n_completed", "missing_required", { cycle_id: "c1" }), issue("n_completed", "missing_required", { cycle_id: "c2" })])!;
    expect(c.cycle_ids).toEqual(["c1"]);
  });

  it("names the run in the question so two cycles of one program are not confused", () => {
    expect(pickQuestion([issue("n_completed", "missing_required")])!.text).toContain("(This is about Writing Class at California Men's Colony, started 2025-02-03.)");
  });

  it("an approximate question shows the number given and offers the keep-as-is reply", () => {
    const t = pickQuestion([approx("n_enrolled")])!.text;
    expect(t).toContain('"about 30"');
    expect(t).toContain("people enrolled");
    expect(t).toContain('"about 30 is fine"');
  });
});

describe("isPlainYes", () => {
  it.each(["yes", "Yes.", "YES!", " yep ", "Looks good", "confirmed", "ok"])("accepts %s", (t) => expect(isPlainYes(t)).toBe(true));
  it.each(["yes but SQ was 29", "no", "yes, and fix the date", "", "not yet"])("sends %j to the classifier", (t) => expect(isPlainYes(t)).toBe(false));
});
