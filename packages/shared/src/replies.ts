import { SIGNATURE, esc, type Email } from "./outreach";

/** "Re: <their subject>" so Gmail keeps the reply in the same thread. */
export function replySubject(original: string | null | undefined): string {
  const s = (original ?? "").trim();
  if (!s) return "Re: Program data";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** Replies take their subject from the thread, so templates return body text only. */
export type Body = Pick<Email, "text" | "html">;

function build(paragraphs: string[]): Body {
  const all = [...paragraphs, SIGNATURE];
  return { text: all.join("\n\n"), html: all.map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("") };
}

/** One question per email. `retry` is set when the last reply did not answer the question. */
export function clarifyEmail(i: { question: string; retry?: boolean }): Body {
  return build([
    i.retry
      ? "Thanks for the reply. I could not tell how it answers my question, so I'll ask it once more:"
      : "Thanks, I have your information. I have one question before I can count it:",
    i.question,
    "Just reply to this email with your answer.",
  ]);
}

export type ReceiptCycle = {
  program_name: string;
  facility_name: string | null;
  start_date: string | null;
  n_enrolled: number | null;
  n_enrolled_approx: boolean;
  n_completed: number | null;
  n_completed_approx: boolean;
  completion_rule: string;
};

function count(n: number | null, approx: boolean, word: string): string {
  return n === null ? `${word} not provided` : `${approx ? "about " : ""}${n} ${word}`;
}

export function receiptLine(c: ReceiptCycle): string {
  const where = c.facility_name ? ` at ${c.facility_name}` : "";
  const when = c.start_date ? `, started ${c.start_date}` : "";
  const rule = c.completion_rule && c.completion_rule !== "unstated" ? `; completion means: ${c.completion_rule}` : "";
  return `${c.program_name}${where}${when}: ${count(c.n_enrolled, c.n_enrolled_approx, "enrolled")}, ${count(c.n_completed, c.n_completed_approx, "completed")}${rule}`;
}

/** The aggregate path receives no identifiers, and the receipt says so instead of implying work was done. */
export function scrambledLine(names: number, cdcr: number): string {
  return names === 0 && cdcr === 0
    ? "No names or CDCR numbers were in what you sent, so nothing needed scrambling."
    : `${names} names and ${cdcr} CDCR numbers were scrambled and stored separately.`;
}

export type ReceiptInput = {
  orgName: string;
  cycles: ReceiptCycle[];
  /** Things still unknown, in plain words. They stay out of the totals until answered. */
  open: string[];
  scrambled: { names: number; cdcr: number };
  /** What Sam did while reading a person-level file (see individualNoteLines). Counts only. */
  notes?: string[];
  /** The org's private report page (`/o/[token]`). */
  reportUrl?: string;
  /** True when the CBO changed something and is confirming the updated version. */
  updated?: boolean;
  /** True when the CBO replied to the receipt but nothing in the reply could be applied. */
  unchanged?: boolean;
  /** True when the reply gave an expected number, which Sam does not count. */
  expectedLeftOut?: boolean;
};

export function confirmReceiptEmail(i: ReceiptInput): Body {
  const opener = i.updated
    ? "Thanks, I updated it."
    : i.unchanged
      ? "Thanks for the reply. I could not tell what to change from it, so nothing has changed yet."
      : "Thanks, that's everything I need.";
  return build([
    `${opener} Here is what I have for ${i.orgName}:`,
    i.cycles.map((c) => `- ${receiptLine(c)}`).join("\n"),
    ...(i.open.length ? [`Not provided yet (left out of totals until you tell me):\n${i.open.map((o) => `- ${o}`).join("\n")}`] : []),
    ...(i.expectedLeftOut ? ["I left out the expected numbers you mentioned, because only final counts are used. Send the count when the class ends."] : []),
    scrambledLine(i.scrambled.names, i.scrambled.cdcr),
    ...(i.notes?.length ? [`While reading your file:\n${i.notes.map((n) => `- ${n}`).join("\n")}`] : []),
    ...(i.reportUrl ? [`Your private report (it shows what you have confirmed, with your participants' names): ${i.reportUrl}`] : []),
    "Nothing is counted until you confirm. Reply YES to confirm, or reply with what to fix.",
  ]);
}

export function thanksEmail(i: { orgName: string; reportUrl?: string }): Body {
  return build([
    `Confirmed. Thank you. The information for ${i.orgName} now counts toward TPW's numbers.`,
    ...(i.reportUrl ? [`Your private report, with a paragraph you can use in grant applications: ${i.reportUrl}`] : []),
    "If anything changes, reply to this email or send a new update.",
  ]);
}

export function escalatedEmail(): Body {
  return build([
    "Thank you. I could not finish this one on my own, so I have passed it to TPW staff. Nothing from it is counted yet, and someone will follow up with you directly.",
  ]);
}

/** The model (or a setting) failed and Sam cannot read what was sent. Says so, and says a person will follow up. */
export function holdingEmail(): Body {
  return build([
    "Thank you. I received what you sent, but I am having trouble reading it right now. I have passed it to TPW staff, so nothing from it is counted yet, and someone will follow up with you directly.",
  ]);
}

/** An attachment Sam cannot read. Names only the file types, never the contents. */
export function unsupportedFileEmail(fileNames: string[]): Body {
  const list = fileNames.length === 1 ? fileNames[0] : fileNames.join(", ");
  return build([
    `Thanks for sending ${list}. I cannot read that kind of file.`,
    "I can read CSV files, Excel (.xlsx) files, Word (.docx) files, and numbers typed into the email itself. Could you reply with the information as a CSV or Excel file? In Excel or Google Sheets, use File > Save as (or Download) and choose CSV or .xlsx.",
  ]);
}
