import { FACILITIES } from "./facilities";
import {
  cleanCycleRow, cycleKey, isBlocking, needsCompletedCount,
  type CleanCycle, type CycleFormRow, type CycleIssue, type RegistryField,
} from "./formCycle";

/** A cycle as stored, before cleaning. Counts and flags are exactly what the database holds. */
export type StoredCycle = {
  cycle_id: string;
  program_id: string;
  program_name: string;
  facility_code: string | null;
  /** What the CBO wrote for the prison when it could not be matched, so cleaning can report it again. */
  facility_raw: string | null;
  yard: string | null;
  start_date: string | null;
  end_date: string | null;
  sessions_planned: number | null;
  course_hours_planned_per_participant: number | null;
  n_enrolled: number | null;
  n_completed: number | null;
  total_course_hours_delivered: number | null;
  n_enrolled_approx: boolean;
  n_completed_approx: boolean;
  total_course_hours_delivered_approx: boolean;
  /** program_cycles.extra: registry answers plus the underscore keys Sam keeps (`_completion_rule`, `_approx_asked`). */
  extra: Record<string, unknown>;
};

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));

export function facilityName(code: string | null): string | null {
  return FACILITIES.find((f) => f.facility_code === code)?.facility_name ?? null;
}

export function toFormRow(c: StoredCycle): CycleFormRow {
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.extra)) if (!k.startsWith("_")) extra[k] = s(v);
  return {
    program_id: c.program_id,
    program_name: c.program_name,
    facility_raw: facilityName(c.facility_code) ?? c.facility_raw ?? "",
    yard: s(c.yard),
    start_date: s(c.start_date),
    end_date: s(c.end_date),
    sessions_planned: s(c.sessions_planned),
    course_hours_planned_per_participant: s(c.course_hours_planned_per_participant),
    n_enrolled: s(c.n_enrolled),
    n_completed: s(c.n_completed),
    total_course_hours_delivered: s(c.total_course_hours_delivered),
    n_enrolled_approx: c.n_enrolled_approx,
    n_completed_approx: c.n_completed_approx,
    total_course_hours_delivered_approx: c.total_course_hours_delivered_approx,
    completion_rule: typeof c.extra._completion_rule === "string" ? c.extra._completion_rule : "",
    extra,
  };
}

const TEXT_FIELDS = [
  "yard", "start_date", "end_date", "sessions_planned", "course_hours_planned_per_participant",
  "n_enrolled", "n_completed", "total_course_hours_delivered", "completion_rule",
] as const;
export const APPROX_FIELDS = ["n_enrolled", "n_completed", "total_course_hours_delivered"] as const;

/** Fields an answer or correction may set: the cycle fields above, the prison, and active registry fields. */
export function isAnswerable(field: string, registry: RegistryField[]): boolean {
  return field === "facility_code" || (TEXT_FIELDS as readonly string[]).includes(field) || registry.some((f) => f.field_key === field);
}

/**
 * Puts one answer into a form row. The text is validated afterwards by cleanCycleRow, so a bad answer
 * becomes an issue instead of a stored value. `approx` only applies to the three count fields.
 */
export function overlayAnswer(row: CycleFormRow, field: string, value: string, approx: boolean, registry: RegistryField[]): CycleFormRow | null {
  const v = value.trim().replace(/(\d),(\d{3})\b/g, "$1$2");
  if (!v) return null;
  if (field === "facility_code") return { ...row, facility_raw: v };
  if ((TEXT_FIELDS as readonly string[]).includes(field)) {
    const next = { ...row, [field]: v } as CycleFormRow;
    if ((APPROX_FIELDS as readonly string[]).includes(field)) (next as Record<string, unknown>)[`${field}_approx`] = approx;
    return next;
  }
  if (registry.some((f) => f.field_key === field)) return { ...row, extra: { ...row.extra, [field]: v } };
  return null;
}

export function missingCompletedIssue(c: Pick<CleanCycle, "program_name" | "start_date">): CycleIssue {
  return {
    field_name: "n_completed", issue_type: "missing_required", raw_value: null,
    message: `How many people completed ${c.program_name}${c.start_date ? ` (started ${c.start_date})` : ""}?`,
  };
}

export type DerivedCycle = { cycle_id: string; cycle: CleanCycle; issues: CycleIssue[]; blocked: boolean };

/**
 * Cleans every cycle of a submission from what is stored and lists what is still wrong. Deterministic, so the
 * same stored rows always give the same questions. Email and upload ask for a missing completed count; a repeated
 * cycle key inside the submission is a conflict on the later one.
 */
export function deriveCycles(orgId: string, stored: StoredCycle[], registry: RegistryField[], today: string, overrides: Map<string, CycleFormRow> = new Map()): DerivedCycle[] {
  const seen = new Set<string>();
  return stored.map((st) => {
    const { cycle, issues } = cleanCycleRow(overrides.get(st.cycle_id) ?? toFormRow(st), registry);
    if (needsCompletedCount(cycle, today)) issues.push(missingCompletedIssue(cycle));
    const key = cycleKey(orgId, cycle.program_id, cycle.facility_code, cycle.start_date);
    if (seen.has(key)) {
      issues.push({
        field_name: "start_date", issue_type: "conflict", raw_value: cycle.start_date,
        message: `${cycle.program_name} appears twice for the same prison and start date. Which start date is right for this one?`,
      });
    }
    seen.add(key);
    return { cycle_id: st.cycle_id, cycle, issues, blocked: issues.some(isBlocking) };
  });
}
