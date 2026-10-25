import type { Completed } from "./attendance";

/** Test-data CDCR numbers only (CLAUDE.md). Anything else is refused and never stored. */
const CDCR_ACCEPTED = /^SYN\d{5}$/;

/** Uppercase, no spaces or dashes: the same normalization the vault keys on. */
export function cleanCdcr(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, "");
}

export type CdcrRead = { kind: "none" } | { kind: "ok"; value: string } | { kind: "refused" };

export function readCdcr(raw: string): CdcrRead {
  const v = cleanCdcr(raw);
  if (!v) return { kind: "none" };
  return CDCR_ACCEPTED.test(v) ? { kind: "ok", value: v } : { kind: "refused" };
}

/** "Last, First" or "First Last". The last word is the surname when there is no comma. */
export function splitName(raw: string): { first: string | null; last: string | null } {
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t) return { first: null, last: null };
  if (t.includes(",")) {
    const [last, ...rest] = t.split(",");
    return { first: rest.join(",").trim() || null, last: last!.trim() || null };
  }
  const parts = t.split(" ");
  return parts.length === 1 ? { first: parts[0]!, last: null } : { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1]! };
}

const fold = (s: string | null) => (s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

export type NameRow = { key: string; row: number; first: string | null; last: string | null; cdcr: string | null; dob: string | null };

/**
 * Pairs of rows that may be one person under two spellings (PRD 7.3): one name part equal and the other one
 * letter off ("Jon Smith" / "John Smith"). Rows with different CDCR numbers or different birth dates are different
 * people. Pairs are only suggested; Sam asks, and never merges on its own.
 */
export function nameVariants(people: NameRow[]): [NameRow, NameRow][] {
  const out: [NameRow, NameRow][] = [];
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const a = people[i]!;
      const b = people[j]!;
      if (a.key === b.key) continue;
      if (a.cdcr && b.cdcr && a.cdcr !== b.cdcr) continue;
      if (a.dob && b.dob && a.dob !== b.dob) continue;
      const [fa, fb, la, lb] = [fold(a.first), fold(b.first), fold(a.last), fold(b.last)];
      if (!fa || !fb || !la || !lb) continue;
      const first = distance(fa, fb);
      const last = distance(la, lb);
      const close = (first === 0 && last <= 1) || (last === 0 && first <= 1);
      if (close && first + last > 0) out.push([a, b]);
    }
  }
  return out;
}

/** "Y", "yes", "graduated" -> yes. Blank or unreadable -> unknown (counted by the caller as unreadable). */
export function readCompleted(raw: string): { value: Completed; readable: boolean } {
  const t = raw.trim().toLowerCase().replace(/[.!]/g, "");
  if (!t) return { value: "unknown", readable: true };
  if (/^(y|yes|true|1|x|✓|✔|completed?|graduated?|grad|passed|done|finished)$/.test(t)) return { value: "yes", readable: true };
  if (/^(n|no|false|0|not completed?|incomplete|dropped|did not complete|failed|withdrew|withdrawn)$/.test(t)) return { value: "no", readable: true };
  if (/^(in progress|ongoing|current|active|enrolled|in program)$/.test(t)) return { value: "in_progress", readable: true };
  return { value: "unknown", readable: false };
}

export type Risk = "low" | "moderate" | "high" | "unknown";
export function readRisk(raw: string): { value: Risk; readable: boolean } {
  const t = raw.trim().toLowerCase();
  if (!t) return { value: "unknown", readable: true };
  if (/^(low|l)$/.test(t)) return { value: "low", readable: true };
  if (/^(moderate|medium|med|mod|m)$/.test(t)) return { value: "moderate", readable: true };
  if (/^(high|h)$/.test(t)) return { value: "high", readable: true };
  return { value: "unknown", readable: /^(unknown|n\/a|na|none|-)$/.test(t) };
}

export type Supervision = "parole" | "prcs" | "discharged" | "unknown";
export function readSupervision(raw: string): { value: Supervision; readable: boolean } {
  const t = raw.trim().toLowerCase();
  if (!t) return { value: "unknown", readable: true };
  if (/^parole$/.test(t)) return { value: "parole", readable: true };
  if (/^(prcs|post.?release community supervision)$/.test(t)) return { value: "prcs", readable: true };
  if (/^(discharged?|discharge)$/.test(t)) return { value: "discharged", readable: true };
  return { value: "unknown", readable: /^(unknown|n\/a|na|none|-)$/.test(t) };
}

export function readWholeNumber(raw: string): { value: number | null; readable: boolean } {
  const t = raw.trim().replace(/,/g, "");
  if (!t) return { value: null, readable: true };
  return /^\d+$/.test(t) ? { value: Number(t), readable: true } : { value: null, readable: false };
}

export function readAmount(raw: string): { value: number | null; readable: boolean } {
  const t = raw.trim().replace(/,/g, "");
  if (!t) return { value: null, readable: true };
  return /^\d+(\.\d+)?$/.test(t) ? { value: Number(t), readable: true } : { value: null, readable: false };
}

/** Release year-month-day to the fiscal year July 1 to June 30: 2023-03-01 -> FY2022_23. */
export function fiscalYear(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const start = m >= 7 ? y : y - 1;
  return `FY${start}_${String((start + 1) % 100).padStart(2, "0")}`;
}

export type AgeBand = "18_19" | "20_24" | "25_29" | "30_34" | "35_39" | "40_44" | "45_49" | "50_54" | "55_59" | "60_plus" | "unknown";

/** CDCR age band at a date, from a full birth date. Under 18 or invalid input is unknown. */
export function ageBandAt(dob: string, on: string): AgeBand {
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(on);
  if (!b || !d) return "unknown";
  let age = Number(d[1]) - Number(b[1]);
  if (Number(d[2]) < Number(b[2]) || (Number(d[2]) === Number(b[2]) && Number(d[3]) < Number(b[3]))) age--;
  if (age < 18) return "unknown";
  if (age >= 60) return "60_plus";
  if (age < 20) return "18_19";
  const lo = Math.floor(age / 5) * 5;
  return `${lo}_${lo + 4}` as AgeBand;
}
