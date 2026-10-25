import PostalMime from "postal-mime";
import { hasNumber, stripQuoted } from "@tpw/shared";
import { ingest, type IngestInput, type IngestMeta } from "../ingest";
import { OpenRouterLlm, type Llm, type LlmEnv } from "../llm";
import { markReplied } from "../outreach/track";
import type { OrgRow } from "../form";
import { Gmail, LABEL_IGNORED, LABEL_PROCESSED, type GmailEnv } from "./client";

export type SyncResult = { logged: number; ignored: number; skipped: number; ingested: number };

const GIVE_UP_AFTER_MS = 60 * 60 * 1000;
const ATTACHMENT = /\.(csv|xlsx|docx)$/i;

type Part = { input: IngestInput; channel: IngestMeta["channel"] };

/** Attachments win over the body (the body is then a cover note). A body counts only if it holds numbers. */
function dataParts(parsed: Awaited<ReturnType<typeof PostalMime.parse>>): Part[] {
  const parts: Part[] = [];
  for (const a of parsed.attachments) {
    const name = a.filename ?? "";
    if (!ATTACHMENT.test(name) || typeof a.content === "string") continue;
    const bytes = new Uint8Array(a.content);
    parts.push({ channel: "email_attachment", input: name.toLowerCase().endsWith(".docx") ? { kind: "docx", bytes } : { kind: "table", filename: name, bytes } });
  }
  if (parts.length) return parts;
  const body = stripQuoted(parsed.text ?? "");
  return body.length >= 40 && hasNumber(body) ? [{ channel: "email_body", input: { kind: "text", text: body } }] : [];
}

/** Admin (staff) address, known sender (contacts) or known thread (messages). Returns the org when we have one. */
async function match(
  db: D1Database,
  from: string,
  threadId: string,
  admins: string[],
): Promise<{ known: boolean; orgId: string | null }> {
  if (admins.includes(from)) return { known: true, orgId: null };
  const contact = await db
    .prepare("SELECT org_id FROM contacts WHERE lower(email) = ? LIMIT 1")
    .bind(from)
    .first<{ org_id: string }>();
  if (contact) return { known: true, orgId: contact.org_id };
  const thread = await db
    .prepare("SELECT org_id FROM messages WHERE gmail_thread_id = ? LIMIT 1")
    .bind(threadId)
    .first<{ org_id: string | null }>();
  return thread ? { known: true, orgId: thread.org_id } : { known: false, orgId: null };
}

/**
 * Phase 5 sync: logs metadata for known senders/threads, labels the rest `sam/ignored`.
 * Bodies and subjects of inbound mail are never stored and nothing here calls an LLM.
 */
export async function syncGmail(
  env: GmailEnv & LlmEnv & { DB: D1Database },
  gmail = new Gmail(env),
  llm: Llm = new OpenRouterLlm(env),
): Promise<SyncResult> {
  const admins = (env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const result: SyncResult = { logged: 0, ignored: 0, skipped: 0, ingested: 0 };
  for (const { id } of await gmail.listUnprocessed()) {
    const msg = await gmail.getRaw(id);
    const parsed = await PostalMime.parse(msg.raw);
    const from = parsed.from?.address?.toLowerCase();
    // Never process our own mail (a send-to-self test would otherwise loop).
    if (from === gmail.mailbox) {
      result.skipped++;
      continue;
    }
    const m = from ? await match(env.DB, from, msg.threadId, admins) : { known: false, orgId: null };
    if (!from || !m.known) {
      await gmail.label(id, [LABEL_IGNORED]);
      result.ignored++;
      continue;
    }
    const occurredAt = (parsed.date ? new Date(parsed.date) : new Date()).toISOString();
    const inserted = await env.DB
      .prepare(
        `INSERT OR IGNORE INTO messages
           (message_id, gmail_thread_id, direction, kind, org_id, from_email, to_email, occurred_at, is_synthetic)
         VALUES (?, ?, 'inbound', 'inbound', ?, ?, ?, ?, 0)`,
      )
      .bind(id, msg.threadId, m.orgId, from, gmail.mailbox, occurredAt)
      .run();
    if (m.orgId) {
      const done = await ingestMessage(env.DB, llm, { id, orgId: m.orgId, from, occurredAt, parts: dataParts(parsed) });
      if (done === "retry") continue; // model unavailable: leave unlabeled, the next sync tries again
      result.ingested += done;
    }
    await gmail.label(id, [LABEL_PROCESSED], ["INBOX"]);
    if (inserted.meta.changes > 0) {
      result.logged++;
      if (m.orgId) await markReplied(env.DB, { threadId: msg.threadId, from, at: occurredAt });
    }
  }
  return result;
}

/**
 * New data from a known org becomes a submission. Returns the number of submissions made, or "retry" when the
 * model failed recently (after an hour we stop retrying and hand the message to staff).
 */
async function ingestMessage(
  db: D1Database,
  llm: Llm,
  m: { id: string; orgId: string; from: string; occurredAt: string; parts: Part[] },
): Promise<number | "retry"> {
  if (m.parts.length === 0) return 0;
  const already = await db.prepare("SELECT submission_id FROM messages WHERE message_id = ?").bind(m.id).first<{ submission_id: string | null }>();
  if (already?.submission_id) return 0;
  const org = await db
    .prepare("SELECT org_id, org_name, primary_contact_email, is_synthetic FROM orgs WHERE org_id = ?")
    .bind(m.orgId)
    .first<OrgRow>();
  if (!org) return 0;
  let first: string | null = null;
  let made = 0;
  try {
    for (const p of m.parts) {
      const out = await ingest(db, llm, org, p.input, { channel: p.channel, senderEmail: m.from });
      if (out.submission_id) {
        first ??= out.submission_id;
        made++;
      }
    }
  } catch (e) {
    console.error("ingest failed:", e instanceof Error ? e.message.slice(0, 120) : "unknown");
    if (Date.now() - Date.parse(m.occurredAt) < GIVE_UP_AFTER_MS) return "retry";
    await db
      .prepare(
        `INSERT INTO submissions (submission_id, org_id, channel, received_at, sender_email, parser_version, status, is_synthetic)
         VALUES (?, ?, ?, ?, ?, 'ingest-1', 'needs_staff', ?)`,
      )
      .bind(`sub_${crypto.randomUUID()}`, org.org_id, m.parts[0]!.channel, new Date().toISOString(), m.from, org.is_synthetic)
      .run();
    return 1;
  }
  if (first) await db.prepare("UPDATE messages SET submission_id = ? WHERE message_id = ?").bind(first, m.id).run();
  return made;
}

/** Sends a test email and logs it as outbound so replies in its thread match. */
export async function sendTest(env: GmailEnv & { DB: D1Database }, to: string, gmail = new Gmail(env)) {
  const sent = await gmail.send({
    to,
    subject: "Test from Sam, TPW's data assistant",
    text: "This is a test message from Sam, TPW's data assistant. Reply to this email to check that replies are picked up.\n\nSam, TPW's data assistant",
  });
  await env.DB
    .prepare(
      `INSERT OR IGNORE INTO messages
         (message_id, gmail_thread_id, direction, kind, from_email, to_email, subject, occurred_at, is_synthetic)
       VALUES (?, ?, 'outbound', 'test', ?, ?, ?, ?, 0)`,
    )
    .bind(sent.id, sent.threadId, gmail.mailbox, to.toLowerCase(), "Test from Sam, TPW's data assistant", new Date().toISOString())
    .run();
  return sent;
}
