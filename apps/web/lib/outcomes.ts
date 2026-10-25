import { SIMULATED_LABEL, type Metric, type OutcomePanel, type OutcomeRow } from "@tpw/shared";
import { SUPPRESSED } from "./format";

const fmt = new Intl.NumberFormat("en-US");
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** A rate always prints with its numerator and denominator. A suppressed one prints the word, never a number. */
export function showOutcomeRate(m: Metric): string {
  if (m.suppressed) return SUPPRESSED;
  if (m.value === null) return `n/a (${fmt.format(m.numerator ?? 0)} of ${fmt.format(m.denominator ?? 0)})`;
  return `${pct(m.value)} (${fmt.format(m.numerator ?? 0)} of ${fmt.format(m.denominator ?? 0)})`;
}

/** Kaplan-Meier projection for the 3-year rate. It is an estimate, and says so. */
export function showProjected(row: OutcomeRow): string {
  if (row.km_3yr.suppressed) return SUPPRESSED;
  if (row.km_3yr.value === null) return "n/a";
  const { low, high } = row.km_3yr_ci;
  const ci = low !== null && high !== null ? `, 95% CI ${pct(low)} to ${pct(high)}` : "";
  return `${pct(row.km_3yr.value)} projected${ci}, of ${fmt.format(row.km_3yr.denominator ?? 0)} people`;
}

export type OutcomeTextRow = {
  fiscalYear: string;
  released: string;
  y1: string;
  y2: string;
  y3: string;
  projected: string;
  followUp: string;
  /** Where the numbers come from, e.g. "SIMULATED". Never empty. */
  source: string;
  simulated: boolean;
};

export function outcomeTable(panel: OutcomePanel): OutcomeTextRow[] {
  return panel.rows.map((r) => ({
    fiscalYear: r.fiscal_year.replace("_", "-"),
    released: r.n_released.suppressed ? SUPPRESSED : fmt.format(r.n_released.value ?? 0),
    y1: showOutcomeRate(r.rate_1yr),
    y2: showOutcomeRate(r.rate_2yr),
    y3: showOutcomeRate(r.rate_3yr),
    projected: showProjected(r),
    followUp: r.follow_up_complete ? "complete" : "interim",
    source: r.source_labels.length > 0 ? r.source_labels.join(", ") : "no events yet",
    simulated: r.simulated,
  }));
}

/** The big label. Present whenever any row is simulated; a mixed or real panel is described, never hidden. */
export function simulatedBanner(panel: OutcomePanel): string | null {
  if (!panel.rows.some((r) => r.simulated)) return null;
  const all = panel.rows.every((r) => r.simulated);
  return all
    ? `${SIMULATED_LABEL}: these outcomes come from synthetic people and a mock locator, not CDCR records.`
    : `${SIMULATED_LABEL} rows are marked: some outcomes below come from synthetic people or a mock locator, not CDCR records.`;
}

export function benchmarkText(panel: OutcomePanel): string {
  const b = panel.benchmark;
  if (!b) return "Benchmark: none loaded.";
  const n = b.numerator !== null && b.denominator !== null ? ` (${fmt.format(b.numerator)} of ${fmt.format(b.denominator)})` : "";
  const note = b.note ? ` ${b.note}` : "";
  return `Benchmark, ${b.outcome}, ${b.cohort_fy.replace("_", "-")} release cohort: ${(b.rate * 100).toFixed(1)}%${n}. Source: ${b.source}. A different cohort and period than the rows above, for context only.${note}`;
}

/** Plain-language notes for the footnote. */
export function outcomeNotes(panel: OutcomePanel): string[] {
  const notes = [
    `Return to prison: first admission to CDCR custody within 1, 2 or 3 years of a person's first release after the program, as of ${panel.as_of}. Each year's rate is people with a return, out of people followed for that long or already returned.`,
    "Interim rows have people who have not yet been followed for 3 years: read the projection, not the 3-year rate. Not being found in custody does not prove no return.",
    "Association, not cause.",
  ];
  if (panel.rows.some((r) => r.suppressed)) notes.push("Cohorts under 30 people, rates with fewer than 30 in the denominator, and counts of 1 to 10 are suppressed.");
  return notes;
}
