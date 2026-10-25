import { z } from "zod";

/** One confirmed cycle joined with its program, org and facility (what the Worker SELECTs). */
export const CycleRowSchema = z.object({
  cycle_id: z.string(),
  org_id: z.string(),
  org_name: z.string(),
  program_name: z.string(),
  completion_rule: z.string(),
  facility_code: z.string().nullable(),
  facility_name: z.string().nullable(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  course_hours_planned_per_participant: z.number().nullable(),
  n_enrolled: z.number().nullable(),
  n_completed: z.number().nullable(),
  total_course_hours_delivered: z.number().nullable(),
  n_enrolled_approx: z.number(),
  n_completed_approx: z.number(),
  total_course_hours_delivered_approx: z.number(),
});
export type CycleRow = z.infer<typeof CycleRowSchema>;

export type Count = { value: number; isEstimate: boolean };
export type Rate = {
  value: number | null;
  numerator: number;
  denominator: number;
  isEstimate: boolean;
  /** Cycles left out because the completion rule or a count is missing. */
  cyclesExcluded: number;
};
export type Hours = {
  value: number;
  /** True when any cycle used planned hours or an approximate figure. */
  isEstimate: boolean;
  cyclesDelivered: number;
  cyclesPlanned: number;
  cyclesUnknown: number;
};

const isStated = (rule: string) => rule.trim() !== "" && rule.trim().toLowerCase() !== "unstated";

/** Participants: sum of known enrollments. Missing counts are skipped, never guessed. */
export function sumParticipants(cycles: CycleRow[]): Count {
  let value = 0;
  let isEstimate = false;
  for (const c of cycles) {
    if (c.n_enrolled === null) continue;
    value += c.n_enrolled;
    if (c.n_enrolled_approx) isEstimate = true;
  }
  return { value, isEstimate };
}

/**
 * Completion rate over cycles with a stated completion rule and both counts known.
 * Travels with numerator and denominator; null value when nothing qualifies.
 */
export function completionRate(cycles: CycleRow[]): Rate {
  let numerator = 0;
  let denominator = 0;
  let isEstimate = false;
  let cyclesExcluded = 0;
  for (const c of cycles) {
    if (!isStated(c.completion_rule) || c.n_enrolled === null || c.n_completed === null) {
      cyclesExcluded++;
      continue;
    }
    numerator += c.n_completed;
    denominator += c.n_enrolled;
    if (c.n_enrolled_approx || c.n_completed_approx) isEstimate = true;
  }
  return {
    value: denominator > 0 ? numerator / denominator : null,
    numerator,
    denominator,
    isEstimate,
    cyclesExcluded,
  };
}

/**
 * Participant-hours: delivered hours when reported, otherwise planned hours per participant
 * times enrolled (an estimate). Cycles with neither are counted as unknown, not zero.
 */
export function totalHours(cycles: CycleRow[]): Hours {
  const out: Hours = { value: 0, isEstimate: false, cyclesDelivered: 0, cyclesPlanned: 0, cyclesUnknown: 0 };
  for (const c of cycles) {
    if (c.total_course_hours_delivered !== null) {
      out.value += c.total_course_hours_delivered;
      out.cyclesDelivered++;
      if (c.total_course_hours_delivered_approx) out.isEstimate = true;
    } else if (c.course_hours_planned_per_participant !== null && c.n_enrolled !== null) {
      out.value += c.course_hours_planned_per_participant * c.n_enrolled;
      out.cyclesPlanned++;
      out.isEstimate = true;
    } else {
      out.cyclesUnknown++;
    }
  }
  return out;
}
