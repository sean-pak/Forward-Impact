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

export type OrgRow = z.infer<typeof OrgRow>;
export type ContactRow = z.infer<typeof ContactRow>;
export type ProgramRow = z.infer<typeof ProgramRow>;
export type ProgramCycleRow = z.infer<typeof ProgramCycleRow>;
export type PersonIdentityRow = z.infer<typeof PersonIdentityRow>;
