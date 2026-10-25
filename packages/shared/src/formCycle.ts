import { normalizeFacility } from "./normalizeFacility";

/** Core fields the dashboard cannot count without. An issue on one of these blocks confirmation. */
export const REQUIRED_CYCLE_FIELDS = ["n_enrolled", "facility_code", "start_date"] as const;

export type CycleIssue = {
  field_name: string;
  issue_type: "missing_required" | "invalid_value" | "out_of_range" | "conflict" | "ambiguous_mapping";
  raw_value: string | null;
  /** Plain language, safe to show the CBO (schema-v2 section 12). */
  message: string;
};

/** One row of the form, as text straight from the browser. */
export type CycleFormRow = {
  program_id: string;
  program_name: string;
  facility_raw: string;
  yard: string;
  start_date: string;
  end_date: string;
  sessions_planned: string;
  course_hours_planned_per_participant: string;
  n_enrolled: string;
  n_completed: string;
  total_course_hours_delivered: string;
  n_enrolled_approx: boolean;
  n_completed_approx: boolean;
  total_course_hours_delivered_approx: boolean;
  completion_rule: string;
  /** Answers for active non-core registry fields, by field_key. */
  extra: Record<string, string>;
};

export type RegistryField = {
  field_key: string;
  label: string;
  type: "text" | "integer" | "number" | "boolean" | "date" | "enum";
  options: string[] | null;
  required: boolean;
};

export type CleanCycle = {
  program_id: string;
  program_name: string;
  facility_code: string | null;
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
  /** 'unstated' when the CBO gave none. Never assumed. */
  completion_rule: string;
  extra: Record<string, string | number | boolean>;
};

const t = (s: string | undefined) => (s ?? "").trim();

/** A row with no cycle-specific data is a pre-filled program the CBO did not report on this time. */
export function isBlankRow(r: CycleFormRow): boolean {
  return [r.start_date, r.end_date, r.n_enrolled, r.n_completed, r.total_course_hours_delivered].every((v) => !t(v));
}

/** Strict YYYY-MM-DD that is a real calendar date. */
export function parseIsoDate(raw: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]! ? raw : null;
}

/** Dedupe key (schema-v2): org|program|facility|start_date, 'unknown' for gaps. */
export function cycleKey(orgId: string, programId: string, facilityCode: string | null, startDate: string | null): string {
  return [orgId, programId, facilityCode ?? "unknown", startDate ?? "unknown"].join("|");
}

/** Blocking = the CBO must fix it before the data can count. */
export function isBlocking(i: Pick<CycleIssue, "field_name" | "issue_type">): boolean {
  return i.issue_type !== "missing_required" || (REQUIRED_CYCLE_FIELDS as readonly string[]).includes(i.field_name);
}

/**
 * Turns one form row into typed values plus issues. Nothing is invented: a value that
 * cannot be read becomes null and an issue. Approximate flags are carried through as given.
 */
