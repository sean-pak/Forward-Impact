import {
  APPROX_FIELDS, FACILITIES, LegendAnswerSchema, ReplyClassificationSchema, UNNAMED_PROGRAM, clarifyEmail, confirmReceiptEmail, cycleKey, deriveCycles,
  escalatedEmail, facilityName, individualNoteLines, isAnswerable, isPlainNo, isPlainYes, isSyntheticEmail, normalizeMark, numberAppearsIn, openMarks,
  overlayAnswer, parseCompletionRule, pickQuestion, replySubject, scrubIdentifiers, stripQuoted, suggestFacility, thanksEmail, toFormRow, unresolvedPair,
  type AttendanceResult, type Candidate, type CycleFormRow, type DerivedCycle, type IndividualExtra, type Meaning, type Question, type RegistryField,
  type ReplyClassification, type StoredCycle,
} from "@tpw/shared";
import { confirmById, registryFields } from "../form";
import type { Gmail } from "../gmail";
import { attendanceFor, attendanceWrites, loadAttendance, type AttendanceCycle } from "../individual/recompute";
import type { Llm } from "../llm";
import { orgReportUrl } from "../report";
import { LEGEND_SYSTEM, REPLY_SYSTEM } from "./prompts";

/** Clarification emails per submission (PRD 7.7). After this, blocking problems go to staff. */
export const MAX_ROUNDS = 2;
const GIVE_UP_AFTER_MS = 60 * 60 * 1000;
const COUNT_FIELDS = ["n_enrolled", "n_completed", "total_course_hours_delivered", "sessions_planned"];

export type Inbound = {
  gmailId: string;
  threadId: string;
  from: string;
  /** Used only to build "Re: ..." for the reply; never stored. */
  subject: string;
  text: string;
  rfcMessageId: string | null;
  references: string | null;
  occurredAt: string;
};

/** `webUrl` builds the private report link in the receipt and thanks emails; left out, the emails carry no link. */
export type Deps = { db: D1Database; gmail: Gmail; llm: Llm; webUrl?: string };

export type OpenQuestion = { kind: Question["kind"] | "confirm"; field_name: string; cycle_ids: string[]; text: string; suggestion?: string };

type SubRow = {
  submission_id: string; org_id: string; org_name: string; status: string; followup_rounds: number; open_question: string | null; is_synthetic: number;
  scrambled_names: number; scrambled_cdcr: number;
};
type State = { sub: SubRow; oq: OpenQuestion | null; stored: StoredCycle[]; registry: RegistryField[]; attendance: Map<string, AttendanceCycle> };

export type Outcome = { action: "ask" | "receipt" | "escalate" | "confirmed" | "ignored"; question?: string };

