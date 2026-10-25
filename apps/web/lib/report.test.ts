import { describe, expect, it } from "vitest";
import type { Dashboard } from "@tpw/shared";
import { buildReportContent } from "./report";

const base: Dashboard = {
  view: "public",
  participants: { value: null, isEstimate: false, suppressed: true },
  completion: { value: 0.8, numerator: 40, denominator: 50, isEstimate: false, suppressed: false },
  hours: { value: null, isEstimate: true, suppressed: true },
  prisons: { covered: 3, total: 31 },
  deserts: [{ facility_code: "A", facility_name: "A" }],
  facilities: [],
  cycles: [],
  hoursNote: { delivered: 1, planned: 2, unknown: 0 },
  cyclesExcludedFromCompletion: 0,
};

describe("buildReportContent", () => {
  it("prints suppressed metrics as the word suppressed, never a number", () => {
    const r = buildReportContent(base, "2026-10-24");
    expect(r.stats[0]).toMatchObject({ label: "Participants", value: "suppressed" });
    expect(r.stats[2]).toMatchObject({ label: "Participant-hours", value: "suppressed" });
  });

  it("shows the rate with numerator and denominator", () => {
    const c = buildReportContent(base, "2026-10-24").stats[1]!;
    expect(c.value).toBe("80%");
    expect(c.note).toContain("40 of 50");
  });

  it("carries the association caveat and the pending recidivism placeholder", () => {
    const r = buildReportContent(base, "2026-10-24");
    expect(r.footnotes.join(" ")).toContain("association, not cause");
    expect(r.recidivismContext).toContain("pending TPW confirmation");
  });

  it("refuses the staff view", () => {
    expect(() => buildReportContent({ ...base, view: "staff" }, "2026-10-24")).toThrow();
  });
});
