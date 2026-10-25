import { z } from "zod";
import {
  FACILITIES,
  cleanCycleRow,
  cycleKey,
  isBlankRow,
  isBlocking,
  type CleanCycle,
  type CycleFormRow,
  type CycleIssue,
  type RegistryField,
} from "@tpw/shared";

/** One form row as the browser sends it. Everything is text; code reads it in cleanCycleRow. */
const RowSchema = z.object({
  program_id: z.string().default(""),
  program_name: z.string().default(""),
  facility_raw: z.string().default(""),
  yard: z.string().default(""),
  start_date: z.string().default(""),
  end_date: z.string().default(""),
  sessions_planned: z.string().default(""),
  course_hours_planned_per_participant: z.string().default(""),
  n_enrolled: z.string().default(""),
  n_completed: z.string().default(""),
  total_course_hours_delivered: z.string().default(""),
  n_enrolled_approx: z.boolean().default(false),
  n_completed_approx: z.boolean().default(false),
  total_course_hours_delivered_approx: z.boolean().default(false),
  completion_rule: z.string().default(""),
  extra: z.record(z.string(), z.string()).default({}),
});
export const FormBodySchema = z.object({ rows: z.array(RowSchema).max(50) });

type OrgRow = { org_id: string; org_name: string; primary_contact_email: string; is_synthetic: number };

export type FormView = {
  org_name: string;
  programs: {
    program_id: string;
    program_name: string;
    completion_rule: string;
    /** From the last confirmed cycle. Counts and dates are never pre-filled. */
    prefill: { facility_name: string; yard: string; sessions_planned: string; course_hours_planned_per_participant: string; extra: Record<string, string> };
  }[];
  facilities: { facility_code: string; facility_name: string; aliases: string[] }[];
  fields: RegistryField[];
};

export type SubmissionView = {
  submission_id: string;
  status: string;
  org_name: string;
  cycles: {
    cycle_id: string; program_name: string; facility_name: string | null; start_date: string | null; end_date: string | null;
    n_enrolled: number | null; n_completed: number | null; total_course_hours_delivered: number | null;
    n_enrolled_approx: boolean; n_completed_approx: boolean; total_course_hours_delivered_approx: boolean;
    completion_rule: string; status: string;
  }[];
  issues: { issue_id: number; row_ref: string | null; field_name: string; issue_type: string; message: string; blocking: boolean }[];
  /** Earlier entries with the same program, prison and start date. Confirming would replace them. */
  duplicates: { cycle_id: string; program_name: string; facility_name: string | null; start_date: string | null; n_enrolled: number | null; n_completed: number | null; submitted_at: string }[];
  /** True when something must be fixed (by resubmitting the form) before the data can count. */
  blocked: boolean;
};

async function orgByToken(db: D1Database, token: string): Promise<OrgRow | null> {
  if (!token) return null;
  return db
    .prepare("SELECT org_id, org_name, primary_contact_email, is_synthetic FROM orgs WHERE form_token = ?")
    .bind(token)
    .first<OrgRow>();
}

async function registryFields(db: D1Database): Promise<RegistryField[]> {
  const { results } = await db
    .prepare("SELECT field_key, label, type, options, required FROM fields WHERE status = 'active' AND is_core = 0 ORDER BY sort_order, field_key")
    .all<{ field_key: string; label: string; type: RegistryField["type"]; options: string | null; required: number }>();
  return results.map((r) => ({
    field_key: r.field_key, label: r.label, type: r.type, required: r.required === 1,
    options: r.options ? (JSON.parse(r.options) as string[]) : null,
  }));
}

