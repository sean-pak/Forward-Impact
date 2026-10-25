// Static reference data loaded by `pnpm db:reset` into tpw_analytics.
// Facilities live in facilities.ts. Everything here is public or a labeled assumption.

export type AssumptionSeed = {
  assumption_id: string;
  value: number;
  unit: string;
  source: string;
  note: string;
  status: "confirmed" | "todo_confirm";
};

export const ASSUMPTIONS: AssumptionSeed[] = [
  {
    assumption_id: "cost_per_year_2026",
    value: 21534,
    unit: "usd_per_person_year",
    source: "hackathon brief",
    note:
      "TODO(TPW): confirm which annual cost figure to use (21,534 per the brief; the ~136K figure is the all-in average cost). " +
      "The marginal cost of one fewer person is lower than the average cost. Treat dollar figures as estimates.",
    status: "todo_confirm",
  },
  {
    assumption_id: "outcome_window_days",
    value: 1095,
    unit: "days",
    source: "docs/schema-v2.md section 3",
    note: "Day 0 is the release date; day 1,095 is the last day of the 3-year window.",
    status: "confirmed",
  },
];

const CDCR_2021 = "CDCR Statewide Recidivism Report FY 2020-21";
const COVID_NOTE =
  "Every follow-up year for this cohort overlaps COVID-19. Association, not cause.";

export type BenchmarkSeed = {
  source: string;
  cohort_fy: string;
  outcome_type: string;
  stratum_field: string;
  stratum_value: string;
  numerator: number | null;
  denominator: number | null;
  rate: number;
  period_note: string;
};

const b = (
  outcome_type: string,
  stratum_field: string,
  stratum_value: string,
  numerator: number | null,
  denominator: number | null,
  rate: number,
  extra = "",
): BenchmarkSeed => ({
  source: CDCR_2021,
  cohort_fy: "FY2020_21",
  outcome_type,
  stratum_field,
  stratum_value,
  numerator,
  denominator,
  rate,
  period_note: extra ? `${COVID_NOTE} ${extra}` : COVID_NOTE,
});

// docs/schema-v2.md section 8.3, all 11 rows.
export const BENCHMARKS: BenchmarkSeed[] = [
  b("arrest", "all", "all", 18807, 30116, 0.624),
  b("conviction", "all", "all", 11886, 30116, 0.395),
  b("return_to_prison", "all", "all", 6249, 30655, 0.204),
  b("conviction", "risk_band", "low", null, null, 0.184),
  b("conviction", "risk_band", "moderate", null, null, 0.41),
  b("conviction", "risk_band", "high", null, null, 0.564),
  b("conviction", "supervision_type", "prcs", 6660, 13611, 0.489),
  b("conviction", "supervision_type", "parole", 5220, 16471, 0.317),
  b("conviction", "supervision_type", "discharged", 6, 34, 0.176, "Only 34 people: never use for standardization."),
  b("conviction", "enhanced_credit", "any", 5011, 15029, 0.333),
  b("conviction", "enhanced_credit", "none", 6875, 15087, 0.456),
];

export type FieldSeed = {
  field_key: string;
  label: string;
  type: "text" | "integer" | "number" | "boolean" | "date" | "enum";
  required: boolean;
  ask_template: string;
  sort_order: number;
};

// Core registry fields (PRD 7.7 priority order: enrolled, facility, start date first).
// {program} and {facility} are filled in by the question templates in phase 9.
export const CORE_FIELDS: FieldSeed[] = [
  { field_key: "n_enrolled", label: "People enrolled", type: "integer", required: true, sort_order: 10, ask_template: "How many people enrolled in {program}?" },
  { field_key: "facility_code", label: "Prison", type: "text", required: true, sort_order: 20, ask_template: "Which prison did {program} run at?" },
  { field_key: "start_date", label: "Start date", type: "date", required: true, sort_order: 30, ask_template: "What date did {program} start?" },
  { field_key: "end_date", label: "End date", type: "date", required: false, sort_order: 40, ask_template: "What date did {program} end?" },
  { field_key: "n_completed", label: "People who completed", type: "integer", required: false, sort_order: 50, ask_template: "How many people completed {program}?" },
  { field_key: "completion_rule", label: "What counts as completing", type: "text", required: false, sort_order: 60, ask_template: "What counts as completing {program}? For example, attending 80% of sessions." },
  { field_key: "sessions_planned", label: "Sessions planned", type: "integer", required: false, sort_order: 70, ask_template: "How many sessions were planned for {program}?" },
  { field_key: "course_hours_planned_per_participant", label: "Course hours per participant", type: "number", required: false, sort_order: 80, ask_template: "How many course hours did each participant get in {program}?" },
  { field_key: "total_course_hours_delivered", label: "Total course hours delivered", type: "number", required: false, sort_order: 90, ask_template: "What were the total course hours delivered in {program}, across everyone?" },
  { field_key: "yard", label: "Yard", type: "text", required: false, sort_order: 100, ask_template: "Which yard did {program} run in?" },
];
