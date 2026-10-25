export const SIGNATURE = "Sam, TPW's data assistant";

export type AskInput = {
  orgName: string;
  contactName: string;
  formUrl: string;
  pixelUrl: string;
};

export type Email = { subject: string; text: string; html: string };

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The first ask. Fixed wording from code, never LLM prose. The pixel is approximate and mail clients can block it. */
export function askEmail(i: AskInput): Email {
  const first = i.contactName.trim().split(/\s+/)[0] ?? "";
  const hello = first ? `Hi ${first},` : "Hello,";
  const lines = [
    hello,
    `I'm Sam, TPW's data assistant (an automated assistant, not a person). TPW is collecting program information from its partner organizations, and I'm reaching out to ${i.orgName}.`,
    `You can share it either way:`,
    `1. Use your private form: ${i.formUrl}`,
    `2. Or just reply to this email with whatever you have: numbers, spreadsheets, attendance sheets, photos.`,
    `Nothing is counted until you confirm it. If something is unclear I'll ask you one question at a time.`,
    SIGNATURE,
  ];
  const text = lines.join("\n\n");
  const html =
    `<p>${esc(hello)}</p>` +
    `<p>I'm Sam, TPW's data assistant (an automated assistant, not a person). TPW is collecting program information from its partner organizations, and I'm reaching out to ${esc(i.orgName)}.</p>` +
    `<p>You can share it either way:</p>` +
    `<ol><li>Use your private form: <a href="${esc(i.formUrl)}">${esc(i.formUrl)}</a></li>` +
    `<li>Or just reply to this email with whatever you have: numbers, spreadsheets, attendance sheets, photos.</li></ol>` +
    `<p>Nothing is counted until you confirm it. If something is unclear I'll ask you one question at a time.</p>` +
    `<p>${esc(SIGNATURE)}</p>` +
    `<img src="${esc(i.pixelUrl)}" width="1" height="1" alt="" />`;
  return { subject: `Program data for ${i.orgName}`, text, html };
}

export type OutreachRow = { sent_at: string; opened_at: string | null; replied_at: string | null };

export type OutreachStats = {
  sent: number;
  /** Approximate: image-pixel based. Mail clients that block or prefetch images skew it. */
  opened: number;
  replied: number;
  /** replied of sent, always with both numbers. Null when nothing was sent. */
  responseRate: { numerator: number; denominator: number } | null;
  /** Median hours from send to first reply, over replied asks only. */
  medianHoursToReply: number | null;
};

export function hoursBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 3_600_000;
}

export function outreachStats(rows: OutreachRow[]): OutreachStats {
  const replied = rows.filter((r) => r.replied_at);
  const hours = replied.map((r) => Math.max(0, hoursBetween(r.sent_at, r.replied_at!))).sort((a, b) => a - b);
  const mid = Math.floor(hours.length / 2);
  const median = hours.length === 0 ? null : hours.length % 2 ? hours[mid]! : (hours[mid - 1]! + hours[mid]!) / 2;
  return {
    sent: rows.length,
    opened: rows.filter((r) => r.opened_at).length,
    replied: replied.length,
    responseRate: rows.length ? { numerator: replied.length, denominator: rows.length } : null,
    medianHoursToReply: median,
  };
}