/** The emailed submission in this thread that is waiting on a reply, if any. */
export async function activeSubmissionForThread(db: D1Database, threadId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT submission_id FROM submissions
       WHERE open_question IS NOT NULL AND status IN ('needs_info','awaiting_confirmation')
         AND submission_id IN (SELECT submission_id FROM messages WHERE gmail_thread_id = ? AND submission_id IS NOT NULL)
       ORDER BY received_at DESC LIMIT 1`,
    )
    .bind(threadId)
    .first<{ submission_id: string }>();
  return row?.submission_id ?? null;
}

async function loadState(db: D1Database, submissionId: string): Promise<State | null> {
  const sub = await db
    .prepare(
      `SELECT s.submission_id, s.org_id, o.org_name, s.status, s.followup_rounds, s.open_question, s.is_synthetic, s.scrambled_names, s.scrambled_cdcr
       FROM submissions s JOIN orgs o ON o.org_id = s.org_id WHERE s.submission_id = ?`,
    )
    .bind(submissionId)
    .first<SubRow>();
  if (!sub) return null;
  const [cycles, raws, registry] = await Promise.all([
    db.prepare(
      `SELECT c.cycle_id, c.program_id, p.program_name, c.facility_code, c.yard, c.start_date, c.end_date, c.sessions_planned,
              c.course_hours_planned_per_participant, c.n_enrolled, c.n_completed, c.total_course_hours_delivered,
              c.n_enrolled_approx, c.n_completed_approx, c.total_course_hours_delivered_approx, c.extra, c.source_grain
       FROM program_cycles c JOIN programs p ON p.program_id = c.program_id
       WHERE c.submission_id = ? ORDER BY c.rowid`,
    ).bind(submissionId).all<Record<string, unknown> & { extra: string }>(),
    db.prepare("SELECT row_ref, raw_value FROM field_issues WHERE submission_id = ? AND resolved = 0 AND field_name = 'facility_code'")
      .bind(submissionId).all<{ row_ref: string; raw_value: string | null }>(),
    registryFields(db),
  ]);
  const rawFacility = new Map(raws.results.map((r) => [r.row_ref, r.raw_value]));
  const stored = cycles.results.map((r): StoredCycle => ({
    cycle_id: r.cycle_id as string, program_id: r.program_id as string, program_name: r.program_name as string,
    facility_code: (r.facility_code as string | null) ?? null, facility_raw: rawFacility.get(r.cycle_id as string) ?? null,
    yard: (r.yard as string | null) ?? null, start_date: (r.start_date as string | null) ?? null, end_date: (r.end_date as string | null) ?? null,
    sessions_planned: (r.sessions_planned as number | null) ?? null,
    course_hours_planned_per_participant: (r.course_hours_planned_per_participant as number | null) ?? null,
    n_enrolled: (r.n_enrolled as number | null) ?? null, n_completed: (r.n_completed as number | null) ?? null,
    total_course_hours_delivered: (r.total_course_hours_delivered as number | null) ?? null,
    n_enrolled_approx: r.n_enrolled_approx === 1, n_completed_approx: r.n_completed_approx === 1,
    total_course_hours_delivered_approx: r.total_course_hours_delivered_approx === 1,
    source_grain: r.source_grain as StoredCycle["source_grain"],
    extra: JSON.parse(r.extra || "{}") as Record<string, unknown>,
  }));
  const attendance = await loadAttendance(db, stored.filter((c) => c.extra._individual === "attendance").map((c) => c.cycle_id));
  return { sub, oq: sub.open_question ? (JSON.parse(sub.open_question) as OpenQuestion) : null, stored, registry, attendance };
}

const askedApprox = (extra: Record<string, unknown>): string[] => (Array.isArray(extra._approx_asked) ? (extra._approx_asked as string[]) : []);

const FIELD_LABEL: Record<string, string> = {
  n_enrolled: "People enrolled", n_completed: "People completed", completion_rule: "What counts as completing",
  start_date: "Start date", end_date: "End date", facility_code: "Prison",
  attendance_legend: "What your attendance marks mean", late_counts: "Whether a late counts as attended",
  duplicate_person: "Whether two lines are the same person", program_name: "Program name",
};

function candidates(derived: DerivedCycle[], stored: StoredCycle[]): Candidate[] {
  const byId = new Map(stored.map((c) => [c.cycle_id, c]));
  const out: Candidate[] = [];
  for (const d of derived) {
    const base = { cycle_id: d.cycle_id, program_id: d.cycle.program_id, program_name: d.cycle.program_name, facility_name: facilityName(d.cycle.facility_code), start_date: d.cycle.start_date };
    for (const i of d.issues) {
      const suggested = i.field_name === "facility_code" && i.issue_type === "missing_required" ? suggestFacility(d.cycle_id, derived) : null;
      out.push({ ...base, kind: "issue", field_name: i.field_name, issue_type: i.issue_type, message: i.message, ...(suggested ? { suggested_facility: suggested } : {}) });
    }
    const asked = askedApprox(byId.get(d.cycle_id)!.extra);
    const flags: Record<string, boolean> = {
      n_enrolled: d.cycle.n_enrolled_approx, n_completed: d.cycle.n_completed_approx, total_course_hours_delivered: d.cycle.total_course_hours_delivered_approx,
    };
    for (const f of APPROX_FIELDS) {
      const n = d.cycle[f];
      if (flags[f] && n !== null && !asked.includes(f)) out.push({ ...base, kind: "approx", field_name: f, issue_type: null, message: String(n) });
    }
  }
  return out;
}

function openLabel(c: Candidate): string {
  // The rule belongs to the program, so it is listed once per program, not per cycle.
  if (c.field_name === "completion_rule") return `What counts as completing ${c.program_name}`;
  const label = FIELD_LABEL[c.field_name] ?? c.field_name.replace(/_/g, " ");
  return `${label} for ${c.program_name}${c.facility_name ? ` at ${c.facility_name}` : ""}${c.start_date ? `, started ${c.start_date}` : ""}`;
}

type Change = { overrides?: Map<string, CycleFormRow>; retry?: boolean; updated?: boolean; unchanged?: boolean; expectedLeftOut?: boolean };

/**
 * One turn of the conversation. Re-derives every cycle from what is stored (plus this reply's answer), then picks the
 * single next step: one question, the receipt, or staff. Sends the email first and writes after it, so a failed send
 * leaves nothing half-applied and the next sync tries the same message again.
 */
async function turn(deps: Deps, st: State, inbound: Inbound, change: Change = {}): Promise<Outcome> {
  const { db } = deps;
  const today = new Date().toISOString().slice(0, 10);
  // A sheet of marks gets its counts from the people, so rebuild them from the stored marks and the answers so far.
  const overrides = new Map(change.overrides);
  const attendance = new Map<string, AttendanceResult>();
  for (const c of st.stored) {
    const data = st.attendance.get(c.cycle_id);
    if (c.extra._individual !== "attendance" || !data) continue;
    const row = overrides.get(c.cycle_id) ?? toFormRow(c);
    const res = attendanceFor(data, c.extra as IndividualExtra, row.completion_rule || "unstated");
    attendance.set(c.cycle_id, res);
    overrides.set(c.cycle_id, {
      ...row, n_enrolled: String(res.nEnrolled), n_completed: res.nCompleted === null ? "" : String(res.nCompleted),
      n_enrolled_approx: false, n_completed_approx: false,
    });
  }
  const derived = deriveCycles(st.sub.org_id, st.stored, st.registry, today, overrides);
  const dynamicNotes: Record<string, number> = {};
  for (const [id, res] of attendance) {
    const rule = derived.find((d) => d.cycle_id === id)!.cycle.completion_rule;
    dynamicNotes.conflicting_completed = (dynamicNotes.conflicting_completed ?? 0) + res.conflicts;
    if (rule !== "unstated" && !parseCompletionRule(rule)) dynamicNotes.rule_unreadable = (dynamicNotes.rule_unreadable ?? 0) + 1;
  }
  const cands = candidates(derived, st.stored);
  const blocked = derived.some((d) => d.blocked);
  const q = pickQuestion(cands);
  const rounds = st.sub.followup_rounds;
  const action: Outcome["action"] = q && rounds < MAX_ROUNDS ? "ask" : blocked ? "escalate" : "receipt";

  const repeated = !!(q && st.oq && st.oq.kind === q.kind && st.oq.field_name === q.field_name && q.cycle_ids.some((id) => st.oq!.cycle_ids.includes(id)));
  let kind: "clarify" | "confirm_receipt" | "escalated";
  let body;
  let openQuestion: OpenQuestion | null;
  if (action === "ask") {
    kind = "clarify";
    body = clarifyEmail({ question: q!.text, retry: change.retry || repeated });
    openQuestion = { kind: q!.kind, field_name: q!.field_name, cycle_ids: q!.cycle_ids, text: q!.text, ...(q!.suggestion ? { suggestion: q!.suggestion } : {}) };
  } else if (action === "escalate") {
    kind = "escalated";
    body = escalatedEmail();
    openQuestion = null;
  } else {
    kind = "confirm_receipt";
    const reportUrl = await orgReportUrl(db, deps.webUrl, st.sub.org_id);
    body = confirmReceiptEmail({
      orgName: st.sub.org_name,
      cycles: derived.map((d) => ({
        program_name: d.cycle.program_name, facility_name: facilityName(d.cycle.facility_code), start_date: d.cycle.start_date,
        n_enrolled: d.cycle.n_enrolled, n_enrolled_approx: d.cycle.n_enrolled_approx,
        n_completed: d.cycle.n_completed, n_completed_approx: d.cycle.n_completed_approx, completion_rule: d.cycle.completion_rule,
      })),
      open: [...new Set(cands.filter((c) => c.kind === "issue").map(openLabel))],
      scrambled: { names: st.sub.scrambled_names, cdcr: st.sub.scrambled_cdcr },
      notes: individualNoteLines([...st.stored.map((c) => (c.extra._notes ?? {}) as Record<string, number>), dynamicNotes]),
      updated: change.updated,
      unchanged: change.unchanged,
      expectedLeftOut: change.expectedLeftOut,
      reportUrl,
    });
    openQuestion = { kind: "confirm", field_name: "", cycle_ids: derived.map((d) => d.cycle_id), text: "Reply YES to confirm" };
  }

  let sent: { id: string; threadId: string } | null = null;
  if (!isSyntheticEmail(inbound.from)) {
    sent = await deps.gmail.send({
      to: inbound.from, subject: replySubject(inbound.subject), text: body.text, html: body.html, threadId: inbound.threadId,
      inReplyTo: inbound.rfcMessageId ?? undefined,
      references: [inbound.references, inbound.rfcMessageId].filter(Boolean).join(" ") || undefined,
    });
  }

  const askedNow = action === "ask" && q!.kind === "approx" ? new Set(q!.cycle_ids) : new Set<string>();
  const statements: D1PreparedStatement[] = [];
  for (const d of derived) {
    const old = st.stored.find((c) => c.cycle_id === d.cycle_id)!;
    const kept = Object.fromEntries(Object.entries(old.extra).filter(([k]) => k.startsWith("_")));
    const asked = [...new Set([...askedApprox(old.extra), ...(askedNow.has(d.cycle_id) ? [q!.field_name] : [])])];
    const c = d.cycle;
    statements.push(
      db.prepare(
        `UPDATE program_cycles SET cycle_key = ?, facility_code = ?, yard = ?, start_date = ?, end_date = ?, sessions_planned = ?,
           course_hours_planned_per_participant = ?, n_enrolled = ?, n_completed = ?, total_course_hours_delivered = ?,
           n_enrolled_approx = ?, n_completed_approx = ?, total_course_hours_delivered_approx = ?, status = ?, extra = ?
         WHERE cycle_id = ?`,
      ).bind(
        cycleKey(st.sub.org_id, c.program_id, c.facility_code, c.start_date), c.facility_code, c.yard, c.start_date, c.end_date, c.sessions_planned,
        c.course_hours_planned_per_participant, c.n_enrolled, c.n_completed, c.total_course_hours_delivered,
        +c.n_enrolled_approx, +c.n_completed_approx, +c.total_course_hours_delivered_approx, d.blocked ? "draft" : "awaiting_confirmation",
        JSON.stringify({ ...kept, ...c.extra, _completion_rule: c.completion_rule, _approx_asked: asked }), d.cycle_id,
      ),
    );
    // The CBO named a program Sam could not name. Only a program this submission created, and only from "Unnamed program".
    if (old.program_name === UNNAMED_PROGRAM && c.program_name !== UNNAMED_PROGRAM) {
      statements.push(db.prepare("UPDATE programs SET program_name = ? WHERE program_id = ? AND submission_id = ?").bind(c.program_name, c.program_id, st.sub.submission_id));
    }
    const res = attendance.get(d.cycle_id);
    if (res) statements.push(...attendanceWrites(db, st.attendance.get(d.cycle_id)!, old.extra as IndividualExtra, res));
  }
  statements.push(db.prepare("UPDATE field_issues SET resolved = 1 WHERE submission_id = ? AND resolved = 0").bind(st.sub.submission_id));
  for (const d of derived) {
    for (const i of d.issues) {
      const isAsked = action === "ask" && q!.kind === "issue" && q!.field_name === i.field_name && q!.cycle_ids.includes(d.cycle_id);
      statements.push(
        db.prepare(
          `INSERT INTO field_issues (submission_id, table_name, field_name, row_ref, issue_type, raw_value, message, question_asked, is_synthetic)
           VALUES (?, 'program_cycles', ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(st.sub.submission_id, i.field_name, d.cycle_id, i.issue_type, i.raw_value, i.message, isAsked ? q!.text : null, st.sub.is_synthetic),
      );
    }
  }
  statements.push(
    db.prepare("UPDATE submissions SET status = ?, followup_rounds = ?, open_question = ? WHERE submission_id = ?").bind(
      action === "escalate" ? "needs_staff" : blocked ? "needs_info" : "awaiting_confirmation",
      rounds + (action === "ask" ? 1 : 0), openQuestion ? JSON.stringify(openQuestion) : null, st.sub.submission_id,
    ),
  );
  statements.push(...messageBookkeeping(db, deps.gmail.mailbox, st, inbound, sent, kind));
  await db.batch(statements);
  return { action, question: action === "ask" ? q!.text : undefined };
}

