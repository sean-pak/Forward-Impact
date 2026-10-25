import { describe, expect, it } from "vitest";
import { daysBetween } from "./locator";
import {
  benchmarkLine,
  buildCohort,
  buildOutcomePanel,
  countCohorts,
  kaplanMeier,
  sourceLabel,
  toOutcomeRow,
  type EventInput,
  type FollowUpInput,
  type ReleaseInput,
} from "./outcomes";

const AS_OF = "2026-10-24";

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

type Spec = { n: number; release: string; eventAt?: number; source?: string; observed?: number; synthetic?: boolean; post?: boolean };

/** Builds releases, events and follow-up rows for groups of people. Person keys are p0, p1, ... */
function world(specs: Spec[]) {
  const releases: ReleaseInput[] = [];
  const events: EventInput[] = [];
  const followUps: FollowUpInput[] = [];
  let i = 0;
  for (const s of specs) {
    for (let k = 0; k < s.n; k++, i++) {
      releases.push({ person_key: `p${i}`, release_id: `r${i}`, release_date: s.release, post_program: s.post ?? true, is_synthetic: s.synthetic ?? true });
      if (s.eventAt !== undefined) {
        events.push({ person_key: `p${i}`, release_id: `r${i}`, outcome_date: addDays(s.release, s.eventAt), outcome_source: s.source ?? "simulated" });
      }
      if (s.observed !== undefined) followUps.push({ person_key: `p${i}`, release_id: `r${i}`, days_observed: s.observed, last_negative_check: null });
    }
  }
  return { releases, events, followUps };
}

const counts = (w: ReturnType<typeof world>, asOf = AS_OF) => countCohorts(buildCohort(w.releases, w.events, w.followUps, asOf).people);

describe("daysBetween", () => {
  it("counts whole days, across a leap day too", () => {
    expect(daysBetween("2024-01-01", "2024-01-02")).toBe(1);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
    expect(daysBetween("2022-01-01", "2025-01-01")).toBe(1096);
    expect(daysBetween("2025-01-02", "2025-01-01")).toBe(-1);
  });
});

describe("cohort counts for a finished cohort", () => {
  // 40 people released 2022-01-01 (FY2021_22): more than 3 years of follow-up for everyone.
  const w = world([
    { n: 10, release: "2022-01-01", eventAt: 100 },
    { n: 4, release: "2022-01-01", eventAt: 500 },
    { n: 2, release: "2022-01-01", eventAt: 900 },
    { n: 1, release: "2022-01-01", eventAt: 1200 }, // after day 1,095: excluded and flagged
    { n: 23, release: "2022-01-01", observed: 1095 },
  ]);
  const built = buildCohort(w.releases, w.events, w.followUps, AS_OF);
  const [fy] = countCohorts(built.people);

  it("counts cumulative first events and gives every year the full denominator", () => {
    expect(fy).toMatchObject({ fiscal_year: "FY2021_22", n_released: 40, follow_up_complete: true });
    expect(fy!.n_with).toEqual({ 1: 40, 2: 40, 3: 40 });
    expect(fy!.n_event).toEqual({ 1: 10, 2: 14, 3: 16 });
  });

  it("excludes an event after day 1,095 and flags it", () => {
    expect(built.flags.event_after_window).toBe(1);
  });

  it("shows rates with numerator and denominator in the staff view", () => {
    const row = toOutcomeRow(fy!, "staff");
    expect(row.rate_1yr).toMatchObject({ value: 0.25, numerator: 10, denominator: 40, suppressed: false });
    expect(row.rate_2yr).toMatchObject({ value: 0.35, numerator: 14, denominator: 40 });
    expect(row.rate_3yr).toMatchObject({ value: 0.4, numerator: 16, denominator: 40 });
  });
});

