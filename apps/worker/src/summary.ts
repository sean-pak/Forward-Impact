import { buildDashboard, CycleRowSchema, type CycleRow, type Dashboard, type View } from "@tpw/shared";

// Confirmed cycles only: data counts once the CBO confirms it. Superseded and draft rows never appear.
const CONFIRMED_CYCLES_SQL = `
  SELECT c.cycle_id, c.org_id, o.org_name, p.program_name, p.completion_rule,
         c.facility_code, f.facility_name, c.start_date, c.end_date,
         c.course_hours_planned_per_participant, c.n_enrolled, c.n_completed,
         c.total_course_hours_delivered, c.n_enrolled_approx, c.n_completed_approx,
         c.total_course_hours_delivered_approx
  FROM program_cycles c
  JOIN programs p ON p.program_id = c.program_id
  JOIN orgs o ON o.org_id = c.org_id
  LEFT JOIN facilities f ON f.facility_code = c.facility_code
  WHERE c.status = 'confirmed' AND (?1 IS NULL OR c.org_id = ?1)
  ORDER BY c.start_date DESC, c.cycle_id`;

/** Every org's confirmed cycles, or one org's when `orgId` is given. */
export async function loadConfirmedCycles(db: D1Database, orgId: string | null = null): Promise<CycleRow[]> {
  const { results } = await db.prepare(CONFIRMED_CYCLES_SQL).bind(orgId).all();
  return results.map((r) => CycleRowSchema.parse(r));
}

export async function loadFacilities(db: D1Database) {
  return (
    await db.prepare("SELECT facility_code, facility_name FROM facilities ORDER BY facility_name").all<{
      facility_code: string;
      facility_name: string;
    }>()
  ).results;
}

export async function loadDashboard(db: D1Database, view: View): Promise<Dashboard> {
  const [cycles, facilities] = await Promise.all([loadConfirmedCycles(db), loadFacilities(db)]);
  return buildDashboard(cycles, facilities, view);
}
