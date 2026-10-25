import { z } from "zod";

// Row schemas for the seed CSVs described in docs/SEED_CONTRACT.md.
// CSV cells are strings; the helpers below turn "" into null and parse the rest.
// A test checks that every column here exists in the matching migration.

const empty = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

const str = z.preprocess(empty, z.string().trim().min(1).nullable());
const reqStr = z.string().trim().min(1);
const int = z.preprocess(empty, z.coerce.number().int().nullable());
const num = z.preprocess(empty, z.coerce.number().nullable());
const date = z.preprocess(empty, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD").nullable());
const bool = z.preprocess((v) => {
  const x = typeof v === "string" ? v.trim().toLowerCase() : v;
  if (x === "true" || x === "1" || x === "yes") return true;
  if (x === "false" || x === "0" || x === "no") return false;
  return x;
}, z.boolean());

/** Demo CDCR numbers are always `SYN` + 5 digits. Anything else refuses the whole load. */
export const SynCdcr = z.string().regex(/^SYN\d{5}$/, "CDCR numbers must be SYN + 5 digits in synthetic data");

const ORG_TYPES = ["arts", "education", "reentry", "healing", "faith", "legal", "employment", "other", "unknown"] as const;
const CATEGORIES = ["education", "cognitive_behavioral", "substance_use", "arts", "job_training", "faith", "restorative_justice", "other", "unknown"] as const;

export const OrgRow = z.object({
  org_id: reqStr,
  org_name: reqStr,
  org_type: z.preprocess(empty, z.enum(ORG_TYPES).nullable()).transform((v) => v ?? "unknown"),
  data_persona: z.coerce.number().int().min(1).max(4),
  primary_contact_email: z.string().email().endsWith("@example.org"),
  has_data_agreement: bool,
});

export const ContactRow = z.object({
  contact_id: reqStr,
  org_id: reqStr,
  name: str,
  email: z.string().email().endsWith("@example.org"),
  title: str,
  is_primary: bool,
  rank: z.coerce.number().int(),
});

export const ProgramRow = z.object({
  program_id: reqStr,
  org_id: reqStr,
  program_name: reqStr,
  program_category: z.preprocess(empty, z.enum(CATEGORIES).nullable()).transform((v) => v ?? "unknown"),
  completion_rule: z.preprocess(empty, z.string().nullable()).transform((v) => v ?? "unstated"),
  credit_types_offered: z.preprocess(empty, z.string().nullable()).transform((v) => v ?? ""), // pipe-separated: rac|emc
});

export const ProgramCycleRow = z.object({
  cycle_id: reqStr,
  program_id: reqStr,
  facility_code: str,
  yard: str,
  start_date: date,
  end_date: date,
  sessions_planned: int,
  course_hours_planned_per_participant: num,
  n_enrolled: int,
  n_completed: int,
  total_course_hours_delivered: num,
  source_grain: z.enum(["aggregate", "derived_from_individuals"]),
  status: z.preprocess(empty, z.enum(["draft", "awaiting_confirmation", "confirmed", "superseded"]).nullable()).transform((v) => v ?? "confirmed"),
});

/** person_identity.csv: plaintext, synthetic only. Goes through the vault, never into analytics. */
export const PersonIdentityRow = z.object({
  cdcr_number: z.preprocess(empty, SynCdcr.nullable()),
  first_name: str,
  last_name: str,
  date_of_birth: date,
  org_id: reqStr,
  org_internal_id: str,
});

const reqDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const optBool = z.preprocess(empty, bool.nullable());
/** Enum cell where blank means the column's `unknown` default. */
const enumOr = <T extends readonly [string, ...string[]]>(values: T, fallback: T[number] = "unknown") =>
  z.preprocess(empty, z.enum(values).nullable()).transform((v) => v ?? fallback);
const SOURCES = ["cbo_report", "locator", "cdcr_file", "simulated"] as const;

/** Every person-linked file uses person_ref (SYN number or org_id:internal_id); the loader swaps in person_key. */
const personRef = reqStr;

export const SessionRow = z.object({
  session_id: reqStr,
  cycle_id: reqStr,
  session_date: reqDate,
  cancelled: bool,
  cancel_reason: z.preprocess(empty, z.enum(["lockdown", "staff_unavailable", "facility_event", "holiday", "other", "unknown"]).nullable()),
});

export const SessionAttendanceRow = z.object({
  session_id: reqStr,
  person_ref: personRef,
  status: z.enum(["present", "absent", "excused", "late", "unknown"]),
});

export const ConsentRow = z.object({
  person_ref: personRef,
  org_id: reqStr,
  consent_followup: bool,
  consent_share_with_tpw: bool,
  consent_date: reqDate,
  revoked_date: date,
  consent_form_version: reqStr,
});

export const PersonAttributesRow = z.object({
  person_ref: personRef,
  birth_year: int,
  age_band_at_release: enumOr(["18_19", "20_24", "25_29", "30_34", "35_39", "40_44", "45_49", "50_54", "55_59", "60_plus", "unknown"]),
  age_band_raw: str,
  risk_band: enumOr(["low", "moderate", "high", "unknown"]),
  commitment_offense_category: enumOr(["persons", "property", "drug", "other", "unknown"]),
  sentence_type: enumOr(["determinate", "determinate_2nd_strike", "indeterminate", "third_strike", "unknown"]),
  prior_cdcr_stays_band: enumOr(["1", "2", "3", "4", "5_9", "10_plus", "unknown"]),
  county_of_release: str,
});

export const EnrollmentRow = z.object({
  enrollment_id: reqStr,
  cycle_id: reqStr,
  person_ref: personRef,
  enrollment_date: date,
  sessions_attended: int,
  sessions_planned_for_person: int,
  attendance_rate: z.preprocess(empty, z.coerce.number().min(0).max(1).nullable()),
  hours_attended: num,
  completed: z.enum(["yes", "no", "in_progress", "unknown"]),
  completion_basis: enumOr(["rule_applied", "cbo_marked", "unknown"]),
  completion_date: date,
});

export const CreditAwardRow = z.object({
  person_ref: personRef,
  cycle_id: str,
  credit_type: z.enum(["rac", "emc", "mcc", "other", "unknown"]),
  credit_days_earned: z.coerce.number().int(),
  credit_days_applied: int, // blank stays null: never copy earned into applied
  award_date: date,
});

export const CustodyStatusRow = z.object({
  person_ref: personRef,
  status: z.enum(["in_custody", "released", "unknown"]),
  projected_release_date: date,
  as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}T/, "expected an ISO 8601 timestamp"),
  source: z.enum(SOURCES),
});