describe("interim cohorts", () => {
  // Released 2025-10-24: exactly 365 days before AS_OF.
  const w = world([
    { n: 3, release: "2025-10-24", eventAt: 100 },
    { n: 27, release: "2025-10-24", observed: 5000 }, // follow-up can never run past today
  ]);
  const [fy] = counts(w);

  it("uses n_with_Ny, not one denominator, for each year", () => {
    expect(fy!.n_released).toBe(30);
    expect(fy!.n_with).toEqual({ 1: 30, 2: 3, 3: 3 });
    expect(fy!.n_event).toEqual({ 1: 3, 2: 3, 3: 3 });
    expect(fy!.follow_up_complete).toBe(false);
    expect(fy!.flags).toContain("interim_rates");
  });

  it("builds follow-up from the last negative check when no follow-up row exists", () => {
    const releases: ReleaseInput[] = [{ person_key: "a", release_id: "ra", release_date: "2025-01-01", post_program: true, is_synthetic: true }];
    const f: FollowUpInput[] = [{ person_key: "a", release_id: "ra", days_observed: null, last_negative_check: "2026-01-01" }];
    const [p] = buildCohort(releases, [], f, AS_OF).people;
    expect(p!.days_observed).toBe(365);
  });

  it("treats a person with no follow-up at all as unobserved, not as a success", () => {
    const [p] = buildCohort(
      [{ person_key: "a", release_id: "ra", release_date: "2024-01-01", post_program: true, is_synthetic: true }],
      [], [], AS_OF,
    ).people;
    expect(p!.days_observed).toBe(0);
    const [c] = countCohorts([p!]);
    expect(c!.n_with).toEqual({ 1: 0, 2: 0, 3: 0 });
    expect(toOutcomeRow(c!, "staff").rate_1yr).toMatchObject({ value: null, numerator: 0, denominator: 0 });
  });
});

describe("who is in the cohort", () => {
  it("takes each person's first post-program release only", () => {
    const releases: ReleaseInput[] = [
      { person_key: "a", release_id: "late", release_date: "2024-05-01", post_program: true, is_synthetic: true },
      { person_key: "a", release_id: "early", release_date: "2022-05-01", post_program: true, is_synthetic: true },
    ];
    const { people } = buildCohort(releases, [], [], AS_OF);
    expect(people.map((p) => p.release_id)).toEqual(["early"]);
  });

  it("leaves out releases before the program, with unknown timing, or in the future", () => {
    const releases: ReleaseInput[] = [
      { person_key: "a", release_id: "r1", release_date: "2022-05-01", post_program: false, is_synthetic: true },
      { person_key: "b", release_id: "r2", release_date: "2022-05-01", post_program: null, is_synthetic: true },
      { person_key: "c", release_id: "r3", release_date: "2027-05-01", post_program: true, is_synthetic: true },
      { person_key: "d", release_id: "r4", release_date: "2022-05-01", post_program: true, is_synthetic: true },
    ];
    expect(buildCohort(releases, [], [], AS_OF).people.map((p) => p.person_key)).toEqual(["d"]);
  });

  it("keeps an event only for the cohort release, and drops events dated before the release or after today", () => {
    const releases: ReleaseInput[] = [
      { person_key: "a", release_id: "ra", release_date: "2022-05-01", post_program: true, is_synthetic: true },
      { person_key: "b", release_id: "rb", release_date: "2022-05-01", post_program: true, is_synthetic: true },
      { person_key: "c", release_id: "rc", release_date: "2022-05-01", post_program: true, is_synthetic: true },
    ];
    const events: EventInput[] = [
      { person_key: "a", release_id: "other", outcome_date: "2022-06-01", outcome_source: "simulated" },
      { person_key: "b", release_id: "rb", outcome_date: "2022-04-01", outcome_source: "simulated" },
      { person_key: "c", release_id: "rc", outcome_date: "2027-01-01", outcome_source: "simulated" },
    ];
    const { people, flags } = buildCohort(releases, events, [], AS_OF);
    expect(people.every((p) => p.event_days === null)).toBe(true);
    expect(flags).toMatchObject({ event_before_release: 1, event_after_as_of: 1 });
  });

  it("never counts an unverified name-only locator hit", () => {
    const w = world([{ n: 1, release: "2022-05-01", eventAt: 50, source: "eit_locator_unverified", observed: 1095 }]);
    const built = buildCohort(w.releases, w.events, w.followUps, AS_OF);
    expect(built.people[0]!.event_days).toBeNull();
    expect(built.flags.unverified_event_excluded).toBe(1);
  });

  it("keeps fiscal years separate, oldest first (fiscal year starts July 1)", () => {
    const w = world([
      { n: 2, release: "2023-06-30", observed: 1095 },
      { n: 3, release: "2023-07-01", observed: 1095 },
      { n: 1, release: "2021-08-01", observed: 1095 },
    ]);
    expect(counts(w).map((c) => [c.fiscal_year, c.n_released])).toEqual([["FY2021_22", 1], ["FY2022_23", 2], ["FY2023_24", 3]]);
  });
});

