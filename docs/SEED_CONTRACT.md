# Seed Contract (for Muse and the seed loader)

This is the exact shape of the files `pnpm seed:muse ./synthetic` accepts (loader arrives in phase 2).
It extends `docs/schema-v2.md` section 11.7. Where this file and the schema differ, this file wins for file layout; the schema wins for meaning and enums.
A test (`scripts/src/contract.test.ts`) checks every column below against the migrations in `apps/worker/migrations/analytics`.

## Rules for every file

- UTF-8 CSV, header row, comma separated, `"` quoting. File names exactly as below, in `synthetic/canonical/`.
- Empty cell = null. Never write `NULL`, `N/A`, or `unknown` to mean "missing" unless the column's enum lists `unknown`.
- Booleans: `true` or `false`. Dates: `YYYY-MM-DD`. Timestamps: ISO 8601 UTC (`2026-10-24T00:00:00Z`). Numbers: plain, no thousands separators.
- List columns (marked **pipe list**) use `|`, for example `rac|emc`. Empty = empty list.
- IDs are text and unique across the whole file set (prefix them: `org_`, `prog_`, `cy_`, `sess_`, `enr_`, `rel_`). Never row numbers.
- Enums are lowercase snake_case exactly as listed in `docs/schema-v2.md`.
- **Synthetic only.** CDCR numbers are `SYN` + 5 digits. Emails end in `@example.org`. The loader refuses the whole load on any other CDCR number or email domain.
- Same seed, same output: seed `20261024`.

### How people are referenced (differs from schema-v2)

`person_key` is a keyed HMAC computed by the loader with a secret Muse does not have. So every person-linked file uses a **`person_ref`** column instead of `person_key`:

- `person_ref` = the person's `SYN#####` CDCR number, or, when they have no CDCR number, `org_id:org_internal_id` (for example `org_fx_d:D-0003`).
- The loader maps each `person_ref` to a `person_key` using the vault code. `person_ref` never reaches the analytics database.
- Ground-truth files that schema-v2 shows with `person_key` use `person_ref` here. Everything else is the same.

### Derived columns

Provide the derived columns (`age_band_at_release`, `release_fiscal_year`, `post_program`, `attendance_rate`, `completion_basis`, `days_to_outcome`, `within_3yr`). They are ground truth: the build recomputes them in code and diffs against yours. Do not leave them blank when the inputs are known.

## Files

Columns the loader fills itself and Muse must not write: `is_synthetic` (always true), `created_at`, `submission_id`, and for orgs the two private tokens.

### org.csv
Loads into: `orgs`

| Column | Type | Required | Notes |
|---|---|---|---|
| `org_id` | text | yes | `org_` + slug |
| `org_name` | text | yes | Fictional |
| `org_type` | enum | no | arts, education, reentry, healing, faith, legal, employment, other, unknown |
| `data_persona` | int 1-4 | yes | |
| `primary_contact_email` | text | yes | `@example.org` |
| `has_data_agreement` | bool | yes | Persona 4 must be true |

### contacts.csv (optional)
Loads into: `contacts`. If absent, the loader creates one primary contact per org from `primary_contact_email`.

| Column | Type | Required | Notes |
|---|---|---|---|
| `contact_id` | text | yes | |
| `org_id` | text | yes | |
| `name` | text | no | |
| `email` | text | yes | `@example.org` |
| `title` | text | no | |
| `is_primary` | bool | yes | Exactly one true per org |
| `rank` | int | yes | 1 = highest |

### facility.csv
Not loaded. The 31 institutions are seeded from `packages/shared/src/facilities.ts`. If you provide this file, the loader checks that every `facility_code` in it exists there. Columns: `facility_code`, `facility_name`, `aliases` (**pipe list**).

### program.csv
Loads into: `programs`

| Column | Type | Required | Notes |
|---|---|---|---|
| `program_id` | text | yes | Globally unique |
| `org_id` | text | yes | |
| `program_name` | text | yes | |
| `program_category` | enum | no | education, cognitive_behavioral, substance_use, arts, job_training, faith, restorative_justice, other, unknown |
| `completion_rule` | text | yes | Exact stated rule, or `unstated` |
| `credit_types_offered` | pipe list | no | rac, emc, mcc, none, unknown |

