import { normalizeMark, standardMeaning, type Completed, type Meaning } from "./attendance";
import { ruleFromNotes } from "./completion";
import { FACILITIES } from "./facilities";
import type { CleanCycle, CycleIssue } from "./formCycle";
import { parseDate, type Grid } from "./table";
import type { ColumnMapping } from "./schemas";
import { readAmount, readCdcr, readCompleted, readRisk, readSupervision, readWholeNumber, splitName, type Risk, type Supervision } from "./people";

/** Name given to a cycle whose program the sheet does not say. Sam asks, and a correction renames it. */
export const UNNAMED_PROGRAM = "Unnamed program";

export type PersonRow = {
  /** Line in the file with blank lines removed, 1-based. Safe to show the CBO. */
  row: number;
  first: string | null;
  last: string | null;
  cdcr: string | null;
  dob: string | null;
  program_name: string;
  facility_raw: string;
  start: string;
  end: string;
  /** Normalized marks, one per class date in `sessions` (persona 3). */
  marks: string[];
  cbo: Completed;
  hours: number | null;
  credits: number | null;
  release_date: string | null;
  supervision: Supervision;
  risk: Risk;
  completion_rule: string;
};

export type IndividualParse = {
  grain: "attendance" | "people";
  people: PersonRow[];
  sessions: { col: number; date: string }[];
  /** True for a class date with no mark for anyone (a lockdown day). */
  cancelled: boolean[];
  /** Facts read from the rows above the header. Empty string when absent. Nothing here is ever sent to the model. */
  notes: { facility_raw: string; program_name: string; rule: string };
  /** Plain counters for the receipt. Counts only, never values. */
  counts: Record<string, number>;
};

const NOT_A_PERSON = /^(total|totals|sum|count|average|avg|notes?|signature|facilitator|date|session)\b/i;