export async function loadForm(db: D1Database, token: string): Promise<FormView | null> {
  const org = await orgByToken(db, token);
  if (!org) return null;
  const [programs, cycles, fields] = await Promise.all([
    db.prepare("SELECT program_id, program_name, completion_rule FROM programs WHERE org_id = ? ORDER BY program_name").bind(org.org_id)
      .all<{ program_id: string; program_name: string; completion_rule: string }>(),
    db.prepare(
      `SELECT program_id, facility_code, yard, sessions_planned, course_hours_planned_per_participant, extra
       FROM program_cycles WHERE org_id = ? AND status = 'confirmed' ORDER BY start_date DESC, cycle_id`,
    ).bind(org.org_id).all<{
      program_id: string; facility_code: string | null; yard: string | null; sessions_planned: number | null;
      course_hours_planned_per_participant: number | null; extra: string;
    }>(),
    registryFields(db),
  ]);
  const facName = new Map(FACILITIES.map((f) => [f.facility_code, f.facility_name]));
  const latest = new Map<string, (typeof cycles.results)[number]>();
  for (const c of cycles.results) if (!latest.has(c.program_id)) latest.set(c.program_id, c);
  const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));

  return {
    org_name: org.org_name,
    programs: programs.results.map((p) => {
      const c = latest.get(p.program_id);
      const extra = c ? (JSON.parse(c.extra || "{}") as Record<string, unknown>) : {};
      return {
        ...p,
        prefill: {
          facility_name: c?.facility_code ? (facName.get(c.facility_code) ?? "") : "",
          yard: s(c?.yard),
          sessions_planned: s(c?.sessions_planned),
          course_hours_planned_per_participant: s(c?.course_hours_planned_per_participant),
          extra: Object.fromEntries(fields.filter((f) => f.field_key in extra).map((f) => [f.field_key, s(extra[f.field_key])])),
        },
      };
    }),
    facilities: FACILITIES.map(({ facility_code, facility_name, aliases }) => ({ facility_code, facility_name, aliases })),
    fields,
  };
}

export type SubmitResult =
  | { ok: true; submission_id: string; blocked: boolean }
  | { ok: false; status: 404 | 400; error: string };

/**
 * Writes the submission, draft cycles and issues in one batch. Nothing counts until confirmSubmission.
 * A row with no dates or counts is a pre-filled program the CBO skipped, and is ignored.
 */
