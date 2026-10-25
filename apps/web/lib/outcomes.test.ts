import { describe, expect, it } from "vitest";
import type { Dashboard, Metric, OutcomePanel, OutcomeRow } from "@tpw/shared";
import { benchmarkText, outcomeTable, showOutcomeRate, simulatedBanner } from "./outcomes";
import { buildReportContent } from "./report";

const open = (value: number | null, numerator: number, denominator: number): Metric => ({ value, numerator, denominator, isEstimate: false, suppressed: false });
const hidden: Metric = { value: null, isEstimate: false, suppressed: true };

const row = (over: Partial<OutcomeRow> = {}): OutcomeRow => ({
  fiscal_year: "FY2021_22",
  n_released: { value: 40, isEstimate: false, suppressed: false },
  rate_1yr: open(0.25, 10, 40),
  rate_2yr: open(0.35, 14, 40),
  rate_3yr: open(0.4, 16, 40),
  km_3yr: { value: 0.41, denominator: 40, isEstimate: true, suppressed: false },
  km_3yr_ci: { low: 0.26, high: 0.56 },
  follow_up_complete: true,
  source_mix: { simulated: 1 },
  source_labels: ["SIMULATED"],
  simulated: true,
  flags: [],
  suppressed: false,
  ...over,
});

const panel = (rows: OutcomeRow[], view: "staff" | "public" = "public"): OutcomePanel => ({
  view, as_of: "2026-10-24", outcome: "return_to_prison", rows, flags: {},
  benchmark: { outcome: "3-year return to prison", cohort_fy: "FY2020_21", source: "CDCR Statewide Recidivism Report FY 2020-21", rate: 0.204, numerator: 6249, denominator: 30655, note: "" },
});

const dash: Dashboard = {
  view: "public",
  participants: { value: 100, isEstimate: false, suppressed: false },
  completion: { value: 0.8, numerator: 40, denominator: 50, isEstimate: false, suppressed: false },
  hours: { value: 500, isEstimate: false, suppressed: false },
  prisons: { covered: 3, total: 31 }, deserts: [], facilities: [], cycles: [],
  hoursNote: { delivered: 1, planned: 0, unknown: 0 }, cyclesExcludedFromCompletion: 0,
};

describe("outcome text", () => {
  it("prints a rate with its numerator and denominator", () => {
    expect(showOutcomeRate(open(0.25, 10, 40))).toBe("25% (10 of 40)");
    expect(showOutcomeRate(open(null, 0, 0))).toBe("n/a (0 of 0)");
  });

  it("prints the word suppressed, never a number", () => {
    expect(showOutcomeRate(hidden)).toBe("suppressed");
    const t = outcomeTable(panel([row({ suppressed: true, n_released: hidden, rate_1yr: hidden, rate_2yr: hidden, rate_3yr: hidden, km_3yr: hidden, km_3yr_ci: { low: null, high: null }, source_mix: {} })]))[0]!;
    expect([t.released, t.y1, t.y2, t.y3, t.projected]).toEqual(Array(5).fill("suppressed"));
    expect(t.source).toBe("SIMULATED"); // the source stays visible even when the numbers do not
  });

  it("labels every row with its source and marks interim follow-up", () => {
    const t = outcomeTable(panel([row({ follow_up_complete: false }), row({ fiscal_year: "FY2022_23", source_labels: ["EIT locator, verified by TPW"], simulated: false })]));
    expect(t.map((r) => r.source)).toEqual(["SIMULATED", "EIT locator, verified by TPW"]);
    expect(t[0]!.followUp).toBe("interim");
    expect(t[0]!.projected).toBe("41% projected, 95% CI 26% to 56%, of 40 people");
  });

  it("shows the SIMULATED banner whenever any row is simulated, and none for real data only", () => {
    expect(simulatedBanner(panel([row()]))).toMatch(/^SIMULATED/);
    expect(simulatedBanner(panel([row(), row({ simulated: false })]))).toMatch(/^SIMULATED rows are marked/);
    expect(simulatedBanner(panel([row({ simulated: false })]))).toBeNull();
  });

  it("names outcome, cohort year and source in the benchmark line", () => {
    const t = benchmarkText(panel([row()]));
    expect(t).toContain("3-year return to prison");
    expect(t).toContain("FY2020-21");
    expect(t).toContain("20.4% (6,249 of 30,655)");
    expect(t).toContain("CDCR Statewide Recidivism Report");
  });
});

describe("one-pager outcome toggle", () => {
  it("is off by default: no outcomes section, the placeholder stays", () => {
    const r = buildReportContent(dash, "2026-10-24");
    expect(r.outcomes).toBeNull();
    expect(r.recidivismContext).toContain("pending TPW confirmation");
  });

  it("when on, carries the banner, per-row sources and the benchmark", () => {
    const r = buildReportContent(dash, "2026-10-24", panel([row()]));
    expect(r.outcomes!.banner).toMatch(/^SIMULATED/);
    expect(r.outcomes!.rows[0]!.source).toBe("SIMULATED");
    expect(r.outcomes!.benchmark).toContain("20.4%");
    expect(r.outcomes!.notes.join(" ")).toContain("Association, not cause");
  });

  it("refuses a staff outcome panel", () => {
    expect(() => buildReportContent(dash, "2026-10-24", panel([row()], "staff"))).toThrow();
  });
});
