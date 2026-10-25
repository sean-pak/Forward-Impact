import {
  ageBandAt, computeAttendance, fiscalYear, groupCycles, nameVariants, parseIndividual,
  type ColumnMapping, type CycleFormRow, type Grid, type IndividualExtra, type Meaning, type PersonRow, type Risk, type Supervision,
} from "@tpw/shared";
import { writeSubmission, type OrgRow } from "../form";
import type { IngestMeta, IngestOutcome } from "../ingest";
import type { IdentityInput, PersonKeyBasis } from "../vault";
import { bulkInsert } from "./sql";
import type { IndividualRow } from "./types";

/** Anything that can scramble people. The Worker passes the vault; tests pass a fake with the same shape. */
export type IdentityStore = {
  upsertIdentities(inputs: IdentityInput[]): Promise<{ personKey: string; basis: PersonKeyBasis }[]>;
};

export const INDIVIDUAL_PARSER_VERSION = "ingest-2";

const ENROLLMENT_COLUMNS = [
  "enrollment_id", "cycle_id", "person_key", "enrollment_date", "sessions_attended", "sessions_planned_for_person", "attendance_rate",
  "hours_attended", "completed", "completion_basis", "completion_date", "cbo_completed", "submission_id", "is_synthetic",
] as const;

type Member = { p: PersonRow; key: string };
type Staged = { dob: string | null; risk: Risk; release: string | null; supervision: Supervision; starts: string[] };

const isoDate = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

/**
 * Persona 3 and 4 (PRD 7.3). Identifiers go to the vault and come back as person_keys; everything else is written
 * against the key. Cycle counts are derived from the people. Nothing counts until the CBO confirms: cycles are
 * drafts, and attributes, releases and custody wait in `staged_people`.
 * Returns null when the file cannot be read as people, so the caller can hand it to staff.
 */