describe("Kaplan-Meier", () => {
  it("with no censoring equals events over people", () => {
    const people = [
      { event_days: 100, days_observed: 100 },
      { event_days: 200, days_observed: 200 },
      ...Array.from({ length: 8 }, () => ({ event_days: null, days_observed: 1095 })),
    ];
    expect(kaplanMeier(people)!.estimate).toBeCloseTo(0.2, 10);
  });

  it("removes people who leave follow-up early from the risk set", () => {
    const people = [
      { event_days: 100, days_observed: 100 },
      { event_days: null, days_observed: 50 },
      { event_days: null, days_observed: 50 },
      { event_days: null, days_observed: 1095 },
      { event_days: null, days_observed: 1095 },
    ];
    // at day 100 three people remain at risk: 1 event of 3
    expect(kaplanMeier(people)!.estimate).toBeCloseTo(1 / 3, 10);
  });

  it("ignores an event after day 1,095 and gives a bounded interval", () => {
    const km = kaplanMeier([
      { event_days: 1200, days_observed: 1095 },
      { event_days: 10, days_observed: 10 },
      { event_days: null, days_observed: 1095 },
      { event_days: null, days_observed: 1095 },
    ])!;
    expect(km.estimate).toBeCloseTo(0.25, 10);
    expect(km.ci_low).toBeGreaterThanOrEqual(0);
    expect(km.ci_high).toBeLessThanOrEqual(1);
    expect(km.ci_low).toBeLessThanOrEqual(km.estimate);
    expect(km.ci_high).toBeGreaterThanOrEqual(km.estimate);
  });

  it("is null when nobody has been followed", () => {
    expect(kaplanMeier([{ event_days: null, days_observed: 0 }])).toBeNull();
    expect(kaplanMeier([])).toBeNull();
  });
});

describe("suppression", () => {
  const big = (events: number) => world([
    { n: events, release: "2022-01-01", eventAt: 100 },
    { n: 40 - events, release: "2022-01-01", observed: 1095 },
  ]);

  it("hides the whole public row when the cohort is under 30, with no numbers", () => {
    const [c] = counts(world([{ n: 29, release: "2022-01-01", eventAt: 100 }]));
    const row = toOutcomeRow(c!, "public");
    expect(row.suppressed).toBe(true);
    for (const m of [row.n_released, row.rate_1yr, row.rate_2yr, row.rate_3yr, row.km_3yr]) {
      expect(m).toMatchObject({ suppressed: true, value: null });
      expect(m.numerator).toBeUndefined();
      expect(m.denominator).toBeUndefined();
    }
    expect(row.source_mix).toEqual({});
    expect(row.km_3yr_ci).toEqual({ low: null, high: null });
    // staff still see it, flagged as small
    expect(toOutcomeRow(c!, "staff").rate_1yr).toMatchObject({ suppressed: false, numerator: 29, denominator: 29 });
    expect(c!.flags).toContain("small_cohort");
  });

  it("hides a year with 1 to 10 events in the public view, but shows 0 and 11+", () => {
    const [c5] = counts(big(5));
    expect(toOutcomeRow(c5!, "public").rate_1yr.suppressed).toBe(true);
    const [c0] = counts(big(0));
    expect(toOutcomeRow(c0!, "public").rate_1yr).toMatchObject({ suppressed: false, value: 0, numerator: 0, denominator: 40 });
    const [c11] = counts(big(11));
    expect(toOutcomeRow(c11!, "public").rate_1yr).toMatchObject({ suppressed: false, numerator: 11, denominator: 40 });
  });

  it("hides a year whose denominator is under 30 even when the cohort is large enough", () => {
    // 30 released a year ago; only the 12 with an event count in years 2 and 3 (12 events is not a hidden count)
    const [c] = counts(world([{ n: 12, release: "2025-10-24", eventAt: 100 }, { n: 18, release: "2025-10-24", observed: 365 }]));
    const row = toOutcomeRow(c!, "public");
    expect(row.suppressed).toBe(false);
    expect(row.rate_1yr).toMatchObject({ suppressed: false, numerator: 12, denominator: 30 });
    expect(row.rate_2yr.suppressed).toBe(true);
    expect(row.rate_3yr.suppressed).toBe(true);
  });
});

