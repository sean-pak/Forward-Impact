import PostalMime from "postal-mime";
import { hasNumber, stripQuoted } from "@tpw/shared";
import { ingest, type IngestInput, type IngestMeta, type VaultSource } from "../ingest";
import { OpenRouterLlm, type Llm, type LlmEnv } from "../llm";
import { vaultFactory, type VaultEnv } from "../vault";
import { markReplied } from "../outreach/track";
import { activeSubmissionForThread, handleReply, startConversation, type Inbound } from "../reply";
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
  env: GmailEnv & LlmEnv & { DB: D1Database; WEB_URL?: string } & Partial<VaultEnv>,
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
      const inbound: Inbound = {
        gmailId: id, threadId: msg.threadId, from, occurredAt, subject: parsed.subject ?? "", text: parsed.text ?? "",
        rfcMessageId: parsed.messageId ?? null, references: parsed.references ?? null,
      };
      try {
        const waiting = await activeSubmissionForThread(env.DB, msg.threadId);
        if (waiting) {
          // A reply to Sam's question or receipt (PRD 7.5): classify, apply, then the next question or the receipt.
          const already = await env.DB.prepare("SELECT submission_id FROM messages WHERE message_id = ?").bind(id).first<{ submission_id: string | null }>();
          if (!already?.submission_id) await handleReply({ db: env.DB, gmail, llm, webUrl: env.WEB_URL }, waiting, inbound);
        } else {
          const done = await ingestMessage(env.DB, llm, { id, orgId: m.orgId, from, occurredAt, parts: dataParts(parsed) }, vaultFactory(env));
          if (done === "retry") continue; // model unavailable: leave unlabeled, the next sync tries again
          result.ingested += done.made;
          await startConversations(env.DB, { db: env.DB, gmail, llm, webUrl: env.WEB_URL }, done.ids, inbound);
        }
      } catch (e) {
        // Model or Gmail trouble: leave the message unlabeled so the next sync tries it again.
        console.error("reply handling failed:", e instanceof Error ? e.message.slice(0, 120) : "unknown");
        continue;
      }
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
  vault?: VaultSource,
): Promise<{ ids: string[]; made: number } | "retry"> {
  const none = { ids: [], made: 0 };
  if (m.parts.length === 0) return none;
  const already = await db.prepare("SELECT submission_id FROM messages WHERE message_id = ?").bind(m.id).first<{ submission_id: string | null }>();
  // Already ingested on an earlier pass; the conversation may still need to start (its email can have failed).
  if (already?.submission_id) return { ids: [already.submission_id], made: 0 };
  const org = await db
    .prepare("SELECT org_id, org_name, primary_contact_email, is_synthetic FROM orgs WHERE org_id = ?")
    .bind(m.orgId)
    .first<OrgRow>();
  if (!org) return none;
  const ids: string[] = [];
  try {
    for (const p of m.parts) {
      const out = await ingest(db, llm, org, p.input, { channel: p.channel, senderEmail: m.from }, vault);
      if (out.submission_id) ids.push(out.submission_id);
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
    return { ids: [], made: 1 };
  }
  if (ids[0]) await db.prepare("UPDATE messages SET submission_id = ? WHERE message_id = ?").bind(ids[0], m.id).run();
  return { ids, made: ids.length };
}

/**
 * One email thread carries one conversation, so the first submission gets Sam's questions. Any others from the
 * same message go to staff rather than interleaving questions in one thread.
 */
async function startConversations(db: D1Database, deps: Parameters<typeof startConversation>[0], ids: string[], inbound: Inbound) {
  const [first, ...rest] = ids;
  if (!first) return;
  await startConversation(deps, first, inbound);
  for (const id of rest) await db.prepare("UPDATE submissions SET status = 'needs_staff' WHERE submission_id = ? AND status <> 'confirmed'").bind(id).run();
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
