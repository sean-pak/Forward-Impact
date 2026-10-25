import { REQUIRED_CYCLE_FIELDS, type CycleIssue } from "./formCycle";

/** Something Sam could ask about: an open `field_issue`, or a count the CBO gave as "about N". */
export type Candidate = {
  kind: "issue" | "approx";
  cycle_id: string;
  program_id: string;
  program_name: string;
  facility_name: string | null;
  start_date: string | null;
  field_name: string;
  issue_type: CycleIssue["issue_type"] | null;
  /** Plain-language message for an issue; for an approx candidate, the number as given. */
  message: string;
};

export type Question = {
  kind: Candidate["kind"];
  field_name: string;
  /** Cycles one answer settles. A completion rule belongs to the program, so it covers all of its cycles in the submission. */
  cycle_ids: string[];
  text: string;
};

const CORE: readonly string[] = REQUIRED_CYCLE_FIELDS;
const COUNT_LABEL: Record<string, string> = {
  n_enrolled: "people enrolled",
  n_completed: "people completed",
  total_course_hours_delivered: "total course hours delivered",
};

/**
 * PRD 7.7 priority, lowest number first:
 * required core field > conflict > ambiguous mapping > approximate > other required > registry field.
 * A blocking problem that is not one of those (an unreadable value, completed above enrolled) ranks with conflicts.
 */
export function rank(c: Pick<Candidate, "kind" | "field_name" | "issue_type">): number {
  if (c.kind === "approx") return 3;
  if (c.issue_type === "missing_required" && CORE.includes(c.field_name)) return 0;
  if (c.issue_type === "conflict" || c.issue_type === "out_of_range" || c.issue_type === "invalid_value") return 1;
  if (c.issue_type === "ambiguous_mapping") return 2;
  return isCoreOrProgramField(c.field_name) ? 4 : 5;
}

function isCoreOrProgramField(field: string): boolean {
  return [...CORE, "n_completed", "completion_rule", "end_date", "sessions_planned", "course_hours_planned_per_participant", "total_course_hours_delivered", "yard"].includes(field);
}

function about(c: Candidate): string {
  const where = c.facility_name ? ` at ${c.facility_name}` : "";
  const when = c.start_date ? `, started ${c.start_date}` : "";
  return `${c.program_name}${where}${when}`;
}

export function questionText(c: Candidate): string {
  if (c.kind === "approx") {
    const label = COUNT_LABEL[c.field_name] ?? c.field_name;
    return `You gave "about ${c.message}" for ${label} in ${about(c)}. Do you have the exact number? If so, reply with it. If about ${c.message} is the best you have, reply "about ${c.message} is fine".`;
  }
  if (c.field_name === "completion_rule") {
    return `What counts as completing ${c.program_name}? For example: attended all sessions, or attended at least 80% of sessions. Without it I cannot show a completion rate.`;
  }
  // The issue message names the program; the line below says which run it is when a program has several.
  return `${c.message}\n\n(This is about ${about(c)}.)`;
}

/** The one question for the next email, or null when nothing is left to ask. */
export function pickQuestion(candidates: Candidate[]): Question | null {
  if (candidates.length === 0) return null;
  const best = [...candidates].sort(
    (a, b) => rank(a) - rank(b) || a.program_name.localeCompare(b.program_name) || (a.start_date ?? "").localeCompare(b.start_date ?? "") || a.cycle_id.localeCompare(b.cycle_id),
  )[0]!;
  const sameRule = best.field_name === "completion_rule";
  const cycle_ids = candidates
    .filter((c) => c.kind === best.kind && c.field_name === best.field_name && (sameRule ? c.program_id === best.program_id : c.cycle_id === best.cycle_id))
    .map((c) => c.cycle_id);
  return { kind: best.kind, field_name: best.field_name, cycle_ids: [...new Set(cycle_ids)], text: questionText(best) };
}

/** A short, plain "yes" is the confirmation. Anything longer goes to the classifier so "yes but the SQ count is 29" is not lost. */
export function isPlainYes(text: string): boolean {
  return /^(yes|yes please|y|yep|yeah|yup|confirm|confirmed|correct|that is correct|that's correct|looks good|looks right|all good|approved|ok|okay|sounds good)[\s.!]*$/i.test(text.trim());
}
