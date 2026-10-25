import { describe, expect, it } from "vitest";
import { grantText } from "./orgReport";
import type { CycleRow } from "./summary";

function cycle(over: Partial<CycleRow> = {}): CycleRow {
  return {
    cycle_id: "c1", org_id: "o1", org_name: "Org", program_name: "Writing", completion_rule: "attended 80% of sessions",
    facility_code: "SQ", facility_name: "San Quentin", start_date: "2025-01-06", end_date: "2025-03-28",
    course_hours_planned_per_participant: null, n_enrolled: 40, n_completed: 30, total_course_hours_delivered: 600,
    n_enrolled_approx: 0, n_completed_approx: 0, total_course_hours_delivered_approx: 0,
    ...over,
  };
}

describe("grantText", () => {
  it("returns null with no confirmed cycles", () => {
    expect(grantText("Org", [])).toBeNull();
  });

  it("states counts with numerator and denominator", () => {
    const t = grantText("Dana Arts", [
      cycle(),
      cycle({ cycle_id: "c2", program_name: "Healing Circle", facility_code: "CMC", facility_name: "California Men's Colony", start_date: "2025-09-08", end_date: null, n_enrolled: 20, n_completed: 15, total_course_hours_delivered: 300 }),
    ]);
    expect(t).toBe(
      "Between 2025-01-06 and 2025-09-08, Dana Arts ran 2 classes across 2 programs at 2 California prisons (California Men's Colony, San Quentin). " +
        "60 people enrolled. Of the 60 enrolled in classes with a stated completion standard, 45 completed (75%). " +
        "Participants received 900 hours of programming in total. These figures were reported and confirmed by Dana Arts.",
    );
  });

  it("leaves out what is unknown instead of guessing", () => {
    const t = grantText("Org", [cycle({ completion_rule: "unstated", total_course_hours_delivered: null, start_date: null, end_date: null, facility_code: null, facility_name: null })])!;
    expect(t).toBe("Org ran 1 class across 1 program. 40 people enrolled. These figures were reported and confirmed by Org.");
  });

  it("says about for approximate inputs", () => {
    const t = grantText("Org", [cycle({ n_enrolled: 30, n_enrolled_approx: 1 })])!;
    expect(t).toContain("About 30 people enrolled.");
    expect(t).toContain("30 completed (about 100%)");
  });
});
