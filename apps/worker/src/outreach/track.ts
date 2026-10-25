import { outreachStats, type OutreachStats } from "@tpw/shared";

/** 1x1 transparent GIF. */
export const PIXEL_GIF = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (c) => c.charCodeAt(0),
);

export const OUTREACH_ID = /^out_[0-9a-f-]{36}$/;

/** Approximate: mail clients may prefetch or block images. Unknown ids are ignored. */
export async function recordOpen(db: D1Database, outreachId: string): Promise<void> {
  if (!OUTREACH_ID.test(outreachId)) return;
  await db
    .prepare("UPDATE outreach SET opened_at = COALESCE(opened_at, ?), open_count = open_count + 1 WHERE outreach_id = ?")
    .bind(new Date().toISOString(), outreachId)
    .run();
}

/**
 * Called for each newly logged inbound message from a known org. Marks the org's open asks replied when the
 * message is in the ask's thread or comes from the contact the ask went to.
 */
export async function markReplied(db: D1Database, p: { threadId: string; from: string; at: string }): Promise<void> {
  await db
    .prepare(
      `UPDATE outreach SET replied_at = ?
       WHERE replied_at IS NULL AND sent_at <= ? AND (
         message_id IN (SELECT message_id FROM messages WHERE gmail_thread_id = ? AND kind = 'ask')
         OR contact_id IN (SELECT contact_id FROM contacts WHERE lower(email) = ?)
       )`,
    )
    .bind(p.at, p.at, p.threadId, p.from.toLowerCase())
    .run();
}

export type OutreachListRow = {
  outreach_id: string; org_id: string; org_name: string; to_email: string | null;
  sent_at: string; opened_at: string | null; open_count: number; replied_at: string | null;
};

export async function listOutreach(db: D1Database): Promise<{ stats: OutreachStats; rows: OutreachListRow[] }> {
  const { results } = await db
    .prepare(
      `SELECT x.outreach_id, x.org_id, o.org_name, c.email AS to_email, x.sent_at, x.opened_at, x.open_count, x.replied_at
       FROM outreach x JOIN orgs o ON o.org_id = x.org_id LEFT JOIN contacts c ON c.contact_id = x.contact_id
       ORDER BY x.sent_at DESC`,
    )
    .all<OutreachListRow>();
  return { stats: outreachStats(results), rows: results };
}
