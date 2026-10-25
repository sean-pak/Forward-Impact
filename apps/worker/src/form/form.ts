import { z } from "zod";
import {
  FACILITIES,
  cleanCycleRow,
  cycleKey,
  isBlankRow,
  isBlocking,
  missingCompletedIssue,
  needsCompletedCount,
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

export type OrgRow = { org_id: string; org_name: string; primary_contact_email: string; is_synthetic: number };

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

export async function registryFields(db: D1Database): Promise<RegistryField[]> {
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

export type WriteOptions = {
  channel: "form" | "email_body" | "email_attachment" | "manual";
  parserVersion: string;
  llmMappingUsed: boolean;
  detectedPersona: number | null;
  senderEmail: string;
  /** Issues found before cleaning (for example a count the text never stated), aligned with `rows`. */
  preIssues?: CycleIssue[][];
  /** A repeated cycle key in one file: the form rejects it, ingest keeps the row and flags it. */
  duplicates: "reject" | "flag";
  /** Ask about a blank completed count on finished cycles. Email and upload only; the form lets it stay blank. */
  askMissingCompleted?: boolean;
};

export type WriteResult =
  | { ok: true; submission_id: string; blocked: boolean; cycle_ids: string[] }
  | { ok: false; status: 400; error: string };

/**
 * Writes the submission, draft cycles and issues in one batch. Nothing counts until the CBO confirms.
 * Shared by the form and by email / upload ingest so both produce the same rows.
 */
export async function writeSubmission(db: D1Database, org: OrgRow, rows: CycleFormRow[], opts: WriteOptions): Promise<WriteResult> {
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

  for (const [n, row] of rows.entries()) {
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
    issues.unshift(...(opts.preIssues?.[n] ?? []));
    if (opts.askMissingCompleted && needsCompletedCount(cycle, now.slice(0, 10))) issues.push(missingCompletedIssue(cycle));
    const key = cycleKey(org.org_id, programId, cycle.facility_code, cycle.start_date);
    if (seenKeys.has(key)) {
      if (opts.duplicates === "reject") return { ok: false, status: 400, error: `${cycle.program_name} is listed twice for the same prison and start date.` };
      issues.push({
        field_name: "start_date", issue_type: "conflict", raw_value: cycle.start_date,
        message: `${cycle.program_name} appears twice for the same prison and start date. Which one is right?`,
      });
    }
    seenKeys.add(key);
    cycleRows.push({ id: `cyc_${crypto.randomUUID()}`, cycle, issues, blocked: issues.some(isBlocking) });
  }

  const blocked = cycleRows.some((c) => c.blocked);
  statements.unshift(
    db.prepare(
      `INSERT INTO submissions (submission_id, org_id, channel, received_at, sender_email, detected_persona, parser_version, llm_mapping_used, status, is_synthetic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      submissionId, org.org_id, opts.channel, now, opts.senderEmail, opts.detectedPersona, opts.parserVersion,
      +opts.llmMappingUsed, blocked ? "needs_info" : "awaiting_confirmation", org.is_synthetic,
    ),
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
  return { ok: true, submission_id: submissionId, blocked, cycle_ids: cycleRows.map((c) => c.id) };
}

export async function submitForm(db: D1Database, token: string, rows: CycleFormRow[]): Promise<SubmitResult> {
  const org = await orgByToken(db, token);
  if (!org) return { ok: false, status: 404, error: "unknown form link" };
  // A row with no dates or counts is a pre-filled program the CBO skipped.
  const filled = rows.filter((r) => !isBlankRow(r));
  if (filled.length === 0) return { ok: false, status: 400, error: "Fill in at least one program's dates and counts." };
  const r = await writeSubmission(db, org, filled, {
    channel: "form", parserVersion: "form-1", llmMappingUsed: false, detectedPersona: null, senderEmail: org.primary_contact_email, duplicates: "reject",
  });
  return r.ok ? { ok: true, submission_id: r.submission_id, blocked: r.blocked } : r;
}

export async function getSubmission(db: D1Database, token: string, submissionId: string): Promise<SubmissionView | null> {
  const org = await orgByToken(db, token);
  if (!org) return null;
  const sub = await db
    .prepare("SELECT submission_id, status FROM submissions WHERE submission_id = ? AND org_id = ? AND channel = 'form'")
    .bind(submissionId, org.org_id)
    .first<{ submission_id: string; status: string }>();
  return sub ? submissionView(db, org, sub) : null;
}

/** Staff view of any submission, whatever channel it came in on. */
export async function adminSubmission(db: D1Database, submissionId: string): Promise<(SubmissionView & { channel: string; received_at: string; detected_persona: number | null; llm_mapping_used: boolean }) | null> {
  const sub = await db
    .prepare(
      `SELECT s.submission_id, s.status, s.channel, s.received_at, s.detected_persona, s.llm_mapping_used, o.org_id, o.org_name, o.primary_contact_email, o.is_synthetic
       FROM submissions s JOIN orgs o ON o.org_id = s.org_id WHERE s.submission_id = ?`,
    )
    .bind(submissionId)
    .first<{ submission_id: string; status: string; channel: string; received_at: string; detected_persona: number | null; llm_mapping_used: number } & OrgRow>();
  if (!sub) return null;
  const view = await submissionView(db, sub, sub);
  return { ...view, channel: sub.channel, received_at: sub.received_at, detected_persona: sub.detected_persona, llm_mapping_used: sub.llm_mapping_used === 1 };
}

export async function listSubmissions(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT s.submission_id, s.channel, s.status, s.received_at, s.detected_persona, o.org_name,
              (SELECT count(*) FROM program_cycles c WHERE c.submission_id = s.submission_id) AS n_cycles,
              (SELECT count(*) FROM field_issues i WHERE i.submission_id = s.submission_id AND i.resolved = 0) AS n_issues
       FROM submissions s JOIN orgs o ON o.org_id = s.org_id ORDER BY s.received_at DESC LIMIT 100`,
    )
    .all<{ submission_id: string; channel: string; status: string; received_at: string; detected_persona: number | null; org_name: string; n_cycles: number; n_issues: number }>();
  return results;
}

async function submissionView(db: D1Database, org: OrgRow, sub: { submission_id: string; status: string }): Promise<SubmissionView> {
  const submissionId = sub.submission_id;
  const [cycles, issues, dupes] = await Promise.all([
    db.prepare(
      `SELECT c.cycle_id, p.program_name, f.facility_name, c.start_date, c.end_date, c.n_enrolled, c.n_completed,
              c.total_course_hours_delivered, c.n_enrolled_approx, c.n_completed_approx, c.total_course_hours_delivered_approx,
              c.extra, c.status
       FROM program_cycles c JOIN programs p ON p.program_id = c.program_id
       LEFT JOIN facilities f ON f.facility_code = c.facility_code
       WHERE c.submission_id = ? ORDER BY p.program_name, c.start_date`,
    ).bind(submissionId).all<Record<string, unknown> & { extra: string }>(),
    db.prepare("SELECT issue_id, row_ref, field_name, issue_type, message FROM field_issues WHERE submission_id = ? AND resolved = 0 ORDER BY issue_id")
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
  return applyConfirm(db, view);
}

/** Confirm by submission id, for the email path (the form path checks its token first). */
export async function confirmById(db: D1Database, submissionId: string): Promise<ConfirmResult> {
  const sub = await db
    .prepare(
      `SELECT s.submission_id, s.status, o.org_id, o.org_name, o.primary_contact_email, o.is_synthetic
       FROM submissions s JOIN orgs o ON o.org_id = s.org_id WHERE s.submission_id = ?`,
    )
    .bind(submissionId)
    .first<{ submission_id: string; status: string } & OrgRow>();
  if (!sub) return { ok: false, status: 404, error: "submission not found" };
  return applyConfirm(db, await submissionView(db, sub, sub));
}

async function applyConfirm(db: D1Database, view: SubmissionView): Promise<ConfirmResult> {
  const submissionId = view.submission_id;
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
  statements.push(db.prepare("UPDATE submissions SET status = 'confirmed', open_question = NULL, confirmed_by_cbo_at = ? WHERE submission_id = ?").bind(now, submissionId));
  await db.batch(statements);
  return { ok: true, already: false };
}