### program_cycle.csv
Loads into: `program_cycles`. The loader computes `cycle_key` = `org|program|facility|start_date` and sets `org_id` from the program.

| Column | Type | Required | Notes |
|---|---|---|---|
| `cycle_id` | text | yes | Unique |
| `program_id` | text | yes | |
| `facility_code` | text | no | One of the 31 codes |
| `yard` | text | no | |
| `start_date` | date | no | |
| `end_date` | date | no | >= start_date |
| `sessions_planned` | int | no | |
| `course_hours_planned_per_participant` | number | no | |
| `n_enrolled` | int | yes for persona 1/2 | Persona 3/4: derived from enrollment |
| `n_completed` | int | no | <= n_enrolled |
| `total_course_hours_delivered` | number | no | |
| `source_grain` | enum | yes | aggregate, derived_from_individuals |
| `status` | enum | no | Default `confirmed` for seed data |

### session.csv
Loads into: `sessions`

| Column | Type | Required | Notes |
|---|---|---|---|
| `session_id` | text | yes | |
| `cycle_id` | text | yes | |
| `session_date` | date | yes | |
| `cancelled` | bool | yes | |
| `cancel_reason` | enum | no | lockdown, staff_unavailable, facility_event, holiday, other, unknown |

### session_attendance.csv
Loads into: `session_attendance`

| Column | Type | Required | Notes |
|---|---|---|---|
| `session_id` | text | yes | |
| `person_ref` | text | yes | |
| `status` | enum | yes | present, absent, excused, late, unknown |

### person_identity.csv
Loads into: **the vault** (encrypted), never analytics. Plaintext here is allowed only because the data is synthetic.

| Column | Type | Required | Notes |
|---|---|---|---|
| `cdcr_number` | text | no | `SYN#####`. Blank for about 5% of persona 4 |
| `first_name` | text | no | |
| `last_name` | text | no | |
| `date_of_birth` | date | no | |
| `org_id` | text | yes | Org that reported this person |
| `org_internal_id` | text | no | The org's own id, for example `A-0042`. Required when `cdcr_number` is blank |

One row per (person, org). A person at two orgs has two rows with the same `cdcr_number`.

### consent.csv
Loads into: `consents`

| Column | Type | Required | Notes |
|---|---|---|---|
| `person_ref` | text | yes | |
| `org_id` | text | yes | |
| `consent_followup` | bool | yes | |
| `consent_share_with_tpw` | bool | yes | |
| `consent_date` | date | yes | |
| `revoked_date` | date | no | |
| `consent_form_version` | text | yes | |

### person_attributes.csv
Loads into: `person_attributes`

| Column | Type | Required | Notes |
|---|---|---|---|
| `person_ref` | text | yes | |
| `birth_year` | int | no | |
| `age_band_at_release` | enum | derived | 18_19, 20_24, 25_29, 30_34, 35_39, 40_44, 45_49, 50_54, 55_59, 60_plus, unknown |
| `age_band_raw` | text | no | |
| `risk_band` | enum | no | low, moderate, high, unknown |
| `commitment_offense_category` | enum | no | persons, property, drug, other, unknown |
| `sentence_type` | enum | no | determinate, determinate_2nd_strike, indeterminate, third_strike, unknown |
| `prior_cdcr_stays_band` | enum | no | 1, 2, 3, 4, 5_9, 10_plus, unknown |
| `county_of_release` | text | no | |

### enrollment.csv
Loads into: `enrollments`

| Column | Type | Required | Notes |
|---|---|---|---|
| `enrollment_id` | text | yes | |
| `cycle_id` | text | yes | |
| `person_ref` | text | yes | One row per person per cycle |
| `enrollment_date` | date | no | |
| `sessions_attended` | int | no | |
| `sessions_planned_for_person` | int | no | Excludes cancelled sessions |
| `attendance_rate` | number 0-1 | derived | |
| `hours_attended` | number | no | |
| `completed` | enum | yes | yes, no, in_progress, unknown |
| `completion_basis` | enum | derived | rule_applied, cbo_marked, unknown |
| `completion_date` | date | no | |

### credit_award.csv
Loads into: `credit_awards`

| Column | Type | Required | Notes |
|---|---|---|---|
| `person_ref` | text | yes | |
| `cycle_id` | text | no | |
| `credit_type` | enum | yes | rac, emc, mcc, other, unknown |
| `credit_days_earned` | int | yes | |
| `credit_days_applied` | int | no | Blank when unknown. Never copy earned into applied |
| `award_date` | date | no | |