export async function submitForm(db: D1Database, token: string, rows: CycleFormRow[]): Promise<SubmitResult> {
  const org = await orgByToken(db, token);
  if (!org) return { ok: false, status: 404, error: "unknown form link" };
  const filled = rows.filter((r) => !isBlankRow(r));
  if (filled.length === 0) return { ok: false, status: 400, error: "Fill in at least one program's dates and counts." };

  const registry = await registryFields(db);
  const known = new Map(
    (await db.prepare("SELECT program_id, lower(program_name) AS n FROM programs WHERE org_id = ?").bind(org.org_id)
      .all<{ program_id: string; n: string }>()).results.map((p) => [p.program_id, p.n]),
  );
  const byName = new Map([...known].map(([id, n]) => [n, id]));

  const statements: D1PreparedStatement[] = [];
  const submissionId = `sub_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const cycleRows: { id: string; cycle: CleanCycle; issues: CycleIssue[]; blocked: boolean }[] = [];
  const seenKeys = new Set<string>();

  for (const row of filled) {
    if (row.program_id && !known.has(row.program_id)) return { ok: false, status: 400, error: "A program on the form does not belong to this organization." };
    if (!row.program_name.trim()) return { ok: false, status: 400, error: "Every program needs a name." };
    let programId = row.program_id || byName.get(row.program_name.trim().toLowerCase()) || "";
    if (!programId) {
      programId = `prog_${crypto.randomUUID()}`;
      byName.set(row.program_name.trim().toLowerCase(), programId);
      statements.push(
        db.prepare("INSERT INTO programs (program_id, org_id, program_name, submission_id, is_synthetic) VALUES (?, ?, ?, ?, ?)")
          .bind(programId, org.org_id, row.program_name.trim(), submissionId, org.is_synthetic),
      );
    }
    const { cycle, issues } = cleanCycleRow({ ...row, program_id: programId }, registry);
    const key = cycleKey(org.org_id, programId, cycle.facility_code, cycle.start_date);
    if (seenKeys.has(key)) return { ok: false, status: 400, error: `${cycle.program_name} is listed twice for the same prison and start date.` };
    seenKeys.add(key);
    cycleRows.push({ id: `cyc_${crypto.randomUUID()}`, cycle, issues, blocked: issues.some(isBlocking) });
  }

  const blocked = cycleRows.some((c) => c.blocked);
  statements.unshift(
    db.prepare(
      `INSERT INTO submissions (submission_id, org_id, channel, received_at, sender_email, parser_version, llm_mapping_used, status, is_synthetic)
       VALUES (?, ?, 'form', ?, ?, 'form-1', 0, ?, ?)`,
    ).bind(submissionId, org.org_id, now, org.primary_contact_email, blocked ? "needs_info" : "awaiting_confirmation", org.is_synthetic),
  );
  for (const { id, cycle: c, issues, blocked: b } of cycleRows) {
    const key = cycleKey(org.org_id, c.program_id, c.facility_code, c.start_date);
    statements.push(
      db.prepare(
        `INSERT INTO program_cycles
           (cycle_id, cycle_key, program_id, org_id, facility_code, yard, start_date, end_date, sessions_planned,
            course_hours_planned_per_participant, n_enrolled, n_completed, total_course_hours_delivered,
            n_enrolled_approx, n_completed_approx, total_course_hours_delivered_approx,
            source_grain, status, extra, submission_id, is_synthetic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aggregate', ?, ?, ?, ?)`,
      ).bind(
        id, key, c.program_id, org.org_id, c.facility_code, c.yard, c.start_date, c.end_date, c.sessions_planned,
        c.course_hours_planned_per_participant, c.n_enrolled, c.n_completed, c.total_course_hours_delivered,
        +c.n_enrolled_approx, +c.n_completed_approx, +c.total_course_hours_delivered_approx,
        b ? "draft" : "awaiting_confirmation",
        // `_completion_rule` is staged here and applied to the program only when the CBO confirms.
        JSON.stringify({ ...c.extra, _completion_rule: c.completion_rule }),
        submissionId, org.is_synthetic,
      ),
    );
    for (const i of issues) {
      statements.push(
        db.prepare(
          `INSERT INTO field_issues (submission_id, table_name, field_name, row_ref, issue_type, raw_value, message, is_synthetic)
           VALUES (?, 'program_cycles', ?, ?, ?, ?, ?, ?)`,
        ).bind(submissionId, i.field_name, id, i.issue_type, i.raw_value, i.message, org.is_synthetic),
      );
    }
  }
  await db.batch(statements);
  return { ok: true, submission_id: submissionId, blocked };
}