export function cleanCycleRow(r: CycleFormRow, registry: RegistryField[]): { cycle: CleanCycle; issues: CycleIssue[] } {
  const issues: CycleIssue[] = [];
  const flag = (field_name: string, issue_type: CycleIssue["issue_type"], raw: string, message: string) =>
    issues.push({ field_name, issue_type, raw_value: raw || null, message });
  const name = t(r.program_name);

  const count = (field: string, label: string, raw: string, required: boolean): number | null => {
    const s = t(raw);
    if (!s) {
      if (required) flag(field, "missing_required", "", `How many ${label}? This is needed for ${name}.`);
      return null;
    }
    if (!/^\d+$/.test(s)) {
      flag(field, "invalid_value", s, `"${s}" is not a whole number for ${label} in ${name}. Please enter a number such as 25.`);
      return null;
    }
    return Number(s);
  };
  const amount = (field: string, label: string, raw: string): number | null => {
    const s = t(raw);
    if (!s) return null;
    if (!/^\d+(\.\d+)?$/.test(s)) {
      flag(field, "invalid_value", s, `"${s}" is not a number for ${label} in ${name}.`);
      return null;
    }
    return Number(s);
  };
  const date = (field: string, label: string, raw: string, required: boolean): string | null => {
    const s = t(raw);
    if (!s) {
      if (required) flag(field, "missing_required", "", `What date did ${name} ${label}?`);
      return null;
    }
    const ok = parseIsoDate(s);
    if (!ok) flag(field, "invalid_value", s, `"${s}" is not a valid ${label} date for ${name}. Please use year-month-day.`);
    return ok;
  };

  const n_enrolled = count("n_enrolled", "people enrolled", r.n_enrolled, true);
  const n_completed = count("n_completed", "people completed", r.n_completed, false);
  const sessions_planned = count("sessions_planned", "sessions planned", r.sessions_planned, false);
  const hoursPer = amount("course_hours_planned_per_participant", "course hours per participant", r.course_hours_planned_per_participant);
  const hoursTotal = amount("total_course_hours_delivered", "total course hours delivered", r.total_course_hours_delivered);
  const start_date = date("start_date", "start", r.start_date, true);
  const end_date = date("end_date", "end", r.end_date, false);

  let facility_code: string | null = null;
  const facRaw = t(r.facility_raw);
  if (!facRaw) {
    flag("facility_code", "missing_required", "", `Which prison did ${name} run at?`);
  } else {
    facility_code = normalizeFacility(facRaw);
    if (!facility_code) {
      flag("facility_code", "ambiguous_mapping", facRaw, `We could not tell which prison "${facRaw}" is. Please pick it from the list.`);
    }
  }

  if (n_enrolled !== null && n_completed !== null && n_completed > n_enrolled) {
    flag("n_completed", "out_of_range", String(n_completed), `${name} shows ${n_completed} completed but only ${n_enrolled} enrolled. Completed cannot be more than enrolled.`);
  }
  if (start_date && end_date && end_date < start_date) {
    flag("end_date", "out_of_range", end_date, `${name} ends (${end_date}) before it starts (${start_date}).`);
  }

  const completion_rule = t(r.completion_rule) || "unstated";
  if (completion_rule === "unstated" && n_completed !== null) {
    flag("completion_rule", "missing_required", "", `What counts as completing ${name}? Without it we cannot show a completion rate.`);
  }

  const extra: CleanCycle["extra"] = {};
  for (const f of registry) {
    const raw = t(r.extra[f.field_key]);
    if (!raw) {
      if (f.required) flag(f.field_key, "missing_required", "", `${f.label} is needed for ${name}.`);
      continue;
    }
    const bad = () => flag(f.field_key, "invalid_value", raw, `"${raw}" is not a valid answer for ${f.label} in ${name}.`);
    if (f.type === "integer") /^\d+$/.test(raw) ? (extra[f.field_key] = Number(raw)) : bad();
    else if (f.type === "number") /^\d+(\.\d+)?$/.test(raw) ? (extra[f.field_key] = Number(raw)) : bad();
    else if (f.type === "boolean") ["yes", "true"].includes(raw.toLowerCase()) ? (extra[f.field_key] = true) : ["no", "false"].includes(raw.toLowerCase()) ? (extra[f.field_key] = false) : bad();
    else if (f.type === "date") parseIsoDate(raw) ? (extra[f.field_key] = raw) : bad();
    else if (f.type === "enum") (f.options ?? []).includes(raw) ? (extra[f.field_key] = raw) : bad();
    else extra[f.field_key] = raw;
  }

  return {
    cycle: {
      program_id: t(r.program_id),
      program_name: name,
      facility_code,
      yard: t(r.yard) || null,
      start_date,
      end_date,
      sessions_planned,
      course_hours_planned_per_participant: hoursPer,
      n_enrolled,
      n_completed,
      total_course_hours_delivered: hoursTotal,
      n_enrolled_approx: r.n_enrolled_approx && n_enrolled !== null,
      n_completed_approx: r.n_completed_approx && n_completed !== null,
      total_course_hours_delivered_approx: r.total_course_hours_delivered_approx && hoursTotal !== null,
      completion_rule,
      extra,
    },
    issues,
  };
}