### custody_status.csv
Loads into: `custody_status`

| Column | Type | Required | Notes |
|---|---|---|---|
| `person_ref` | text | yes | |
| `status` | enum | yes | in_custody, released, unknown |
| `projected_release_date` | date | no | |
| `as_of` | timestamp | yes | |
| `source` | enum | yes | cbo_report, locator, cdcr_file, simulated |

### release_event.csv
Loads into: `release_events`

| Column | Type | Required | Notes |
|---|---|---|---|
| `release_id` | text | yes | |
| `person_ref` | text | yes | |
| `release_date` | date | yes | Not in the future |
| `release_fiscal_year` | text | derived | `FY2022_23` |
| `release_type` | enum | no | first_release, re_release, discharge, unknown |
| `supervision_type` | enum | no | parole, prcs, discharged, unknown |
| `source` | enum | yes | cbo_report, locator, cdcr_file, simulated |
| `post_program` | bool | derived | |

### outcome_event.csv
Loads into: `outcome_events`

| Column | Type | Required | Notes |
|---|---|---|---|
| `person_ref` | text | yes | |
| `release_id` | text | yes | |
| `outcome_type` | enum | yes | return_to_prison, conviction, arrest, county_jail |
| `outcome_date` | date | yes | >= release_date |
| `outcome_date_precision` | enum | yes | exact, interval |
| `outcome_date_earliest` | date | no | |
| `days_to_outcome` | int | derived | |
| `within_3yr` | bool | derived | |
| `outcome_offense_category` | enum | no | persons, property, drug_alcohol, other, supervision_violation, unknown |
| `outcome_source` | enum | yes | Always `simulated` in the demo |
| `evidence_check_id` | text | no | |

### follow_up_status.csv
Loads into: `follow_up_status`

| Column | Type | Required | Notes |
|---|---|---|---|
| `person_ref` | text | yes | |
| `release_id` | text | yes | |
| `days_observed` | int | yes | |
| `last_negative_check` | date | no | |
| `censored` | bool | yes | |
| `follow_up_complete` | bool | yes | |

## Expected (ground truth, not loaded)

Used by tests in later phases. Put in `synthetic/expected/`.

- `cycle_metrics.csv`: columns exactly as schema-v2 section 8.1 (`data_quality_flags` as **pipe list**).
- `cohort_outcome_metrics.csv`: columns exactly as schema-v2 section 8.2 (`outcome_source_mix` as a JSON string, `data_quality_flags` as **pipe list**).
- `sam_followup_questions.json`: `{ "<submission or file name>": [ { "field": "...", "issue_type": "...", "question": "..." } ] }`.
- `validation_failures.json`: `[ { "file": "...", "row": 0, "check": "...", "reason": "..." } ]` (`check` names a bullet from schema-v2 section 12).

## mock_locator.json

Served by the Worker in the demo (`source_system = mock_locator`). Must agree with the simulated custody and outcome data: a simulated return inside the window is `in_custody` with `admission_date = outcome_date`.

```json
{
  "meta": { "seed": 20261024, "generated_on": "2026-10-24" },
  "records": [
    {
      "cdcr_number": "SYN04817",
      "first_name": "...",
      "last_name": "...",
      "status": "in_custody",
      "facility": "SQ",
      "admission_date": "2025-03-02",
      "projected_release_date": "2027-01-15"
    }
  ],
  "edge_cases": {
    "name_only_two_matches": {
      "query": { "first_name": "...", "last_name": "..." },
      "matches": [ { "cdcr_number": "SYN...", "...": "same fields as a record" }, { "cdcr_number": "SYN...", "...": "..." } ]
    },
    "returned_and_released_shows_not_found": { "cdcr_number": "SYN..." },
    "error_response": { "cdcr_number": "SYN...", "error": "Service unavailable" }
  }
}
```

- One entry in `records` for every `SYN` number. `status` is `in_custody` or `not_found` (for `not_found`, the custody fields are null).
- `facility` uses the 31 codes. Dates are `YYYY-MM-DD`.
- `returned_and_released_shows_not_found` and `error_response` point at real `SYN` numbers that also appear in `records`; the edge case overrides what a lookup returns for them.