describe("source labels", () => {
  it("labels simulated and mock-locator events SIMULATED, with the source mix", () => {
    const [c] = counts(world([
      { n: 20, release: "2022-01-01", eventAt: 100, source: "simulated" },
      { n: 10, release: "2022-01-01", eventAt: 200, source: "mock_locator" },
      { n: 10, release: "2022-01-01", observed: 1095 },
    ]));
    expect(c!.simulated).toBe(true);
    expect(c!.source_mix.simulated).toBeCloseTo(2 / 3, 10);
    expect(c!.source_mix.mock_locator).toBeCloseTo(1 / 3, 10);
    const row = toOutcomeRow(c!, "staff");
    expect(row.source_labels).toEqual(["SIMULATED", "SIMULATED (mock locator)"]);
  });

  it("says SIMULATED for a synthetic cohort even when it has no events yet", () => {
    const [c] = counts(world([{ n: 31, release: "2022-01-01", observed: 1095 }]));
    expect(toOutcomeRow(c!, "staff").source_labels).toEqual(["SIMULATED"]);
  });

  it("does not call real data simulated", () => {
    const [c] = counts(world([{ n: 31, release: "2022-01-01", eventAt: 90, source: "eit_locator_verified", synthetic: false }]));
    expect(c!.simulated).toBe(false);
    expect(toOutcomeRow(c!, "staff").source_labels).toEqual(["EIT locator, verified by TPW"]);
    expect(sourceLabel("cdcr_file")).toBe("CDCR file");
  });
});

describe("benchmark line and panel", () => {
  const rows = [
    { source: "CDCR Statewide Recidivism Report FY 2020-21", cohort_fy: "FY2020_21", outcome_type: "conviction", stratum_field: "all", stratum_value: "all", numerator: 11886, denominator: 30116, rate: 0.395, period_note: null },
    { source: "CDCR Statewide Recidivism Report FY 2020-21", cohort_fy: "FY2020_21", outcome_type: "return_to_prison", stratum_field: "all", stratum_value: "all", numerator: 6249, denominator: 30655, rate: 0.204, period_note: "COVID" },
  ];

  it("names the return-to-prison outcome, the cohort year and the source, not the conviction rate", () => {
    expect(benchmarkLine(rows)).toMatchObject({ outcome: "3-year return to prison", cohort_fy: "FY2020_21", rate: 0.204, numerator: 6249, denominator: 30655 });
    expect(benchmarkLine(rows)!.source).toContain("CDCR");
    expect(benchmarkLine([rows[0]!])).toBeNull();
  });

  it("builds a public panel with the as-of date and dropped-event counts", () => {
    const w = world([{ n: 40, release: "2022-01-01", eventAt: 100, source: "simulated" }]);
    const panel = buildOutcomePanel(buildCohort(w.releases, w.events, w.followUps, AS_OF), rows, "public", AS_OF);
    expect(panel).toMatchObject({ view: "public", as_of: AS_OF, outcome: "return_to_prison" });
    expect(panel.rows).toHaveLength(1);
    expect(panel.rows[0]!.rate_1yr).toMatchObject({ suppressed: false, numerator: 40, denominator: 40 });
  });
});
