import { computeAttendance, type AttendanceResult, type Completed, type IndividualExtra } from "@tpw/shared";
import { bulkInsert } from "./sql";

/** An attendance cycle as stored: its class dates and each person's mark per date. Person keys only. */
export type AttendanceCycle = {
  cycleId: string;
  sessions: { id: string; cancelled: boolean }[];
  people: { key: string; marks: string[]; cbo: Completed }[];
};

export async function loadAttendance(db: D1Database, cycleIds: string[]): Promise<Map<string, AttendanceCycle>> {
  const out = new Map<string, AttendanceCycle>();
  for (const cycleId of cycleIds) {
    const [s, e, a] = await Promise.all([
      db.prepare("SELECT session_id, cancelled FROM sessions WHERE cycle_id = ? ORDER BY session_date, rowid").bind(cycleId).all<{ session_id: string; cancelled: number }>(),
      db.prepare("SELECT person_key, cbo_completed FROM enrollments WHERE cycle_id = ? ORDER BY rowid").bind(cycleId).all<{ person_key: string; cbo_completed: Completed }>(),
      db.prepare("SELECT a.person_key, a.session_id, a.raw_mark FROM session_attendance a JOIN sessions s ON s.session_id = a.session_id WHERE s.cycle_id = ?")
        .bind(cycleId).all<{ person_key: string; session_id: string; raw_mark: string | null }>(),
    ]);
    const mark = new Map(a.results.map((r) => [`${r.person_key}|${r.session_id}`, r.raw_mark ?? ""]));
    const sessions = s.results.map((r) => ({ id: r.session_id, cancelled: r.cancelled === 1 }));
    out.set(cycleId, {
      cycleId, sessions,
      people: e.results.map((p) => ({ key: p.person_key, cbo: p.cbo_completed, marks: sessions.map((x) => mark.get(`${p.person_key}|${x.id}`) ?? "") })),
    });
  }
  return out;
}

/** People the CBO said are the same person as an earlier row: the later row is left out of every count. */
export function mergedAway(extra: IndividualExtra): string[] {
  return (extra._dup_pairs ?? []).filter((p) => extra._dup_resolved?.[p.id] === "same").map((p) => p.b);
}

/** Attended, planned and completion from what is stored plus the CBO's answers so far. */
export function attendanceFor(cycle: AttendanceCycle, extra: IndividualExtra, rule: string): AttendanceResult {
  const gone = new Set(mergedAway(extra));
  return computeAttendance({
    sessions: cycle.sessions, people: cycle.people.filter((p) => !gone.has(p.key)),
    legend: extra._legend ?? {}, lateCounts: extra._late_counts ?? null, rule,
  });
}

/** Brings the stored rows in line with the answers: marks get their meaning, merged rows go, counts are rewritten. */
export function attendanceWrites(db: D1Database, cycle: AttendanceCycle, extra: IndividualExtra, result: AttendanceResult): D1PreparedStatement[] {
  const inCycle = "session_id IN (SELECT session_id FROM sessions WHERE cycle_id = ?)";
  const out: D1PreparedStatement[] = [];
  for (const [mark, meaning] of Object.entries(extra._legend ?? {})) {
    out.push(db.prepare(`UPDATE session_attendance SET status = ? WHERE raw_mark = ? AND ${inCycle}`).bind(meaning, mark, cycle.cycleId));
  }
  for (const key of mergedAway(extra)) {
    out.push(
      db.prepare("DELETE FROM enrollments WHERE cycle_id = ? AND person_key = ?").bind(cycle.cycleId, key),
      db.prepare(`DELETE FROM session_attendance WHERE person_key = ? AND ${inCycle}`).bind(key, cycle.cycleId),
    );
  }
  const rows = result.people.map((p) => [p.key, p.attended, p.planned, p.rate, p.completed, p.basis]);
  for (let i = 0; i < rows.length; i += 400) {
    out.push(
      db.prepare(
        `UPDATE enrollments SET sessions_attended = x.a, sessions_planned_for_person = x.p, attendance_rate = x.r, completed = x.c, completion_basis = x.b
         FROM (SELECT json_extract(value,'$[0]') AS k, json_extract(value,'$[1]') AS a, json_extract(value,'$[2]') AS p,
                      json_extract(value,'$[3]') AS r, json_extract(value,'$[4]') AS c, json_extract(value,'$[5]') AS b FROM json_each(?)) AS x
         WHERE enrollments.cycle_id = ? AND enrollments.person_key = x.k`,
      ).bind(JSON.stringify(rows.slice(i, i + 400)), cycle.cycleId),
    );
  }
  return out;
}

export { bulkInsert };