export async function ingestIndividual(
  db: D1Database,
  org: OrgRow,
  grid: Grid,
  headerRow: number,
  mapping: ColumnMapping,
  meta: IngestMeta,
  store: IdentityStore,
): Promise<IngestOutcome | null> {
  const today = meta.today ?? new Date().toISOString().slice(0, 10);
  const known = await db.prepare("SELECT program_name FROM programs WHERE org_id = ?").bind(org.org_id).all<{ program_name: string }>();
  const parse = parseIndividual(grid, headerRow, mapping, { programs: known.results.map((r) => r.program_name) });
  if ("error" in parse) return null;

  const keys = await store.upsertIdentities(
    parse.people.map((p) => ({ cdcrNumber: p.cdcr, firstName: p.first, lastName: p.last, dateOfBirth: p.dob, orgId: org.org_id, isSynthetic: org.is_synthetic === 1 })),
  );
  const keyOf = new Map(parse.people.map((p, i) => [p, keys[i]!.personKey]));
  const scrambled = {
    names: new Set(parse.people.filter((p) => p.first || p.last).map((p) => keyOf.get(p)!)).size,
    cdcr: new Set(parse.people.filter((p) => p.cdcr).map((p) => keyOf.get(p)!)).size,
  };

  // What is known about each person across all of their rows, for the tables that are not tied to one cycle.
  const staged = new Map<string, Staged>();
  for (const p of parse.people) {
    const a = staged.get(keyOf.get(p)!) ?? { dob: null, risk: "unknown" as Risk, release: null, supervision: "unknown" as Supervision, starts: [] };
    a.dob ??= p.dob;
    if (a.risk === "unknown") a.risk = p.risk;
    a.release ??= p.release_date;
    if (a.supervision === "unknown") a.supervision = p.supervision;
    const s = isoDate(p.start);
    if (s) a.starts.push(s);
    staged.set(keyOf.get(p)!, a);
  }
  const fileCounters: Record<string, number> = { ...parse.counts };
  const stagedRows: unknown[][] = [];
  for (const [key, a] of staged) {
    const release = a.release && a.release <= today ? a.release : null;
    const projected = a.release && a.release > today ? a.release : null;
    const earliest = [...a.starts].sort()[0] ?? null;
    if (projected) fileCounters.future_release = (fileCounters.future_release ?? 0) + 1;
    if (release && earliest && release < earliest) fileCounters.pre_program_release = (fileCounters.pre_program_release ?? 0) + 1;
    const payload = {
      birth_year: a.dob ? Number(a.dob.slice(0, 4)) : null,
      age_band: release && a.dob ? ageBandAt(a.dob, release) : "unknown",
      risk_band: a.risk,
      release: release
        ? { date: release, fiscal_year: fiscalYear(release), supervision: a.supervision, post_program: earliest ? +(release >= earliest) : null }
        : null,
      projected_release: projected,
      custody: release ? "released" : projected ? "in_custody" : null,
    };
    const empty = payload.birth_year === null && payload.age_band === "unknown" && payload.risk_band === "unknown" && !payload.release && !payload.custody;
    if (!empty) stagedRows.push([null, key, JSON.stringify(payload), org.is_synthetic]);
  }

  const groups = groupCycles(parse);
  const rows: CycleFormRow[] = [];
  const individual: IndividualRow[] = [];
  groups.forEach((g, gi) => {
    const counters: Record<string, number> = gi === 0 ? fileCounters : {};
    const seen = new Set<string>();
    const members: Member[] = [];
    for (const p of g.people) {
      const key = keyOf.get(p)!;
      if (seen.has(key)) {
        counters.repeated_rows = (counters.repeated_rows ?? 0) + 1;
        continue;
      }
      seen.add(key);
      members.push({ p, key });
    }
    const base: CycleFormRow = {
      program_id: "", program_name: g.program_name, facility_raw: g.facility_raw, yard: "", start_date: g.start, end_date: g.end,
      sessions_planned: "", course_hours_planned_per_participant: "", n_enrolled: String(members.length), n_completed: "",
      total_course_hours_delivered: "", n_enrolled_approx: false, n_completed_approx: false, total_course_hours_delivered_approx: false,
      completion_rule: g.rule, extra: {},
    };

    if (parse.grain === "attendance") {
      const sessions = parse.sessions.map((s, j) => ({ id: `ses_${crypto.randomUUID()}`, date: s.date, cancelled: parse.cancelled[j]! }));
      const legend: Record<string, Meaning> = {};
      if (members.some((m) => m.p.marks.includes("LATE"))) legend.LATE = "late";
      const res = computeAttendance({
        sessions, legend, lateCounts: null, rule: g.rule || "unstated",
        people: members.map((m) => ({ key: m.key, marks: m.p.marks, cbo: m.p.cbo })),
      });
      const pairs = nameVariants(members.map((m) => ({ key: m.key, row: m.p.row, first: m.p.first, last: m.p.last, cdcr: m.p.cdcr, dob: m.p.dob })))
        .map(([a, b]) => ({ id: `${a.key}|${b.key}`, a: a.key, b: b.key, rows: [a.row, b.row] as [number, number] }));
      rows.push({
        ...base, sessions_planned: String(sessions.filter((s) => !s.cancelled).length), n_completed: res.nCompleted === null ? "" : String(res.nCompleted),
      });
      const extra: IndividualExtra = {
        _individual: "attendance", _marks_unknown: res.unknownMarks, _late_counts: null, _notes: counters,
        ...(Object.keys(legend).length ? { _legend: legend } : {}), ...(pairs.length ? { _dup_pairs: pairs } : {}),
      };
      individual.push({
        extra,
        children: ({ cycleId, submissionId }) => {
          const attendance: unknown[][] = [];
          members.forEach((m, i) => {
            sessions.forEach((s, j) => {
              if (!s.cancelled) attendance.push([s.id, m.key, res.people[i]!.statuses[j], m.p.marks[j], submissionId, org.is_synthetic]);
            });
          });
          return [
            ...bulkInsert(db, "sessions", ["session_id", "cycle_id", "session_date", "cancelled", "cancel_reason", "submission_id", "is_synthetic"],
              sessions.map((s) => [s.id, cycleId, s.date, +s.cancelled, s.cancelled ? "unknown" : null, submissionId, org.is_synthetic])),
            ...bulkInsert(db, "session_attendance", ["session_id", "person_key", "status", "raw_mark", "submission_id", "is_synthetic"], attendance),
            ...bulkInsert(db, "enrollments", ENROLLMENT_COLUMNS, members.map((m, i) => {
              const r = res.people[i]!;
              return [`enr_${crypto.randomUUID()}`, cycleId, m.key, null, r.attended, r.planned, r.rate, null, r.completed, r.basis, null, m.p.cbo, submissionId, org.is_synthetic];
            })),
          ];
        },
      });
      return;
    }

    const unmarked = members.filter((m) => m.p.cbo === "unknown").length;
    if (unmarked > 0) counters.completed_unmarked = (counters.completed_unmarked ?? 0) + unmarked;
    const hours = members.map((m) => m.p.hours);
    rows.push({
      ...base,
      n_completed: unmarked === 0 ? String(members.filter((m) => m.p.cbo === "yes").length) : "",
      total_course_hours_delivered: hours.every((h) => h !== null) ? String(Math.round(hours.reduce((a, h) => a + h!, 0) * 100) / 100) : "",
    });
    individual.push({
      extra: { _individual: "people", _notes: counters },
      children: ({ cycleId, submissionId }) => [
        ...bulkInsert(db, "enrollments", ENROLLMENT_COLUMNS, members.map((m) => [
          `enr_${crypto.randomUUID()}`, cycleId, m.key, isoDate(m.p.start), null, null, null, m.p.hours, m.p.cbo,
          m.p.cbo === "unknown" ? "unknown" : "cbo_marked", null, m.p.cbo, submissionId, org.is_synthetic,
        ])),
        ...bulkInsert(db, "credit_awards", ["person_key", "cycle_id", "credit_type", "credit_days_earned", "credit_days_applied", "award_date", "submission_id", "is_synthetic"],
          members.filter((m) => m.p.credits !== null).map((m) => [m.key, cycleId, "unknown", m.p.credits, null, null, submissionId, org.is_synthetic])),
      ],
    });
  });

  const w = await writeSubmission(db, org, rows, {
    channel: meta.channel, parserVersion: INDIVIDUAL_PARSER_VERSION, llmMappingUsed: true, detectedPersona: mapping.persona,
    senderEmail: meta.senderEmail, duplicates: "flag", individual, scrambled,
    extraStatements: (submissionId) => bulkInsert(db, "staged_people", ["submission_id", "person_key", "payload", "is_synthetic"], stagedRows.map((r) => [submissionId, r[1], r[2], r[3]])),
  });
  if (!w.ok) throw new Error(w.error);
  return { submission_id: w.submission_id, status: w.blocked ? "needs_info" : "awaiting_confirmation", cycles: rows.length };
}
