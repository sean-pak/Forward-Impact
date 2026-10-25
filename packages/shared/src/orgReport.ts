import { z } from "zod";
import { DashboardSchema } from "./metrics";
import { completionRate, sumParticipants, totalHours, type CycleRow } from "./summary";

/** One enrollment on the CBO's own report. Names come from the vault, never from the analytics DB. */
export const ParticipantRowSchema = z.object({
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  cdcr_number: z.string().nullable(),
  program_name: z.string(),
  facility_name: z.string().nullable(),
  start_date: z.string().nullable(),
  sessions_attended: z.number().nullable(),
  sessions_planned: z.number().nullable(),
  completed: z.enum(["yes", "no", "in_progress", "unknown"]),
});
export type ParticipantRow = z.infer<typeof ParticipantRowSchema>;

export const OrgReportSchema = z.object({
  org_name: z.string(),
  /** Staff view over this org's confirmed cycles: a CBO sees its own numbers unsuppressed. */
  dashboard: DashboardSchema,
  /** Null when the vault could not be opened; the page then shows counts without names. */
  participants: z.array(ParticipantRowSchema).nullable(),
  grant_text: z.string().nullable(),
});
export type OrgReport = z.infer<typeof OrgReportSchema>;

const fmt = new Intl.NumberFormat("en-US");
const n = (v: number) => fmt.format(Math.round(v));
const plural = (k: number, one: string, many = `${one}s`) => (k === 1 ? one : many);

/**
 * "Use this in your grant": a paragraph built only from confirmed counts. Sentences whose numbers are unknown are
 * left out rather than guessed; approximate inputs read "about".
 */
export function grantText(orgName: string, cycles: CycleRow[]): string | null {
  if (cycles.length === 0) return null;
  const prisons = [...new Set(cycles.map((c) => c.facility_name).filter((f): f is string => !!f))].sort();
  const dates = cycles.flatMap((c) => [c.start_date, c.end_date]).filter((d): d is string => !!d).sort();
  const programs = new Set(cycles.map((c) => c.program_name)).size;
  const p = sumParticipants(cycles);
  const r = completionRate(cycles);
  const h = totalHours(cycles);

  const span = dates.length ? `Between ${dates[0]} and ${dates[dates.length - 1]}, ` : "";
  const where = prisons.length ? ` at ${prisons.length} California ${plural(prisons.length, "prison")} (${prisons.join(", ")})` : "";
  const out = [`${span}${orgName} ran ${cycles.length} ${plural(cycles.length, "class", "classes")} across ${programs} ${plural(programs, "program")}${where}.`];
  if (p.value > 0) out.push(`${p.isEstimate ? "About " : ""}${n(p.value)} people enrolled.`);
  if (r.value !== null) {
    out.push(
      `Of the ${n(r.denominator)} enrolled in classes with a stated completion standard, ${n(r.numerator)} completed (${r.isEstimate ? "about " : ""}${Math.round(r.value * 100)}%).`,
    );
  }
  if (h.value > 0) out.push(`Participants received ${h.isEstimate ? "about " : ""}${n(h.value)} hours of programming in total.`);
  out.push(`These figures were reported and confirmed by ${orgName}.`);
  return out.join(" ");
}