function facilityFromNotes(text: string): string {
  const hits = new Set<string>();
  for (const f of FACILITIES) {
    const words = [f.facility_name, ...f.aliases].filter((n) => n.length > 3);
    const named = words.some((w) => new RegExp(`(?<![A-Za-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, "i").test(text));
    const coded = new RegExp(`(?<![A-Za-z])${f.facility_code}(?![A-Za-z])`).test(text);
    if (named || coded) hits.add(f.facility_name);
  }
  return hits.size === 1 ? [...hits][0]! : "";
}

function programFromNotes(text: string, programs: string[]): string {
  const hits = programs.filter((p) => p.trim() && text.toLowerCase().includes(p.trim().toLowerCase()));
  return hits.length === 1 ? hits[0]! : "";
}

/**
 * Reads a person-level sheet (PRD 7.3). Code reads every value; the model only supplied the column mapping.
 * Persona 3 (a column per class date) becomes marks; persona 4 (a row per enrollment) becomes per-person fields.
 * Identifiers stay in the returned rows, which exist only in memory until the caller hands them to the vault.
 */
export function parseIndividual(grid: Grid, headerRow: number, mapping: ColumnMapping, opts: { programs: string[] }): IndividualParse | { error: string } {
  const target = new Map(mapping.columns.map((c) => [c.index, c.target]));
  const col = (t: string) => mapping.columns.find((c) => c.target === t)?.index ?? -1;
  const header = grid[headerRow] ?? [];
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  const sessions: IndividualParse["sessions"] = [];
  for (let i = 0; i < header.length; i++) {
    const t = target.get(i) ?? "ignore";
    if (t !== "session_date" && t !== "ignore") continue;
    const date = parseDate((header[i] ?? "").trim());
    if (date) sessions.push({ col: i, date });
    else if (t === "session_date") bump("unreadable_session_header");
  }
  const grain: IndividualParse["grain"] = sessions.length >= 2 ? "attendance" : "people";

  const noteLines = grid.slice(0, headerRow).flat().map((c) => c.trim()).filter(Boolean);
  const noteText = noteLines.join(" \n ");
  const notes = {
    facility_raw: facilityFromNotes(noteText),
    program_name: programFromNotes(noteText, opts.programs),
    rule: ruleFromNotes(noteLines) ?? "",
  };

  const cell = (r: string[], t: string) => {
    const i = col(t);
    return i < 0 ? "" : (r[i] ?? "").trim();
  };
  const date = (raw: string): string | null => {
    if (!raw) return null;
    const d = parseDate(raw);
    if (!d) bump("unreadable_date");
    return d;
  };

  const people: PersonRow[] = [];
  grid.slice(headerRow + 1).forEach((r, i) => {
    if (r.every((c) => !c || !c.trim())) return;
    const row = headerRow + 2 + i;
    const full = splitName(cell(r, "id_full_name"));
    const first = cell(r, "id_first_name") || full.first || "";
    const last = cell(r, "id_last_name") || full.last || "";
    if (NOT_A_PERSON.test(first) && !last) return;
    const cd = readCdcr(cell(r, "id_cdcr"));
    if (cd.kind === "refused") bump("bad_cdcr");
    const cdcr = cd.kind === "ok" ? cd.value : null;
    if (!cdcr && !first && !last) {
      bump("no_identifier");
      return;
    }
    if (!cdcr) bump("no_cdcr");
    const completed = readCompleted(cell(r, "completed_flag"));
    if (!completed.readable) bump("unreadable_completed");
    const risk = readRisk(cell(r, "risk_band"));
    if (!risk.readable) bump("unreadable_risk");
    const sup = readSupervision(cell(r, "supervision_type"));
    if (!sup.readable) bump("unreadable_supervision");
    const hours = readAmount(cell(r, "hours_attended"));
    const credits = readWholeNumber(cell(r, "credit_days_earned"));
    if (!hours.readable || !credits.readable) bump("unreadable_number");
    const startRaw = cell(r, "start_date");
    const endRaw = cell(r, "end_date");
    const dob = date(cell(r, "id_dob"));
    const release = date(cell(r, "release_date"));
    people.push({
      row, first: first || null, last: last || null, cdcr, dob,
      program_name: cell(r, "program_name") || notes.program_name,
      facility_raw: cell(r, "facility_raw") || notes.facility_raw,
      start: startRaw ? (parseDate(startRaw) ?? startRaw) : "",
      end: endRaw ? (parseDate(endRaw) ?? endRaw) : "",
      marks: sessions.map((s) => normalizeMark(r[s.col] ?? "")),
      cbo: completed.value, hours: hours.value, credits: credits.value, release_date: release,
      supervision: sup.value, risk: risk.value, completion_rule: cell(r, "completion_rule") || notes.rule,
    });
  });
  if (people.length === 0) return { error: "no people" };

  const cancelled = sessions.map((_, j) => people.every((p) => p.marks[j] === ""));
  if (grain === "attendance") {
    if (cancelled.every(Boolean)) return { error: "no marks" };
    counts.cancelled_sessions = cancelled.filter(Boolean).length;
  }
  return { grain, people, sessions, cancelled, notes, counts };
}

/** Rows that share a program, prison and start date are one cycle (persona 4). A sheet is one cycle (persona 3). */
export function groupCycles(parse: IndividualParse): { program_name: string; facility_raw: string; start: string; end: string; rule: string; people: PersonRow[] }[] {
  if (parse.grain === "attendance") {
    const live = parse.sessions.filter((_, j) => !parse.cancelled[j]).map((s) => s.date).sort();
    const first = parse.people[0]!;
    return [{
      program_name: parse.people.find((p) => p.program_name)?.program_name || UNNAMED_PROGRAM,
      facility_raw: parse.people.find((p) => p.facility_raw)?.facility_raw ?? "",
      start: first.start || live[0] || "",
      end: first.end || live[live.length - 1] || "",
      rule: parse.people.find((p) => p.completion_rule)?.completion_rule ?? "",
      people: parse.people,
    }];
  }
  const groups = new Map<string, ReturnType<typeof groupCycles>[number]>();
  for (const p of parse.people) {
    const key = [p.program_name, p.facility_raw, p.start].map((s) => s.trim().toLowerCase()).join("|");
    const g = groups.get(key) ?? { program_name: p.program_name.trim() || UNNAMED_PROGRAM, facility_raw: p.facility_raw, start: p.start, end: p.end, rule: "", people: [] };
    g.people.push(p);
    g.end ||= p.end;
    g.rule ||= p.completion_rule;
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** The state Sam keeps in program_cycles.extra for a cycle built from individual rows. */
export type IndividualExtra = {
  _individual?: "attendance" | "people";
  /** Marks that need the CBO to say what they mean. */
  _marks_unknown?: string[];
  /** The CBO's answers, by normalized mark. */
  _legend?: Record<string, Meaning>;
  _late_counts?: boolean | null;
  _dup_pairs?: { id: string; a: string; b: string; rows: [number, number] }[];
  _dup_resolved?: Record<string, "same" | "different">;
  /** Counters for the receipt (see individualNoteLines). */
  _notes?: Record<string, number>;
};

const quote = (marks: string[]) => marks.map((m) => (m === "?" ? "longer text entries" : `'${m}'`));
function listOf(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Marks in the sheet that the CBO has not explained yet. */
export function openMarks(extra: IndividualExtra): string[] {
  const legend = extra._legend ?? {};
  return (extra._marks_unknown ?? []).filter((m) => !(m in legend) && standardMeaning(m) === null);
}

export function unresolvedPair(extra: IndividualExtra) {
  const done = extra._dup_resolved ?? {};
  return (extra._dup_pairs ?? []).find((p) => !(p.id in done)) ?? null;
}

/** Issues that come from individual rows, rebuilt from stored state so every turn asks the same thing. */
export function individualIssues(extra: IndividualExtra, cycle: Pick<CleanCycle, "program_name" | "completion_rule">): CycleIssue[] {
  const out: CycleIssue[] = [];
  const name = cycle.program_name;
  if (extra._individual === "attendance") {
    const open = openMarks(extra);
    const lateNamed = Object.values(extra._legend ?? {}).includes("late");
    const lateUndecided = (extra._late_counts ?? null) === null;
    if (open.length > 0) {
      const late = lateUndecided && (open.includes("L") || lateNamed);
      out.push({
        field_name: "attendance_legend", issue_type: "ambiguous_mapping", raw_value: open.join(","),
        message: `What do ${listOf(quote(open))} mean in the attendance sheet for ${name}? For each one, is it present, absent, excused or late?${late ? " And does a late count as attended?" : ""}`,
      });
    } else if (lateNamed && lateUndecided) {
      out.push({
        field_name: "late_counts", issue_type: "ambiguous_mapping", raw_value: null,
        message: `Does a late count as attended for ${name}? Reply YES if it does, or NO if it does not.`,
      });
    }
    const pair = unresolvedPair(extra);
    if (pair) {
      out.push({
        field_name: "duplicate_person", issue_type: "conflict", raw_value: pair.id,
        message: `Lines ${pair.rows[0]} and ${pair.rows[1]} of your file for ${name} look like the same person (the names are almost the same; blank lines are not counted). Are they one person? Reply YES to count them once, or NO if they are two different people.`,
      });
    }
    if (cycle.completion_rule === "unstated") {
      out.push({
        field_name: "completion_rule", issue_type: "missing_required", raw_value: null,
        message: `What counts as completing ${name}? For example: attended all sessions, or attended at least 80% of sessions.`,
      });
    }
  }
  if (cycle.program_name === UNNAMED_PROGRAM) {
    out.push({
      field_name: "program_name", issue_type: "missing_required", raw_value: null,
      message: "Which program is this for? Reply with the class name, for example \"Healing Circle\".",
    });
  }
  return out;
}

const NOTE_TEXT: Record<string, (n: number) => string> = {
  cancelled_sessions: (n) => `${n} class ${n === 1 ? "date" : "dates"} had no mark for anyone, so I treated ${n === 1 ? "it" : "them"} as cancelled and left ${n === 1 ? "it" : "them"} out of attended and planned.`,
  no_cdcr: (n) => `${n} ${n === 1 ? "person has" : "people have"} no CDCR number, so ${n === 1 ? "they are" : "they are"} matched by name inside your organization only.`,
  bad_cdcr: (n) => `${n} CDCR ${n === 1 ? "number was" : "numbers were"} not in the format I accept and ${n === 1 ? "was" : "were"} not stored.`,
  no_identifier: (n) => `${n} ${n === 1 ? "row" : "rows"} had no name or CDCR number and ${n === 1 ? "was" : "were"} skipped.`,
  repeated_rows: (n) => `${n} ${n === 1 ? "row repeated" : "rows repeated"} a person already listed in the same program, so ${n === 1 ? "it was" : "they were"} counted once.`,
  future_release: (n) => `${n} release ${n === 1 ? "date was" : "dates were"} in the future, so I saved ${n === 1 ? "it" : "them"} as expected release ${n === 1 ? "date" : "dates"}.`,
  pre_program_release: (n) => `${n} ${n === 1 ? "person was" : "people were"} released before the program started, so ${n === 1 ? "they are" : "they are"} left out of that program's outcome numbers.`,
  unreadable_date: (n) => `${n} ${n === 1 ? "date" : "dates"} could not be read and ${n === 1 ? "was" : "were"} left blank.`,
  unreadable_completed: (n) => `${n} "completed" ${n === 1 ? "entry" : "entries"} could not be read and ${n === 1 ? "was" : "were"} treated as not marked.`,
  unreadable_number: (n) => `${n} ${n === 1 ? "number" : "numbers"} (hours or credit days) could not be read and ${n === 1 ? "was" : "were"} left blank.`,
  unreadable_risk: (n) => `${n} risk ${n === 1 ? "entry" : "entries"} could not be read and ${n === 1 ? "was" : "were"} saved as unknown.`,
  unreadable_supervision: (n) => `${n} supervision ${n === 1 ? "entry" : "entries"} could not be read and ${n === 1 ? "was" : "were"} saved as unknown.`,
  unreadable_session_header: (n) => `${n} column ${n === 1 ? "heading" : "headings"} could not be read as a class date and ${n === 1 ? "was" : "were"} skipped.`,
  completed_unmarked: (n) => `${n} ${n === 1 ? "person has" : "people have"} no completed mark, so completed is not counted for ${n === 1 ? "that program" : "those programs"}.`,
  conflicting_completed: (n) => `For ${n} ${n === 1 ? "person" : "people"}, your own completed mark disagrees with the completion rule. I used the rule.`,
  rule_unreadable: (n) => `I could not apply the completion rule for ${n} ${n === 1 ? "program" : "programs"} automatically, so completion follows your own marks where you gave them.`,
};

/** Plain sentences for the receipt, from the counters of every cycle in a submission. */
export function individualNoteLines(counters: Record<string, number>[]): string[] {
  const total: Record<string, number> = {};
  for (const c of counters) for (const [k, v] of Object.entries(c)) total[k] = (total[k] ?? 0) + v;
  return Object.entries(NOTE_TEXT).filter(([k]) => (total[k] ?? 0) > 0).map(([k, f]) => f(total[k]!));
}