export async function getSubmission(db: D1Database, token: string, submissionId: string): Promise<SubmissionView | null> {
  const org = await orgByToken(db, token);
  if (!org) return null;
  const sub = await db
    .prepare("SELECT submission_id, status FROM submissions WHERE submission_id = ? AND org_id = ? AND channel = 'form'")
    .bind(submissionId, org.org_id)
    .first<{ submission_id: string; status: string }>();
  if (!sub) return null;
  const [cycles, issues, dupes] = await Promise.all([
    db.prepare(
      `SELECT c.cycle_id, p.program_name, f.facility_name, c.start_date, c.end_date, c.n_enrolled, c.n_completed,
              c.total_course_hours_delivered, c.n_enrolled_approx, c.n_completed_approx, c.total_course_hours_delivered_approx,
              c.extra, c.status
       FROM program_cycles c JOIN programs p ON p.program_id = c.program_id
       LEFT JOIN facilities f ON f.facility_code = c.facility_code
       WHERE c.submission_id = ? ORDER BY p.program_name, c.start_date`,
    ).bind(submissionId).all<Record<string, unknown> & { extra: string }>(),
    db.prepare("SELECT issue_id, row_ref, field_name, issue_type, message FROM field_issues WHERE submission_id = ? ORDER BY issue_id")
      .bind(submissionId).all<{ issue_id: number; row_ref: string | null; field_name: string; issue_type: string; message: string }>(),
    // Same cycle_key from an earlier submission that is confirmed or waiting. Drafts with problems never count.
    db.prepare(
      `SELECT o.cycle_id, p.program_name, f.facility_name, o.start_date, o.n_enrolled, o.n_completed, o.created_at AS submitted_at
       FROM program_cycles d
       JOIN program_cycles o ON o.cycle_key = d.cycle_key AND o.cycle_id <> d.cycle_id
         AND o.submission_id IS NOT d.submission_id AND o.status IN ('confirmed','awaiting_confirmation') AND o.created_at <= d.created_at
       JOIN programs p ON p.program_id = o.program_id
       LEFT JOIN facilities f ON f.facility_code = o.facility_code
       WHERE d.submission_id = ? AND ? <> 'confirmed'
       ORDER BY o.created_at DESC`,
    ).bind(submissionId, sub.status).all<SubmissionView["duplicates"][number]>(),
  ]);
  const issueViews = issues.results.map((i) => ({ ...i, blocking: isBlocking(i as Pick<CycleIssue, "field_name" | "issue_type">) }));
  return {
    submission_id: sub.submission_id,
    status: sub.status,
    org_name: org.org_name,
    cycles: cycles.results.map((r) => {
      const extra = JSON.parse(r.extra || "{}") as Record<string, unknown>;
      return {
        cycle_id: r.cycle_id as string, program_name: r.program_name as string, facility_name: (r.facility_name as string | null) ?? null,
        start_date: (r.start_date as string | null) ?? null, end_date: (r.end_date as string | null) ?? null,
        n_enrolled: (r.n_enrolled as number | null) ?? null, n_completed: (r.n_completed as number | null) ?? null,
        total_course_hours_delivered: (r.total_course_hours_delivered as number | null) ?? null,
        n_enrolled_approx: r.n_enrolled_approx === 1, n_completed_approx: r.n_completed_approx === 1,
        total_course_hours_delivered_approx: r.total_course_hours_delivered_approx === 1,
        completion_rule: typeof extra._completion_rule === "string" ? extra._completion_rule : "unstated",
        status: r.status as string,
      };
    }),
    issues: issueViews,
    duplicates: dupes.results,
    blocked: sub.status === "needs_info" || issueViews.some((i) => i.blocking),
  };
}

export type ConfirmResult = { ok: true; already: boolean } | { ok: false; status: 404 | 409; error: string };

/**
 * The CBO confirms: draft cycles become confirmed, an earlier confirmed cycle with the same cycle_key
 * becomes superseded (never double counted), and a stated completion rule is applied to the program.
 */
export async function confirmSubmission(db: D1Database, token: string, submissionId: string): Promise<ConfirmResult> {
  const view = await getSubmission(db, token, submissionId);
  if (!view) return { ok: false, status: 404, error: "submission not found" };
  if (view.status === "confirmed") return { ok: true, already: true };
  if (view.status !== "awaiting_confirmation" || view.blocked) {
    return { ok: false, status: 409, error: "This submission has problems to fix first. Please edit the form and submit again." };
  }
  const now = new Date().toISOString();
  const { results } = await db
    .prepare("SELECT cycle_id, cycle_key, program_id, extra FROM program_cycles WHERE submission_id = ?")
    .bind(submissionId)
    .all<{ cycle_id: string; cycle_key: string; program_id: string; extra: string }>();
  const statements: D1PreparedStatement[] = [];
  for (const c of results) {
    statements.push(
      db.prepare("UPDATE program_cycles SET status = 'superseded' WHERE cycle_key = ? AND status = 'confirmed' AND cycle_id <> ?").bind(c.cycle_key, c.cycle_id),
      db.prepare("UPDATE program_cycles SET status = 'confirmed' WHERE cycle_id = ?").bind(c.cycle_id),
    );
    const rule = (JSON.parse(c.extra || "{}") as { _completion_rule?: string })._completion_rule;
    if (rule && rule !== "unstated") statements.push(db.prepare("UPDATE programs SET completion_rule = ? WHERE program_id = ?").bind(rule, c.program_id));
  }
  statements.push(db.prepare("UPDATE submissions SET status = 'confirmed', confirmed_by_cbo_at = ? WHERE submission_id = ?").bind(now, submissionId));
  await db.batch(statements);
  return { ok: true, already: false };
}