/** The inbound message belongs to this submission now, and our reply (if sent) is logged as metadata only. */
function messageBookkeeping(db: D1Database, mailbox: string, st: State, inbound: Inbound, sent: { id: string; threadId: string } | null, kind: string): D1PreparedStatement[] {
  const out = [db.prepare("UPDATE messages SET submission_id = ? WHERE message_id = ?").bind(st.sub.submission_id, inbound.gmailId)];
  if (sent) {
    out.push(
      db.prepare(
        `INSERT OR IGNORE INTO messages (message_id, gmail_thread_id, direction, kind, org_id, submission_id, from_email, to_email, occurred_at, is_synthetic)
         VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(sent.id, sent.threadId, kind, st.sub.org_id, st.sub.submission_id, mailbox, inbound.from, new Date().toISOString(), st.sub.is_synthetic),
    );
  }
  return out;
}

/** First email after new data arrives: the first question, or straight to the receipt when nothing is missing. */
export async function startConversation(deps: Deps, submissionId: string, inbound: Inbound): Promise<Outcome> {
  const st = await loadState(deps.db, submissionId);
  // A started conversation (open_question set) is never restarted: the retry of a failed pass must not ask twice.
  if (!st || st.oq || st.sub.status === "needs_staff" || st.stored.length === 0) return { action: "ignored" };
  return turn(deps, st, inbound);
}

/** Cycles the writer means by a hint like "the San Quentin one" or "Writing Class". Only a single best match counts. */
function matchCycles(stored: StoredCycle[], hint: string | null): StoredCycle[] {
  if (stored.length === 1) return stored;
  const h = (hint ?? "").toLowerCase();
  if (!h) return [];
  const scored = stored.map((c) => {
    const fac = FACILITIES.find((f) => f.facility_code === c.facility_code);
    const names = fac ? [fac.facility_name, fac.facility_code, ...fac.aliases].map((n) => n.toLowerCase()) : [];
    return {
      c,
      score:
        (h.includes(c.program_name.toLowerCase()) ? 1 : 0) +
        (names.some((n) => n.length > 2 && h.includes(n)) ? 1 : 0) +
        (c.start_date && h.includes(c.start_date) ? 1 : 0),
    };
  });
  const best = Math.max(...scored.map((x) => x.score));
  const top = scored.filter((x) => x.score === best);
  return best > 0 && top.length === 1 ? [top[0]!.c] : [];
}

/** A count the reply does not contain is dropped, as in text ingest. Other fields are checked by the cleaner. */
function supported(field: string, value: string, text: string): boolean {
  if (!COUNT_FIELDS.includes(field)) return true;
  const n = Number(value.replace(/,/g, ""));
  return Number.isFinite(n) ? numberAppearsIn(n, text) : true;
}

const INDIVIDUAL_FIELDS = ["attendance_legend", "late_counts", "duplicate_person"];

/**
 * A reply about attendance marks, whether a late counts, or two lines that may be one person. A plain YES or NO
 * settles the late and duplicate questions without a model. For marks, the model only reads the meanings; code keeps
 * the ones Sam asked about, and nothing else changes.
 */
async function individualReply(deps: Deps, st: State, inbound: Inbound, oq: OpenQuestion, text: string): Promise<Outcome> {
  const cycle = st.stored.find((c) => c.cycle_id === oq.cycle_ids[0]);
  if (!cycle) return { action: "ignored" };
  const extra = cycle.extra as IndividualExtra;
  const patch: Record<string, unknown> = {};
  const plain = isPlainYes(text) ? true : isPlainNo(text) ? false : null;

  if (oq.field_name === "duplicate_person") {
    const pair = unresolvedPair(extra);
    if (pair && plain !== null) patch._dup_resolved = { ...(extra._dup_resolved ?? {}), [pair.id]: plain ? "same" : "different" };
  } else {
    const open = openMarks(extra);
    let late: boolean | null = null;
    const marks: Record<string, Meaning> = {};
    if (oq.field_name === "late_counts" && plain !== null) {
      late = plain;
    } else if (text) {
      try {
        const answer = await deps.llm.json({
          name: "classify_legend", system: LEGEND_SYSTEM, schema: LegendAnswerSchema,
          user: JSON.stringify({ marks_asked: open, reply: text }),
        });
        for (const m of answer.marks) {
          const mark = normalizeMark(m.mark);
          if (open.includes(mark) && m.meaning !== "unknown") marks[mark] = m.meaning;
        }
        late = answer.late_counts_as_attended;
      } catch (e) {
        // A model outage is retried by the next sync; after an hour the reply counts as unclear so the round limit can finish the job.
        if (Date.now() - Date.parse(inbound.occurredAt) < GIVE_UP_AFTER_MS) throw e;
      }
    }
    if (Object.keys(marks).length) patch._legend = { ...(extra._legend ?? {}), ...marks };
    if (late !== null) patch._late_counts = late;
  }

  const applied = Object.keys(patch).length > 0;
  const stored = st.stored.map((c) => (c.cycle_id === cycle.cycle_id ? { ...c, extra: { ...c.extra, ...patch } } : c));
  return turn(deps, { ...st, stored }, inbound, { retry: !applied });
}

/**
 * A reply to Sam's question (PRD 7.5). The model only classifies; code decides whether the value is allowed,
 * validates it, applies it, then asks the next question or sends the receipt. A plain YES never reaches the model.
 */
export async function handleReply(deps: Deps, submissionId: string, inbound: Inbound): Promise<Outcome> {
  const st = await loadState(deps.db, submissionId);
  if (!st || !st.oq) return { action: "ignored" };
  const oq = st.oq;
  const text = scrubIdentifiers(stripQuoted(inbound.text)).slice(0, 2000);
  if (oq.kind === "issue" && INDIVIDUAL_FIELDS.includes(oq.field_name)) return individualReply(deps, st, inbound, oq, text);

  const none: ReplyClassification = { intent: "unclear", field_key: null, value: null, approx: false, cycle_hint: null, also: [], expected_numbers: false };
  // "Did it also run at San Quentin?" -> "Yes": the offered prison, no model needed.
  const suggested = oq.suggestion ? facilityName(oq.suggestion) : null;
  let found: ReplyClassification | null =
    isPlainYes(text) && oq.kind === "confirm" ? { ...none, intent: "confirm" }
    : isPlainYes(text) && suggested ? { ...none, intent: "answer", field_key: "facility_code", value: suggested }
    : null;
  if (!found && text) {
    try {
      found = await deps.llm.json({
        name: "classify_reply", system: REPLY_SYSTEM, schema: ReplyClassificationSchema,
        user: JSON.stringify({
          open_question: { kind: oq.kind, field_key: oq.field_name || null, text: oq.text },
          programs: [...new Set(st.stored.map((c) => c.program_name))],
          reply: text,
        }),
      });
    } catch (e) {
      // A model outage is retried by the next sync; after an hour the reply counts as unclear so the round limit can finish the job.
      if (Date.now() - Date.parse(inbound.occurredAt) < GIVE_UP_AFTER_MS) throw e;
    }
  }
  const cls = found ?? none;
  if (suggested && cls.intent === "answer" && cls.value && isPlainYes(cls.value)) cls.value = suggested;
  const before = deriveCycles(st.sub.org_id, st.stored, st.registry, new Date().toISOString().slice(0, 10));

  // Confirm: only when nothing blocks and the reply brings no new facts. Anything else about a "yes" is not a confirmation.
  if (cls.intent === "confirm" && oq.kind === "confirm" && cls.also.length === 0) {
    if (!before.some((d) => d.blocked)) {
      if (!isSyntheticEmail(inbound.from)) {
        const body = thanksEmail({ orgName: st.sub.org_name, reportUrl: await orgReportUrl(deps.db, deps.webUrl, st.sub.org_id) });
        const sent = await deps.gmail.send({
          to: inbound.from, subject: replySubject(inbound.subject), text: body.text, html: body.html, threadId: inbound.threadId,
          inReplyTo: inbound.rfcMessageId ?? undefined,
          references: [inbound.references, inbound.rfcMessageId].filter(Boolean).join(" ") || undefined,
        });
        await deps.db.batch(messageBookkeeping(deps.db, deps.gmail.mailbox, st, inbound, sent, "thanks"));
      } else {
        await deps.db.batch(messageBookkeeping(deps.db, deps.gmail.mailbox, st, inbound, null, "thanks"));
      }
      const r = await confirmById(deps.db, submissionId);
      if (!r.ok) throw new Error(r.error);
      return { action: "confirmed" };
    }
  }

  const overrides = new Map<string, CycleFormRow>();
  // Several changes can touch one cycle, so each builds on the last one applied.
  const put = (ids: string[], field: string, value: string, approx: boolean): boolean => {
    const next = new Map<string, CycleFormRow>();
    for (const id of ids) {
      const c = st.stored.find((x) => x.cycle_id === id);
      const row = c && overlayAnswer(overrides.get(id) ?? toFormRow(c), field, value, approx, st.registry);
      if (!row) return false;
      next.set(id, row);
    }
    for (const [id, row] of next) overrides.set(id, row);
    return ids.length > 0;
  };

  /** A fact the writer gave or changed without being asked. Applies only when it points at one cycle (or one program, for a rule). */
  const correct = (c: { field_key: string | null; value: string | null; approx: boolean; cycle_hint: string | null }): boolean => {
    if (!c.field_key || !c.value || !isAnswerable(c.field_key, st.registry) || !supported(c.field_key, c.value, text)) return false;
    // An expected number is not a count; the model is told so, and code holds the line too.
    if (cls.expected_numbers && c.field_key === "n_completed") return false;
    const ids = targetCycles(st.stored, before, c.field_key, c.cycle_hint);
    return ids.length > 0 && put(ids, c.field_key, c.value, c.approx);
  };

  let applied = false;
  if (cls.intent === "answer" && oq.kind !== "confirm") {
    if (oq.field_name === "completion_rule") {
      // The rule belongs to the program, so one answer covers every cycle of it in this submission.
      const programs = new Set(oq.cycle_ids.map((id) => st.stored.find((c) => c.cycle_id === id)?.program_id));
      const ids = st.stored.filter((c) => programs.has(c.program_id)).map((c) => c.cycle_id);
      if (cls.value) applied = put(ids, "completion_rule", cls.value, false);
    } else if (oq.kind === "approx") {
      // "About 30 is fine" keeps the approximate count; an exact number replaces it.
      if (cls.value && !cls.approx && supported(oq.field_name, cls.value, text)) applied = put(oq.cycle_ids, oq.field_name, cls.value, false);
      else applied = true; // the question was answered; the flag stays and is not asked again
    } else if (cls.value && supported(oq.field_name, cls.value, text)) {
      applied = put(oq.cycle_ids, oq.field_name, cls.value, cls.approx);
    }
  } else if (cls.intent === "correction") {
    applied = correct(cls);
  }
  // A reply can carry more than one fact ("the rule is 80%, and the fall count is 25").
  let alsoApplied = false;
  if (cls.intent !== "unclear") for (const c of cls.also) alsoApplied = correct(c) || alsoApplied;

  const changed = applied || alsoApplied;
  return turn(deps, st, inbound, {
    overrides,
    retry: !applied && oq.kind !== "confirm",
    updated: changed && oq.kind === "confirm",
    unchanged: !changed && oq.kind === "confirm",
    expectedLeftOut: cls.expected_numbers,
  });
}

/**
 * The cycles a correction is about. A hint that names one cycle wins. Without one, a completion rule goes to the only
 * program in the submission, and any other field goes to the one cycle still missing it. Anything wider is not guessed.
 * A completion rule covers every cycle of its program.
 */
function targetCycles(stored: StoredCycle[], derived: DerivedCycle[], field: string, hint: string | null): string[] {
  let hits = matchCycles(stored, hint);
  if (hits.length === 0) {
    const open = stored.filter((c) => derived.find((d) => d.cycle_id === c.cycle_id)?.issues.some((i) => i.field_name === field));
    const programs = (cs: StoredCycle[]) => new Set(cs.map((c) => c.program_id));
    if (field === "completion_rule") {
      if (programs(stored).size === 1) hits = stored;
      else if (programs(open).size === 1) hits = open;
    } else if (open.length === 1) {
      hits = open;
    }
  }
  if (field === "completion_rule" && hits.length > 0) {
    const ps = new Set(hits.map((c) => c.program_id));
    return ps.size === 1 ? stored.filter((c) => ps.has(c.program_id)).map((c) => c.cycle_id) : [];
  }
  return hits.length === 1 ? [hits[0]!.cycle_id] : [];
}

export type { DerivedCycle };
