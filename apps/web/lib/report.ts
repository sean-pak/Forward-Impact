import type { Dashboard, OutcomePanel } from "@tpw/shared";
import { hoursNote, rateNote, show } from "./format";
import { benchmarkText, outcomeNotes, outcomeTable, simulatedBanner, type OutcomeTextRow } from "./outcomes";

export type ReportStat = { label: string; value: string; note: string };

export type ReportOutcomes = {
  banner: string | null;
  rows: OutcomeTextRow[];
  benchmark: string;
  notes: string[];
};

export type ReportContent = {
  title: string;
  generatedOn: string;
  stats: ReportStat[];
  deserts: string;
  footnotes: string[];
  recidivismContext: string;
  /** Present only when the outcome panel is switched on for this PDF. */
  outcomes: ReportOutcomes | null;
};

/**
 * Plain text for the one-pager. Takes the public dashboard only, so a staff view
 * can never be printed by mistake. Every number goes through `show()`.
 */
export function buildReportContent(d: Dashboard, generatedOn: string, outcomes: OutcomePanel | null = null): ReportContent {
  if (d.view !== "public" || (outcomes && outcomes.view !== "public")) throw new Error("The one-pager is built from the public view only");
  const hours = hoursNote(d.hoursNote);
  const footnotes = [
    "Counts only data confirmed by the program's organization. Cells shown as \"suppressed\" are too small to publish: rates with fewer than 30 in the denominator, counts of 1 to 10, and facilities with fewer than 3 organizations.",
    "Completion rate uses each program's own stated completion rule, over cycles with both counts known.",
    hours ? `Participant-hours: ${hours}. Planned hours are an estimate, marked approx.` : "",
    "These figures describe programs and participation. They show association, not cause.",
  ].filter(Boolean);
  return {
    title: "Transformative Programs at a Glance",
    generatedOn,
    stats: [
      { label: "Participants", value: show(d.participants, "count"), note: "" },
      { label: "Completion rate", value: show(d.completion, "rate"), note: rateNote(d.completion, d.cyclesExcludedFromCompletion) },
      { label: "Participant-hours", value: show(d.hours, "hours"), note: "" },
      { label: "Prisons covered", value: `${d.prisons.covered} of ${d.prisons.total}`, note: "" },
    ],
    deserts: `${d.deserts.length} of ${d.prisons.total} prisons have no confirmed program cycle (program deserts).`,
    footnotes,
    recidivismContext: "Recidivism context: pending TPW confirmation.",
    outcomes: outcomes
      ? { banner: simulatedBanner(outcomes), rows: outcomeTable(outcomes), benchmark: benchmarkText(outcomes), notes: outcomeNotes(outcomes) }
      : null,
  };
}
