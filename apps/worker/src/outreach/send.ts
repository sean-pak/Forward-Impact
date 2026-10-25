import { askEmail, isSyntheticEmail } from "@tpw/shared";
import { Gmail, type GmailEnv } from "../gmail";
import { newToken } from "./contacts";

export type OutreachEnv = GmailEnv & {
  DB: D1Database;
  /** Public base URL of this Worker (open pixel). */
  WORKER_PUBLIC_URL: string;
  /** Public base URL of the web app (form links). */
  WEB_URL: string;
};

export type SendResult = {
  sent: { org_id: string; to: string }[];
  skipped: { org_id: string; reason: string }[];
};

type OrgRow = {
  org_id: string; org_name: string; form_token: string | null;
  contact_id: string | null; name: string | null; email: string | null;
};

const trimSlash = (u: string) => u.replace(/\/+$/, "");

/**
 * Sends the `ask` template to each org's primary contact, one email per org, individually.
 * `orgIds = null` means every org. An org that already has an outreach row is skipped (one ask per contact);
 * @example.org addresses are synthetic and never emailed.
 */
export async function sendAsks(env: OutreachEnv, orgIds: string[] | null, gmail = new Gmail(env)): Promise<SendResult> {
  const { results } = await env.DB
    .prepare(
      `SELECT o.org_id, o.org_name, o.form_token, c.contact_id, c.name, c.email
       FROM orgs o LEFT JOIN contacts c ON c.org_id = o.org_id AND c.is_primary = 1
       ORDER BY o.org_name`,
    )
    .all<OrgRow>();
  const byId = new Map(results.map((r) => [r.org_id, r]));
  const result: SendResult = { sent: [], skipped: [] };
  const targets = orgIds ?? results.map((r) => r.org_id);

  for (const orgId of [...new Set(targets)]) {
    const org = byId.get(orgId);
    const skip = (reason: string) => result.skipped.push({ org_id: orgId, reason });
    if (!org) { skip("unknown org"); continue; }
    if (!org.contact_id || !org.email) { skip("no primary contact"); continue; }
    if (isSyntheticEmail(org.email)) { skip("synthetic @example.org address, not emailed"); continue; }
    const asked = await env.DB.prepare("SELECT 1 AS x FROM outreach WHERE org_id = ?").bind(orgId).first();
    if (asked) { skip("already asked"); continue; }

    let formToken = org.form_token;
    if (!formToken) {
      formToken = newToken();
      await env.DB.prepare("UPDATE orgs SET form_token = ? WHERE org_id = ? AND form_token IS NULL").bind(formToken, orgId).run();
    }
    const outreachId = `out_${crypto.randomUUID()}`;
    const mail = askEmail({
      orgName: org.org_name,
      contactName: org.name ?? "",
      formUrl: `${trimSlash(env.WEB_URL)}/submit/${formToken}`,
      pixelUrl: `${trimSlash(env.WORKER_PUBLIC_URL)}/p/${outreachId}.gif`,
    });
    let sent: { id: string; threadId: string };
    try {
      sent = await gmail.send({ to: org.email, subject: mail.subject, text: mail.text, html: mail.html });
    } catch (e) {
      skip(e instanceof Error ? e.message.slice(0, 160) : "send failed");
      continue;
    }
    const now = new Date().toISOString();
    const synthetic = 0; // a real send to a real mailbox
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT OR IGNORE INTO messages
             (message_id, gmail_thread_id, direction, kind, org_id, from_email, to_email, subject, occurred_at, is_synthetic)
           VALUES (?, ?, 'outbound', 'ask', ?, ?, ?, ?, ?, ?)`,
        )
        .bind(sent.id, sent.threadId, orgId, gmail.mailbox, org.email.toLowerCase(), mail.subject, now, synthetic),
      env.DB
        .prepare(
          `INSERT INTO outreach (outreach_id, org_id, contact_id, message_id, sent_at, touch_number, is_synthetic)
           VALUES (?, ?, ?, ?, ?, 1, ?)`,
        )
        .bind(outreachId, orgId, org.contact_id, sent.id, now, synthetic),
    ]);
    result.sent.push({ org_id: orgId, to: org.email });
  }
  return result;
}
