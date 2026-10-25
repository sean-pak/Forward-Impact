import type { CycleFormRow } from "./formCycle";
import { parseIsoDate } from "./formCycle";
import { CANONICAL_TARGETS, type ColumnMapping } from "./schemas";

export type Grid = string[][];

const blank = (s: string | undefined) => !s || !s.trim();

/**
 * The header is the first of the top rows that has most of the sheet's width filled and no numbers.
 * Notes rows above it (a title, "Prepared by ...") have few cells and are skipped.
 */
export function findHeaderRow(grid: Grid): number {
  const top = grid.slice(0, 20);
  const width = Math.max(0, ...top.map((r) => r.filter((c) => !blank(c)).length));
  const i = top.findIndex((r) => {
    const cells = r.filter((c) => !blank(c));
    // Class dates are a valid header ("2026-01-12"); a row of plain numbers is data.
    return cells.length >= 2 && cells.length >= width * 0.6 && cells.every((c) => !/^[\d.,/-]+$/.test(c.trim()) || parseDate(c.trim()) !== null);
  });
  return i === -1 ? 0 : i;
}

export type ColumnProfile = {
  index: number;
  header: string;
  type: "empty" | "integer" | "number" | "date" | "text";
  /** Masked shapes with their share of non-empty cells. Never a raw value, except single-character marks. */
  patterns: { pattern: string; share: number }[];
  distinct: number;
  null_share: number;
};

const MAX_PATTERN = 24;

/** "Aaaa Aaaa", "###", "AAA#####". Letters and digits are masked; punctuation is kept. */
export function maskValue(v: string): string {
  const t = v.trim();
  if (parseDate(t)) return /^\d{4}-/.test(t) ? "YYYY-MM-DD" : "M/D/YYYY";
  const m = t.replace(/[A-Z]/g, "A").replace(/[a-z]/g, "a").replace(/\d/g, "#");
  return m.length > MAX_PATTERN ? `${m.slice(0, MAX_PATTERN)}...` : m;
}

function inferType(values: string[]): ColumnProfile["type"] {
  if (values.length === 0) return "empty";
  if (values.every((v) => /^\d+$/.test(v.trim()))) return "integer";
  if (values.every((v) => /^\d+(\.\d+)?$/.test(v.trim()))) return "number";
  if (values.every((v) => parseDate(v.trim()))) return "date";
  return "text";
}

/** Masked profile of every column: this is all the LLM sees of a spreadsheet (PRD 7.3). */
export function profileColumns(grid: Grid, headerRow: number): ColumnProfile[] {
  const body = grid.slice(headerRow + 1);
  const width = Math.max(grid[headerRow]?.length ?? 0, ...body.map((r) => r.length));
  const out: ColumnProfile[] = [];
  for (let index = 0; index < width; index++) {
    const all = body.map((r) => r[index] ?? "");
    const values = all.filter((v) => !blank(v)).map((v) => v.trim());
    const distinct = new Set(values).size;
    const counts = new Map<string, number>();
    const markColumn = distinct > 0 && distinct <= 8 && [...new Set(values)].every((v) => v.length === 1);
    for (const v of values) {
      const p = markColumn ? v : maskValue(v);
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    out.push({
      index,
      header: (grid[headerRow]?.[index] ?? "").trim(),
      type: inferType(values),
      patterns: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([pattern, n]) => ({ pattern, share: round2(n / values.length) })),
      distinct,
      null_share: all.length ? round2(1 - values.length / all.length) : 1,
    });
  }
  return out;
}
const round2 = (n: number) => Math.round(n * 100) / 100;

/** ISO, or US M/D/YYYY and M/D/YY. Returns null for anything else; nothing is guessed. */
export function parseDate(raw: string): string | null {
  const t = raw.trim();
  const iso = parseIsoDate(t.length > 10 && /^\d{4}-\d{2}-\d{2}T/.test(t) ? t.slice(0, 10) : t);
  if (iso) return iso;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t);
  if (!m) return null;
  const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return parseIsoDate(`${year}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`);
}

/** "about 25" / "~25" / "approx. 25" -> 25 flagged approximate. */
export function readCount(raw: string): { value: string; approx: boolean } {
  const t = raw.trim();
  const m = /^(?:about|approx\.?|approximately|around|roughly|~)\s*(\d+(?:\.\d+)?)$/i.exec(t);
  return m ? { value: m[1]!, approx: true } : { value: t.replace(/^(\d),(\d{3})$/, "$1$2"), approx: false };
}

export type TableRows = { rows: CycleFormRow[]; rowNumbers: number[] };

/** Persona 1: one row per cycle. Rows that are entirely blank are skipped. */
export function rowsFromMapping(grid: Grid, headerRow: number, mapping: ColumnMapping): TableRows {
  const col = new Map<string, number>();
  for (const c of mapping.columns) if ((CANONICAL_TARGETS as readonly string[]).includes(c.target)) col.set(c.target, c.index);
  const rows: CycleFormRow[] = [];
  const rowNumbers: number[] = [];
  grid.slice(headerRow + 1).forEach((r, i) => {
    if (r.every(blank)) return;
    const cell = (t: string) => (r[col.get(t) ?? -1] ?? "").trim();
    const count = (t: string) => readCount(cell(t));
    const date = (t: string) => {
      const raw = cell(t);
      return raw ? (parseDate(raw) ?? raw) : "";
    };
    const enrolled = count("n_enrolled");
    const completed = count("n_completed");
    const delivered = count("total_course_hours_delivered");
    rows.push({
      program_id: "", program_name: cell("program_name") || "Unnamed program", facility_raw: cell("facility_raw"), yard: cell("yard"),
      start_date: date("start_date"), end_date: date("end_date"), sessions_planned: cell("sessions_planned"),
      course_hours_planned_per_participant: cell("course_hours_planned_per_participant"),
      n_enrolled: enrolled.value, n_completed: completed.value, total_course_hours_delivered: delivered.value,
      n_enrolled_approx: enrolled.approx, n_completed_approx: completed.approx, total_course_hours_delivered_approx: delivered.approx,
      completion_rule: cell("completion_rule"), extra: {},
    });
    rowNumbers.push(headerRow + 2 + i);
  });
  return { rows, rowNumbers };
}

/** True when the mapping reads identifiers or per-session columns: not an aggregate table (phase 10). */
export function isIndividualLevel(mapping: ColumnMapping): boolean {
  return mapping.persona >= 3 || mapping.columns.some((c) => c.target.startsWith("id_") || c.target === "session_date");
}
