import type { CycleFormRow } from "./formCycle";
import type { ExtractionResult } from "./schemas";

/** Drops the quoted earlier message and signature so only what the CBO just wrote is read. */
export function stripQuoted(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*On .+ wrote:\s*$/.test(line) || /^-{2,}\s*(Original Message|Forwarded)/i.test(line) || /^--\s*$/.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

/** Safety net: ID-shaped tokens (CDCR numbers, SYN numbers) and emails never go to the LLM. */
export function scrubIdentifiers(text: string): string {
  return text
    .replace(/\b[A-Z]{1,3}\d{5}\b/g, "[id]")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]");
}

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, dozen: 12,
};

/** True when the text contains a digit or a number word: the cheap test for "this message carries data". */
export function hasNumber(text: string): boolean {
  return /\d/.test(text) || Object.keys(WORDS).some((w) => new RegExp(`\\b${w}\\b`, "i").test(text));
}

/** True when `n` is written in the text as digits or a number word. Guards against invented counts. */
export function numberAppearsIn(n: number, text: string): boolean {
  const lower = text.toLowerCase();
  if (new RegExp(`(?<![\\d.])${n}(?![\\d])`).test(lower.replace(/(\d),(\d)/g, "$1$2"))) return true;
  return Object.entries(WORDS).some(([w, v]) => v === n && new RegExp(`\\b${w}\\b`).test(lower));
}

const TERM_PREFIX = /^(?:(?:our|the|this|that)\s+)?(?:(?:spring|summer|fall|autumn|winter|\d{4})\s+)+/i;
const GENERIC = new Set(["", "group", "class", "cohort", "session", "course", "program", "one", "run", "round"]);

/**
 * One class run twice is one program: "spring meditation class" and "our fall group" are both "Meditation class".
 * Season, term and year words are dropped from the front of each name. A name left generic ("group") takes the one
 * real class name in the same message; with none or several, the name is kept as written so nothing is merged by guess.
 */
export function baseProgramNames(names: string[]): string[] {
  const stripped = names.map((n) => n.trim().replace(TERM_PREFIX, "").trim());
  const real = [...new Map(stripped.filter((n) => !GENERIC.has(n.toLowerCase())).map((n) => [n.toLowerCase(), n])).values()];
  const cap = (n: string) => n.charAt(0).toUpperCase() + n.slice(1);
  return names.map((orig, i) => {
    const s = stripped[i]!;
    if (!GENERIC.has(s.toLowerCase())) return cap(s);
    return real.length === 1 ? cap(real[0]!) : orig.trim();
  });
}

/** Rows for the shared cycle cleaner. Counts the text does not contain are dropped and reported. */
export function extractionToRows(
  result: ExtractionResult,
  sourceText: string,
): { rows: CycleFormRow[]; unsupported: { row: number; program_name: string; field: "n_enrolled" | "n_completed"; value: number }[] } {
  const unsupported: { row: number; program_name: string; field: "n_enrolled" | "n_completed"; value: number }[] = [];
  const names = baseProgramNames(result.cycles.map((c) => c.program_name ?? ""));
  const rows = result.cycles.map((c, row): CycleFormRow => {
    const name = names[row] || "Unnamed program";
    const count = (field: "n_enrolled" | "n_completed"): string => {
      const v = c[field];
      if (v === null) return "";
      if (!numberAppearsIn(v, sourceText)) {
        unsupported.push({ row, program_name: name, field, value: v });
        return "";
      }
      return String(v);
    };
    const s = (v: number | string | null) => (v === null ? "" : String(v));
    return {
      program_id: "", program_name: name, facility_raw: s(c.facility_raw), yard: s(c.yard),
      start_date: s(c.start_date), end_date: s(c.end_date), sessions_planned: s(c.sessions_planned),
      course_hours_planned_per_participant: s(c.course_hours_planned_per_participant),
      n_enrolled: count("n_enrolled"), n_completed: count("n_completed"),
      total_course_hours_delivered: s(c.total_course_hours_delivered),
      n_enrolled_approx: c.n_enrolled_approx, n_completed_approx: c.n_completed_approx,
      total_course_hours_delivered_approx: c.total_course_hours_delivered_approx,
      completion_rule: s(c.completion_rule_stated), extra: {},
    };
  });
  return { rows, unsupported };
}
