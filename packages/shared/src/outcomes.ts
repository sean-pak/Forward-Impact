import { z } from "zod";
import { daysBetween } from "./locator";
import { MetricSchema, guardRate, suppressed, type Metric, type View } from "./metrics";
import { fiscalYear } from "./people";
import { isCountSuppressed, isRateSuppressed } from "./suppress";

// Return-to-prison outcome metrics (schema v2 sections 3, 7.4, 7.5 and 8.2). Pure functions: the Worker loads rows,
// these count. Day 0 is the release date; the 1, 2 and 3 year windows are 365, 730 and 1,095 days.

export const YEARS = [1, 2, 3] as const;
export type Year = (typeof YEARS)[number];
export const WINDOW_DAYS: Record<Year, number> = { 1: 365, 2: 730, 3: 1095 };

/** Shown next to every outcome number that is not real CDCR data. */
export const SIMULATED_LABEL = "SIMULATED";

/** A release the Worker read from `release_events` (post-program releases only). */
export type ReleaseInput = {
  person_key: string;
  release_id: string;
  release_date: string;
  post_program: boolean | null;
  is_synthetic: boolean;
};

/** A first `return_to_prison` event from `outcome_events`. */
export type EventInput = { person_key: string; release_id: string; outcome_date: string; outcome_source: string };

/** What we know about how long a release has been watched. */
export type FollowUpInput = {
  person_key: string;
  release_id: string;
  /** From `follow_up_status.days_observed`, when a row exists. */
  days_observed: number | null;
  /** Date of the last custody check that found nobody by that person in custody. */
  last_negative_check: string | null;
};

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

export type CohortPerson = {
  person_key: string;
  release_id: string;
  release_date: string;
  fiscal_year: string;
  is_synthetic: boolean;
  /** Days from release to the first event, or null when there is none inside what we know. */
  event_days: number | null;
  event_source: string | null;
  /** Days followed, capped at 1,095 for people without an event. Always >= event_days when there is an event. */
  days_observed: number;
};

export type CohortBuild = { people: CohortPerson[]; flags: Record<string, number> };

/**
 * The cohort is each person's first post-program release that is on or before `asOf`. Events and follow-up attach by
 * release_id. Unverified name-only locator hits never count as events (schema 7.4). An event dated before the release or
 * after `asOf` is dropped and counted in `flags` so nothing is invented.
 */
export function buildCohort(
  releases: ReleaseInput[],
  events: EventInput[],
  followUps: FollowUpInput[],
  asOf: string,
): CohortBuild {
  const flags: Record<string, number> = {};
  const flag = (k: string) => (flags[k] = (flags[k] ?? 0) + 1);

  const first = new Map<string, ReleaseInput>();
  for (const r of releases) {
    if (r.post_program !== true) continue;
    if (!isDay(r.release_date)) { flag("bad_release_date"); continue; }
    if (r.release_date > asOf) continue; // a future release is not a release yet
    const cur = first.get(r.person_key);
    if (!cur || r.release_date < cur.release_date || (r.release_date === cur.release_date && r.release_id < cur.release_id)) {
      first.set(r.person_key, r);
    }
  }

  const eventBy = new Map<string, EventInput>();
  for (const e of events) {
    if (e.outcome_source === "eit_locator_unverified") { flag("unverified_event_excluded"); continue; }
    eventBy.set(`${e.person_key}|${e.release_id}`, e);
  }
  const followBy = new Map(followUps.map((f) => [`${f.person_key}|${f.release_id}`, f]));

  const people: CohortPerson[] = [];
  for (const r of first.values()) {
    const key = `${r.person_key}|${r.release_id}`;
    const sinceRelease = daysBetween(r.release_date, asOf);

    let eventDays: number | null = null;
    let eventSource: string | null = null;
    const e = eventBy.get(key);
    if (e) {
      const d = isDay(e.outcome_date) ? daysBetween(r.release_date, e.outcome_date) : NaN;
      if (Number.isNaN(d)) flag("bad_event_date");
      else if (d < 0) flag("event_before_release");
      else if (d > sinceRelease) flag("event_after_as_of");
      else { eventDays = d; eventSource = e.outcome_source; }
    }

    const f = followBy.get(key);
    const fromRow = f?.days_observed ?? 0;
    const fromCheck = f?.last_negative_check && isDay(f.last_negative_check) ? Math.max(0, daysBetween(r.release_date, f.last_negative_check)) : 0;
    // Nobody can be watched past today, and a person with an event was watched at least until it happened.
    let observed = Math.min(sinceRelease, Math.max(fromRow, fromCheck, eventDays ?? 0));
    if (eventDays === null || eventDays > WINDOW_DAYS[3]) observed = Math.min(observed, WINDOW_DAYS[3]);
    if (eventDays !== null && eventDays > WINDOW_DAYS[3]) flag("event_after_window");

    people.push({
      person_key: r.person_key,
      release_id: r.release_id,
      release_date: r.release_date,
      fiscal_year: fiscalYear(r.release_date),
      is_synthetic: r.is_synthetic,
      event_days: eventDays,
      event_source: eventSource,
      days_observed: observed,
    });
  }
  return { people, flags };
}

