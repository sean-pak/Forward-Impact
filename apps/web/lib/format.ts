import type { Metric } from "@tpw/shared";

const fmt = new Intl.NumberFormat("en-US");

export const SUPPRESSED = "suppressed";

/** One place that turns a Metric into text, so a suppressed cell can never print a number. */
export function show(m: Metric, kind: "count" | "rate" | "hours"): string {
  if (m.suppressed) return SUPPRESSED;
  if (m.value === null) return "n/a";
  const text = kind === "rate" ? `${Math.round(m.value * 100)}%` : fmt.format(Math.round(m.value));
  return `${text}${m.isEstimate ? " (approx.)" : ""}`;
}

export function rateNote(m: Metric, excluded: number): string {
  if (m.suppressed) return "Fewer than 30 in the denominator.";
  if (m.value === null) return "No cycle has a stated completion rule and both counts.";
  const left = excluded ? `; ${excluded} cycle(s) left out (rule unstated or count missing)` : "";
  return `${fmt.format(m.numerator ?? 0)} of ${fmt.format(m.denominator ?? 0)} completed${left}`;
}

export function hoursNote(n: { delivered: number; planned: number; unknown: number }): string {
  const parts = [];
  if (n.delivered) parts.push(`${n.delivered} delivered`);
  if (n.planned) parts.push(`${n.planned} planned (hours per participant × enrolled)`);
  if (n.unknown) parts.push(`${n.unknown} unknown`);
  return parts.join(", ");
}
