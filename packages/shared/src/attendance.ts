import { parseCompletionRule, ruleMet } from "./completion";

export type Meaning = "present" | "absent" | "excused" | "late" | "unknown";
export type Completed = "yes" | "no" | "in_progress" | "unknown";

/** Marks longer than this are free text, which could hold a name, so they are never kept. */
export const MAX_MARK = 6;
/** Stands in for a mark that was too long to keep. */
export const LONG_MARK = "?";

/** Trimmed, uppercase mark. A long entry becomes "?" so free text is never stored. */
export function normalizeMark(raw: string): string {
  const t = raw.trim().replace(/\s+/g, " ").toUpperCase();
  return t.length > MAX_MARK ? LONG_MARK : t;
}

/** Schema 5.4: X / check / P / 1 present, blank / A / 0 absent, E excused. "L" and initials are not standard. */
const STANDARD = new Map<string, Meaning>([
  ["", "absent"], ["A", "absent"], ["0", "absent"], ["ABSENT", "absent"], ["NO", "absent"], ["N", "absent"],
  ["X", "present"], ["✓", "present"], ["✔", "present"], ["√", "present"], ["P", "present"], ["1", "present"],
  ["PRESENT", "present"], ["YES", "present"], ["Y", "present"],
  ["E", "excused"], ["EXC", "excused"], ["EXCUSED", "excused"],
  ["LATE", "late"],
]);

/** The meaning every sheet shares, or null when the CBO has to tell us. `mark` is already normalized. */
export function standardMeaning(mark: string): Meaning | null {
  return STANDARD.get(mark) ?? null;
}

export type AttendanceInput = {
  /** One entry per class date. A cancelled date counts for nobody. */
  sessions: { cancelled: boolean }[];
  /** `marks` lines up with `sessions`; normalized, "" for blank. */
  people: { key: string; marks: string[]; cbo: Completed }[];
  /** The CBO's answers, keyed by normalized mark. */
  legend: Record<string, Meaning>;
  /** Whether a late counts as attended; null until the CBO says. */
  lateCounts: boolean | null;
  /** The program's completion rule text, or "unstated". */
  rule: string;
};

export type PersonAttendance = {
  key: string;
  attended: number | null;
  planned: number;
  rate: number | null;
  completed: Completed;
  basis: "rule_applied" | "cbo_marked" | "unknown";
  /** Per session, same order as the input; cancelled dates read "absent" and are never written. */
  statuses: Meaning[];
};

export type AttendanceResult = {
  people: PersonAttendance[];
  /** Marks nobody has explained yet, sorted. */
  unknownMarks: string[];
  /** Some mark means late and the CBO has not said whether late counts. */
  needsLate: boolean;
  nEnrolled: number;
  /** Null until every person's completion is known. */
  nCompleted: number | null;
  /** People whose own "completed" mark disagrees with the rule that was applied. */
  conflicts: number;
  ruleApplied: boolean;
};

export function meaningOf(mark: string, legend: Record<string, Meaning>): Meaning {
  return standardMeaning(mark) ?? legend[mark] ?? "unknown";
}

/**
 * Attended, planned and completion per person (PRD 7.3). Cancelled dates are out of both counts for everyone.
 * Excused counts as planned but not attended. Until every mark is explained, attendance is null: nothing is guessed.
 * A parseable rule decides completion; otherwise the CBO's own mark does. Both disagreeing is counted, and the rule wins.
 */
export function computeAttendance(input: AttendanceInput): AttendanceResult {
  const live = input.sessions.map((s, i) => (s.cancelled ? -1 : i)).filter((i) => i >= 0);
  const unknown = new Set<string>();
  let needsLate = false;
  for (const p of input.people) {
    for (const i of live) {
      const m = meaningOf(p.marks[i] ?? "", input.legend);
      if (m === "unknown") unknown.add(p.marks[i] ?? "");
      if (m === "late" && input.lateCounts === null) needsLate = true;
    }
  }
  const resolved = unknown.size === 0 && !needsLate;
  const rule = parseCompletionRule(input.rule);
  let conflicts = 0;

  const people = input.people.map((p): PersonAttendance => {
    const statuses = input.sessions.map((s, i): Meaning => (s.cancelled ? "absent" : meaningOf(p.marks[i] ?? "", input.legend)));
    const planned = live.length;
    let attended: number | null = null;
    if (resolved) {
      attended = live.filter((i) => statuses[i] === "present" || (statuses[i] === "late" && input.lateCounts === true)).length;
    }
    const rate = attended !== null && planned > 0 ? Math.round((attended / planned) * 10_000) / 10_000 : null;
    const cboKnown = p.cbo === "yes" || p.cbo === "no";
    let completed: Completed = "unknown";
    let basis: PersonAttendance["basis"] = "unknown";
    if (resolved && rule && attended !== null) {
      completed = ruleMet(rule, attended, planned) ? "yes" : "no";
      basis = "rule_applied";
      if (cboKnown && p.cbo !== completed) conflicts++;
    } else if (p.cbo !== "unknown" && !(rule && !resolved)) {
      // With a rule Sam can apply, the rule decides once the marks are explained, so the person's own mark waits.
      completed = p.cbo;
      basis = "cbo_marked";
    }
    return { key: p.key, attended, planned, rate, completed, basis, statuses };
  });

  const known = people.every((p) => p.completed !== "unknown");
  return {
    people,
    unknownMarks: [...unknown].sort(),
    needsLate,
    nEnrolled: people.length,
    nCompleted: known && people.length > 0 ? people.filter((p) => p.completed === "yes").length : null,
    conflicts,
    ruleApplied: resolved && rule !== null,
  };
}
