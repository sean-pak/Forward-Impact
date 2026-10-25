import type { CycleFormRow } from "@tpw/shared";

/** Reads the form's `r<i>.<field>` inputs into rows. Checkboxes arrive as "on" when ticked. */
export function rowsFromFormData(fd: FormData, rowCount: number, fieldKeys: string[]): CycleFormRow[] {
  const get = (i: number, k: string) => String(fd.get(`r${i}.${k}`) ?? "");
  const rows: CycleFormRow[] = [];
  for (let i = 0; i < rowCount; i++) {
    rows.push({
      program_id: get(i, "program_id"),
      program_name: get(i, "program_name"),
      facility_raw: get(i, "facility_raw"),
      yard: get(i, "yard"),
      start_date: get(i, "start_date"),
      end_date: get(i, "end_date"),
      sessions_planned: get(i, "sessions_planned"),
      course_hours_planned_per_participant: get(i, "course_hours_planned_per_participant"),
      n_enrolled: get(i, "n_enrolled"),
      n_completed: get(i, "n_completed"),
      total_course_hours_delivered: get(i, "total_course_hours_delivered"),
      n_enrolled_approx: fd.get(`r${i}.n_enrolled_approx`) === "on",
      n_completed_approx: fd.get(`r${i}.n_completed_approx`) === "on",
      total_course_hours_delivered_approx: fd.get(`r${i}.total_course_hours_delivered_approx`) === "on",
      completion_rule: get(i, "completion_rule"),
      extra: Object.fromEntries(fieldKeys.map((k) => [k, get(i, `extra.${k}`)])),
    });
  }
  return rows;
}