export const ReleaseEventRow = z.object({
  release_id: reqStr,
  person_ref: personRef,
  release_date: reqDate,
  release_fiscal_year: str,
  release_type: enumOr(["first_release", "re_release", "discharge", "unknown"]),
  supervision_type: enumOr(["parole", "prcs", "discharged", "unknown"]),
  source: z.enum(SOURCES),
  post_program: optBool,
});

export const OutcomeEventRow = z.object({
  person_ref: personRef,
  release_id: reqStr,
  outcome_type: z.enum(["return_to_prison", "conviction", "arrest", "county_jail"]),
  outcome_date: reqDate,
  outcome_date_precision: z.enum(["exact", "interval"]),
  outcome_date_earliest: date,
  days_to_outcome: int,
  within_3yr: optBool,
  outcome_offense_category: z.preprocess(empty, z.enum(["persons", "property", "drug_alcohol", "other", "supervision_violation", "unknown"]).nullable()),
  outcome_source: z.enum(["simulated", "mock_locator", "eit_locator_verified", "eit_locator_unverified", "cdcr_file", "doj_file", "self_report"]),
  evidence_check_id: str,
});

export const FollowUpStatusRow = z.object({
  person_ref: personRef,
  release_id: reqStr,
  days_observed: z.coerce.number().int(),
  last_negative_check: date,
  censored: bool,
  follow_up_complete: bool,
});

export type OrgRow = z.infer<typeof OrgRow>;
export type ContactRow = z.infer<typeof ContactRow>;
export type ProgramRow = z.infer<typeof ProgramRow>;
export type ProgramCycleRow = z.infer<typeof ProgramCycleRow>;
export type PersonIdentityRow = z.infer<typeof PersonIdentityRow>;
export type SessionRow = z.infer<typeof SessionRow>;
export type SessionAttendanceRow = z.infer<typeof SessionAttendanceRow>;
export type ConsentRow = z.infer<typeof ConsentRow>;
export type PersonAttributesRow = z.infer<typeof PersonAttributesRow>;
export type EnrollmentRow = z.infer<typeof EnrollmentRow>;
export type CreditAwardRow = z.infer<typeof CreditAwardRow>;
export type CustodyStatusRow = z.infer<typeof CustodyStatusRow>;
export type ReleaseEventRow = z.infer<typeof ReleaseEventRow>;
export type OutcomeEventRow = z.infer<typeof OutcomeEventRow>;
export type FollowUpStatusRow = z.infer<typeof FollowUpStatusRow>;
