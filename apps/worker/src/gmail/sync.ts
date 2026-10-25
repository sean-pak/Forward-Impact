import PostalMime from "postal-mime";
import { Gmail, LABEL_IGNORED, LABEL_PROCESSED, type GmailEnv } from "./client";

export type SyncResult = { logged: number; ignored: number; skipped: number };

/** Known sender (contacts) or known thread (messages). Returns the org when we have one. */
async function match(db: D1Database, from: string, threadId: string): Promise<{ known: boolean; orgId: string | null }> {
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
export async function syncGmail(env: GmailEnv & { DB: D1Database }, gmail = new Gmail(env)): Promise<SyncResult> {
  const result: SyncResult = { logged: 0, ignored: 0, skipped: 0 };
  for (const { id } of await gmail.listUnprocessed()) {
    const msg = await gmail.getRaw(id);
    const parsed = await PostalMime.parse(msg.raw);
    const from = parsed.from?.address?.toLowerCase();
    // Never process our own mail (a send-to-self test would otherwise loop).
    if (from === gmail.mailbox) {
      result.skipped++;
      continue;
    }
    const m = from ? await match(env.DB, from, msg.threadId) : { known: false, orgId: null };
    if (!from || !m.known) {
      await gmail.label(id, [LABEL_IGNORED]);
      result.ignored++;
      continue;
    }
    const inserted = await env.DB
      .prepare(
        `INSERT OR IGNORE INTO messages
           (message_id, gmail_thread_id, direction, kind, org_id, from_email, to_email, occurred_at, is_synthetic)
         VALUES (?, ?, 'inbound', 'inbound', ?, ?, ?, ?, 0)`,
      )
      .bind(id, msg.threadId, m.orgId, from, gmail.mailbox, (parsed.date ? new Date(parsed.date) : new Date()).toISOString())
      .run();
    await gmail.label(id, [LABEL_PROCESSED], ["INBOX"]);
    if (inserted.meta.changes > 0) result.logged++;
  }
  return result;
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
