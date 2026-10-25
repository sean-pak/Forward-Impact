import { z } from "zod";
import {
  completionRate,
  CycleRowSchema,
  sumParticipants,
  totalHours,
  type CycleRow,
} from "./summary";
import { isCountSuppressed, isFacilitySuppressed, isRateSuppressed } from "./suppress";

/** Staff see everything; public hides small cells and per-cycle detail. */
export type View = "staff" | "public";

export const MetricSchema = z.object({
  value: z.number().nullable(),
  numerator: z.number().optional(),
  denominator: z.number().optional(),
  isEstimate: z.boolean(),
  suppressed: z.boolean(),
});
export type Metric = z.infer<typeof MetricSchema>;

/** Replaces a metric with a suppressed one. Numbers are dropped so they never leave the Worker. */
export function suppressed(isEstimate = false): Metric {
  return { value: null, isEstimate, suppressed: true };
}

const open = (m: Omit<Metric, "suppressed">): Metric => ({ ...m, suppressed: false });

export function participantsMetric(cycles: CycleRow[]): Metric {
  const p = sumParticipants(cycles);
  return open({ value: p.value, isEstimate: p.isEstimate });
}

export function completionMetric(cycles: CycleRow[]): Metric {
  const r = completionRate(cycles);
  return open({ value: r.value, numerator: r.numerator, denominator: r.denominator, isEstimate: r.isEstimate });
}

export function hoursMetric(cycles: CycleRow[]): Metric {
  const h = totalHours(cycles);
  return open({ value: h.value, isEstimate: h.isEstimate });
}

/** Rate: hide when the (pooled) denominator is under 30. A rate with no denominator stays null, unsuppressed. */
export function guardRate(m: Metric): Metric {
  return m.denominator !== undefined && m.denominator > 0 && isRateSuppressed(m.denominator)
    ? suppressed(m.isEstimate)
    : m;
}

/** Count: hide when 1 to 10. */
export function guardCount(m: Metric): Metric {
  return m.value !== null && isCountSuppressed(m.value) ? suppressed(m.isEstimate) : m;
}

export const FacilityRowSchema = z.object({
  facility_code: z.string(),
  facility_name: z.string(),
  /** Staff view only: how many orgs contribute. Never sent in the public view. */
  orgs: z.number().nullable(),
  cycles: z.number().nullable(),
  participants: MetricSchema,
  completion: MetricSchema,
  hours: MetricSchema,
  suppressed: z.boolean(),
});
export type FacilityRow = z.infer<typeof FacilityRowSchema>;

/** One row per facility with confirmed cycles. Cycles with no facility are not in any row. */
export function byFacility(cycles: CycleRow[], view: View): FacilityRow[] {
  const groups = new Map<string, CycleRow[]>();
  for (const c of cycles) {
    if (!c.facility_code) continue;
    groups.set(c.facility_code, [...(groups.get(c.facility_code) ?? []), c]);
  }
  const rows: FacilityRow[] = [];
  for (const [code, group] of groups) {
    const orgs = new Set(group.map((c) => c.org_id)).size;
    const name = group[0]?.facility_name ?? code;
    const hide = view === "public" && isFacilitySuppressed(orgs);
    const participants = participantsMetric(group);
    const hours = hoursMetric(group);
    rows.push({
      facility_code: code,
      facility_name: name,
      orgs: view === "staff" ? orgs : null,
      cycles: view === "staff" ? group.length : null,
      participants: hide ? suppressed(participants.isEstimate) : view === "public" ? guardCount(participants) : participants,
      completion: hide ? suppressed() : view === "public" ? guardRate(completionMetric(group)) : completionMetric(group),
      // Hours would reveal a tiny enrollment, so they follow the participant count.
      hours: hide || (view === "public" && guardCount(participants).suppressed) ? suppressed(hours.isEstimate) : hours,
      suppressed: hide,
    });
  }
  return rows.sort((a, b) => a.facility_name.localeCompare(b.facility_name));
}

export const DashboardSchema = z.object({
  view: z.enum(["staff", "public"]),
  participants: MetricSchema,
  completion: MetricSchema,
  hours: MetricSchema,
  prisons: z.object({ covered: z.number(), total: z.number() }),
  /** Facilities with no confirmed cycle. */
  deserts: z.array(z.object({ facility_code: z.string(), facility_name: z.string() })),
  facilities: z.array(FacilityRowSchema),
  /** Per-cycle detail, staff view only (it names orgs and small cohorts). */
  cycles: z.array(CycleRowSchema),
  hoursNote: z.object({ delivered: z.number(), planned: z.number(), unknown: z.number() }),
  cyclesExcludedFromCompletion: z.number(),
});
export type Dashboard = z.infer<typeof DashboardSchema>;

export function buildDashboard(
  cycles: CycleRow[],
  allFacilities: { facility_code: string; facility_name: string }[],
  view: View,
): Dashboard {
  const participants = participantsMetric(cycles);
  const completion = completionMetric(cycles);
  const hours = hoursMetric(cycles);
  const covered = new Set(cycles.map((c) => c.facility_code).filter((c): c is string => !!c));
  const h = totalHours(cycles);
  const pub = view === "public";
  const participantsShown = pub ? guardCount(participants) : participants;
  return {
    view,
    participants: participantsShown,
    completion: pub ? guardRate(completion) : completion,
    hours: pub && participantsShown.suppressed ? suppressed(hours.isEstimate) : hours,
    prisons: { covered: covered.size, total: allFacilities.length },
    deserts: allFacilities.filter((f) => !covered.has(f.facility_code)),
    facilities: byFacility(cycles, view),
    cycles: pub ? [] : cycles,
    hoursNote: { delivered: h.cyclesDelivered, planned: h.cyclesPlanned, unknown: h.cyclesUnknown },
    cyclesExcludedFromCompletion: completionRate(cycles).cyclesExcluded,
  };
}