/** An event inside the Ny window. An event after day 1,095 is excluded (schema 3). */
const eventWithin = (p: CohortPerson, y: Year) => p.event_days !== null && p.event_days <= WINDOW_DAYS[y];
/** People with at least Ny of follow-up, or an earlier event: the denominator for that year's rate. */
const hasFollowUp = (p: CohortPerson, y: Year) => eventWithin(p, y) || p.days_observed >= WINDOW_DAYS[y];

export type KaplanMeier = { estimate: number; ci_low: number; ci_high: number; n: number } | null;

/**
 * Cumulative incidence at day 1,095 with censoring (Kaplan-Meier), and a 95% interval from Greenwood's variance.
 * Ties: events come before censoring. Returns null when nobody has any follow-up.
 */
export function kaplanMeier(people: Pick<CohortPerson, "event_days" | "days_observed">[]): KaplanMeier {
  const cap = WINDOW_DAYS[3];
  const obs = people.map((p) =>
    p.event_days !== null && p.event_days <= cap
      ? { t: p.event_days, event: true }
      : { t: Math.min(p.days_observed, cap), event: false },
  );
  if (obs.length === 0 || obs.every((o) => o.t === 0 && !o.event)) return null;
  const times = [...new Set(obs.filter((o) => o.event).map((o) => o.t))].sort((a, b) => a - b);
  let surv = 1;
  let greenwood = 0;
  for (const t of times) {
    const atRisk = obs.filter((o) => o.t >= t).length;
    const d = obs.filter((o) => o.event && o.t === t).length;
    surv *= 1 - d / atRisk;
    greenwood += atRisk > d ? d / (atRisk * (atRisk - d)) : 0;
  }
  const se = surv * Math.sqrt(greenwood);
  const clip = (x: number) => Math.min(1, Math.max(0, x));
  return { estimate: 1 - surv, ci_low: clip(1 - surv - 1.96 * se), ci_high: clip(1 - surv + 1.96 * se), n: obs.length };
}

export type CohortCounts = {
  fiscal_year: string;
  n_released: number;
  n_with: Record<Year, number>;
  n_event: Record<Year, number>;
  km: KaplanMeier;
  follow_up_complete: boolean;
  /** Share of events by source; empty when the cohort has no events. */
  source_mix: Record<string, number>;
  /** True when any person or event is synthetic or comes from the mock locator. */
  simulated: boolean;
  flags: string[];
};

/** Sources that are not real custody data. */
export const SIMULATED_SOURCES = new Set(["simulated", "mock_locator"]);

/** One entry per release fiscal year, oldest first. Fiscal years are never pooled (schema 8.2). */
export function countCohorts(people: CohortPerson[]): CohortCounts[] {
  const byFy = new Map<string, CohortPerson[]>();
  for (const p of people) byFy.set(p.fiscal_year, [...(byFy.get(p.fiscal_year) ?? []), p]);
  return [...byFy.keys()].sort().map((fy) => {
    const group = byFy.get(fy)!;
    const n_with = {} as Record<Year, number>;
    const n_event = {} as Record<Year, number>;
    for (const y of YEARS) {
      n_with[y] = group.filter((p) => hasFollowUp(p, y)).length;
      n_event[y] = group.filter((p) => eventWithin(p, y)).length;
    }
    const events = group.filter((p) => p.event_days !== null && p.event_source);
    const source_mix: Record<string, number> = {};
    for (const p of events) source_mix[p.event_source!] = (source_mix[p.event_source!] ?? 0) + 1 / events.length;
    const flags: string[] = [];
    if (group.length < 30) flags.push("small_cohort");
    const complete = group.every((p) => hasFollowUp(p, 3));
    if (!complete) flags.push("interim_rates");
    return {
      fiscal_year: fy,
      n_released: group.length,
      n_with,
      n_event,
      km: kaplanMeier(group),
      follow_up_complete: complete,
      source_mix,
      simulated: group.some((p) => p.is_synthetic) || events.some((p) => SIMULATED_SOURCES.has(p.event_source!)),
      flags,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// What leaves the Worker

export const OutcomeRowSchema = z.object({
  fiscal_year: z.string(),
  /** People in the cohort. Hidden in the public view when the cohort is under 30. */
  n_released: MetricSchema,
  /** Per year: value = rate, numerator = events, denominator = n_with_Ny. */
  rate_1yr: MetricSchema,
  rate_2yr: MetricSchema,
  rate_3yr: MetricSchema,
  /** Projected 3-year rate with censoring. denominator = people in the cohort; there is no simple numerator. */
  km_3yr: MetricSchema,
  km_3yr_ci: z.object({ low: z.number().nullable(), high: z.number().nullable() }),
  follow_up_complete: z.boolean(),
  /** Share of events by source, for example `{ simulated: 1 }`. Empty when suppressed. */
  source_mix: z.record(z.string(), z.number()),
  /** Names of the sources behind the numbers, readable, e.g. "SIMULATED". Always present. */
  source_labels: z.array(z.string()),
  simulated: z.boolean(),
  flags: z.array(z.string()),
  suppressed: z.boolean(),
});
export type OutcomeRow = z.infer<typeof OutcomeRowSchema>;

export const BenchmarkLineSchema = z.object({
  outcome: z.string(),
  cohort_fy: z.string(),
  source: z.string(),
  rate: z.number(),
  numerator: z.number().nullable(),
  denominator: z.number().nullable(),
  note: z.string(),
});
export type BenchmarkLine = z.infer<typeof BenchmarkLineSchema>;

export const OutcomePanelSchema = z.object({
  view: z.enum(["staff", "public"]),
  as_of: z.string(),
  outcome: z.literal("return_to_prison"),
  rows: z.array(OutcomeRowSchema),
  benchmark: BenchmarkLineSchema.nullable(),
  /** Cohort-wide notes: events dropped and why. Counts only. */
  flags: z.record(z.string(), z.number()),
});
export type OutcomePanel = z.infer<typeof OutcomePanelSchema>;

/** Readable name for an `outcome_source`. Anything that is not real data says SIMULATED. */
export function sourceLabel(source: string): string {
  switch (source) {
    case "simulated": return SIMULATED_LABEL;
    case "mock_locator": return `${SIMULATED_LABEL} (mock locator)`;
    case "eit_locator_verified": return "EIT locator, verified by TPW";
    case "eit_locator_unverified": return "EIT locator, unverified";
    case "cdcr_file": return "CDCR file";
    case "doj_file": return "DOJ file";
    case "self_report": return "self-reported";
    default: return source;
  }
}

const open = (value: number | null, numerator: number, denominator: number): Metric =>
  denominator === 0
    ? { value: null, numerator, denominator, isEstimate: false, suppressed: false }
    : { value, numerator, denominator, isEstimate: false, suppressed: false };

/**
 * Turns counts into a row. The public view hides: the whole row when the cohort is under 30, a year whose denominator is
 * under 30, and any year with 1 to 10 events (a rate times its denominator would reveal the count). Hidden metrics carry
 * no numbers. The staff view is unsuppressed, like the rest of the dashboard.
 */
export function toOutcomeRow(c: CohortCounts, view: View): OutcomeRow {
  const pub = view === "public";
  const rowHidden = pub && isRateSuppressed(c.n_released);
  const rate = (y: Year): Metric => {
    const m = open(c.n_with[y] > 0 ? c.n_event[y] / c.n_with[y] : null, c.n_event[y], c.n_with[y]);
    if (rowHidden) return suppressed();
    if (!pub) return m;
    return isCountSuppressed(c.n_event[y]) ? suppressed() : guardRate(m);
  };
  const kmHidden = rowHidden || (pub && (c.km === null || isRateSuppressed(c.n_released) || isCountSuppressed(c.n_event[3])));
  const km: Metric = kmHidden
    ? suppressed(true)
    : { value: c.km?.estimate ?? null, denominator: c.n_released, isEstimate: true, suppressed: false };
  const sources = Object.keys(c.source_mix);
  const labels = sources.length > 0 ? sources.map(sourceLabel) : c.simulated ? [SIMULATED_LABEL] : [];
  return {
    fiscal_year: c.fiscal_year,
    n_released: rowHidden ? suppressed() : { value: c.n_released, isEstimate: false, suppressed: false },
    rate_1yr: rate(1),
    rate_2yr: rate(2),
    rate_3yr: rate(3),
    km_3yr: km,
    km_3yr_ci: kmHidden ? { low: null, high: null } : { low: c.km?.ci_low ?? null, high: c.km?.ci_high ?? null },
    follow_up_complete: c.follow_up_complete,
    source_mix: rowHidden ? {} : c.source_mix,
    source_labels: [...new Set(labels)],
    simulated: c.simulated,
    flags: c.flags,
    suppressed: rowHidden,
  };
}

export type BenchmarkRow = {
  source: string;
  cohort_fy: string;
  outcome_type: string;
  stratum_field: string;
  stratum_value: string;
  numerator: number | null;
  denominator: number | null;
  rate: number;
  period_note: string | null;
};

/** The CDCR all-releases return-to-prison rate, with outcome, cohort year and source named. Null when the table has none. */
export function benchmarkLine(rows: BenchmarkRow[]): BenchmarkLine | null {
  const r = rows.find((b) => b.outcome_type === "return_to_prison" && b.stratum_field === "all" && b.stratum_value === "all");
  if (!r) return null;
  return {
    outcome: "3-year return to prison",
    cohort_fy: r.cohort_fy,
    source: r.source,
    rate: r.rate,
    numerator: r.numerator,
    denominator: r.denominator,
    note: r.period_note ?? "",
  };
}

export function buildOutcomePanel(
  cohort: CohortBuild,
  benchmarks: BenchmarkRow[],
  view: View,
  asOf: string,
): OutcomePanel {
  return {
    view,
    as_of: asOf,
    outcome: "return_to_prison",
    rows: countCohorts(cohort.people).map((c) => toOutcomeRow(c, view)),
    benchmark: benchmarkLine(benchmarks),
    flags: cohort.flags,
  };
}
