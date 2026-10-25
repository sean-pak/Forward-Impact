# TPW Outcome Framework: Canonical Schema v2

Status: hackathon spec. All demo data is synthetic.
Audience: Muse (synthetic data generation) and the build (ingestion, lookup, reporting).
Supersedes: canonical-schema.md (draft v1). Changes from v1 are listed in section 13.

---

## 0. How to read this doc

- Sections 1 to 3 are rules and architecture. Read them before generating anything.
- Sections 4 to 10 are the tables. Every field has a type, a required flag, and an owner zone.
- Section 11 is the synthetic data spec for Muse: the 4 personas, sizes, distributions, injected messiness, and the ground truth files.
- Section 12 is the validation checklist.

Conventions:
- Dates are `YYYY-MM-DD`. Timestamps are ISO 8601 UTC.
- Enums are lowercase snake_case. `unknown` is always a valid enum value.
- IDs are text. Never use row numbers as IDs.
- Every table has `created_at`, `submission_id` (lineage), and `is_synthetic` (boolean). These are not repeated in each table below.

---

## 1. Design principles

1. **One definition for everyone.** Every CBO report uses the same cohort, outcome, window, and denominator rules.
2. **A rate always travels with its numerator and denominator.** A rate without counts is invalid.
3. **Suppression.** Hide any rate whose denominator is under 30. Hide any count between 1 and 10 in anything shared outside the owning CBO. Show the cell as `suppressed`, never as 0.
4. **Never invent a missing value.** Use `unknown` and report the unknown share. Missing stays missing. No imputation in production reports.
5. **Process data and outcome data are different grains.** Program delivery data (hours, enrolled, completed) is keyed by program cycle. Outcome data is keyed by release cohort. Do not mix them in one row.
6. **The LLM maps, code computes.** The LLM may map messy columns to this schema and draft follow-up questions. Every count, rate, and derived field is computed in deterministic code.
7. **Simulated is always labelled simulated.** `outcome_source` and `is_synthetic` are never overwritten.
8. **Association, not cause.** Comparisons to CDCR benchmarks describe association. Participants self-select.
9. **Identifiers live in one place.** Names, DOB, and CDCR numbers exist only in the Identity Vault (section 2).

---

## 2. Data zones (who can see what)

v1 said participant rows never leave the CBO. That conflicts with the lookup requirement: someone must hold a CDCR number and name to run a custody check. v2 uses three zones.

| Zone | Holds | Who can access | Notes |
|---|---|---|---|
| **CBO zone** | The CBO's raw files and their own re-identified template | The CBO | TPW never needs to store raw files after ingestion, except encrypted for audit. |
| **Identity Vault** (TPW) | `person_identity`, `consent`, `custody_check` raw results | 1 to 2 named TPW staff + the lookup worker | Encrypted at rest. Never sent to an LLM. Never shown on dashboards. |
| **Analytics zone** (TPW) | Everything keyed by `person_key` only, plus aggregates | TPW dashboard, CBO reports | No direct identifiers. This is what the LLM may see, and only de-identified. |

The `person_key` is the only join between the vault and analytics.

### person_key rule (important change from v1)

- v1 hashed `org_id + CBO internal ID`. That cannot dedupe a person who attends programs at 2 CBOs, and it cannot be matched to an outcome source.
- v2: `person_key = HMAC_SHA256(secret_key, normalize(cdcr_number))`, truncated to 16 hex chars, prefixed `pk_`.
  - `normalize` = uppercase, strip spaces and dashes.
  - The secret key lives only in the vault. A plain unkeyed hash is not allowed: CDCR numbers are a small space (2 letters + 4 digits is about 6.8M values) and an unkeyed hash can be reversed by brute force in seconds.
- When the CDCR number is missing, fall back to `HMAC(secret, org_id + internal_id)` and set `person_key_basis = org_internal_id`. These rows cannot be looked up or deduped across CBOs. Flag them.

---

## 3. Outcome definitions

| Outcome | Definition | Denominator | Source in this build |
|---|---|---|---|
| `return_to_prison` | First admission to CDCR custody within 3 years (1,095 days) of the release date. Excludes county jail. | All released people in the cohort with a valid release date and at least the required follow-up. | Custody checks via the EIT locator (section 9), or a CDCR match file later. |
| `conviction` | First conviction for an offense committed within 3 years of release. | People with a criminal history record (CDCR uses DOJ RAP sheets). | **Not available from the locator.** Requires a CA DOJ data agreement. Synthetic only in the demo. |
| `arrest` | First arrest within 3 years of release. | Same as conviction. | **Not available.** Synthetic only. |

Rules:
- First event per outcome type only (CDCR first-episode rule).
- Day 0 is `release_date`. Day 1,095 is the last day in the window.
- An event on day 1,096 or later is excluded and flagged.
- The 3-year rate is only "final" when every person in the cohort has 1,095 days of follow-up. Before that, report interim rates (section 8.2).

### Benchmark note for TPW

The hackathon brief says recidivism falls from 45.6% to 21.1% with programming. In the CDCR FY 2020-21 report, 45.6% is the **3-year conviction rate** for people with **no enhanced credits**. People with at least one enhanced credit had 33.3%. The 3-year **return-to-prison** rate for everyone is 20.4%. The brief mixes metrics. The report must always name the outcome next to the number.

---

## 4. Reference tables

### 4.1 org

| Field | Type | Req | Notes |
|---|---|---|---|
| org_id | text | yes | `org_` + slug. Fictional in the demo. |
| org_name | text | yes | Fictional in the demo. Never attach fake outcomes to a real org. |
| org_type | enum | no | arts, education, reentry, healing, faith, legal, employment, other, unknown |
| data_persona | int | yes | 1 rich program-level, 2 sparse program-level, 3 attendance sheet, 4 individual-level |
| primary_contact_email | text | yes | Where Sam sends follow-ups. Synthetic domain `@example.org` in the demo. |
| has_data_agreement | bool | yes | CBO-TPW agreement for individual-level data. Persona 4 requires true. |

### 4.2 facility (normalization lookup)

| Field | Type | Req | Notes |
|---|---|---|---|
| facility_code | text | yes | CDCR institution abbreviation, for example `SQ`, `CMC`, `SOL`. |
| facility_name | text | yes | Canonical name, for example `San Quentin Rehabilitation Center`. |
| aliases | text[] | yes | Variants seen in raw data: `San Quentin`, `SQSP`, `S.Q.`, `quentin`. The ingester maps any alias to `facility_code`. |

Seed this with the real public list of CDCR institutions. Institution names are public facts, not personal data.

### 4.3 assumption

Every derived dollar or day figure cites a row here. Shown on every report.

| Field | Type | Notes |
|---|---|---|
| assumption_id | text | for example `cost_per_year_2026` |
| value | number | 21534 |
| unit | text | `usd_per_person_year` |
| source | text | hackathon brief |
| note | text | Marginal cost of one fewer person is lower than average cost. State this. |

---

## 5. Program delivery tables (process data)

### 5.1 program (the offering)

| Field | Type | Req | Notes |
|---|---|---|---|
| program_id | text | yes | Stable within org. |
| org_id | text | yes | |
| program_name | text | yes | |
| program_category | enum | no | education, cognitive_behavioral, substance_use, arts, job_training, faith, restorative_justice, other, unknown |
| completion_rule | text | yes | Exact stated rule, for example `attendance >= 80%`. If the CBO does not state one, store `unstated` and flag. Never assume. |
| credit_types_offered | enum[] | no | rac, emc, mcc, none, unknown. RAC = Rehabilitative Achievement Credit, EMC = Educational Merit Credit, MCC = Milestone Completion Credit. |

### 5.2 program_cycle (one run of a program) **NEW**

v1 put start and end dates on `program`. A program runs many times. Program-level submissions describe one run, so this is the grain for process data.

| Field | Type | Req | Notes |
|---|---|---|---|
| cycle_id | text | yes | `org_id` + `program_id` + `facility_code` + `start_date`. This is also the dedupe key for resubmissions. |
| program_id | text | yes | |
| facility_code | text | no | Normalized via `facility`. |
| yard | text | no | Free text, normalized to uppercase letter or name. |
| start_date | date | no | |
| end_date | date | no | >= start_date |
| sessions_planned | int | no | |
| course_hours_planned_per_participant | number | no | |
| n_enrolled | int | yes for persona 1/2 | |
| n_completed | int | no | <= n_enrolled |
| total_course_hours_delivered | number | no | Sum of hours across participants, if reported. |
| source_grain | enum | yes | `aggregate` (persona 1/2) or `derived_from_individuals` (persona 3/4) |

For personas 3 and 4, `n_enrolled` and `n_completed` are derived from `enrollment`. Never let a persona 3/4 cycle also carry a separately typed aggregate count. If both exist, the derived count wins and the mismatch is flagged.

### 5.3 session (persona 3 calendar)

| Field | Type | Req | Notes |
|---|---|---|---|
| session_id | text | yes | |
| cycle_id | text | yes | |
| session_date | date | yes | |
| cancelled | bool | yes | |
| cancel_reason | enum | no | lockdown, staff_unavailable, facility_event, holiday, other, unknown |

### 5.4 session_attendance (persona 3) **NEW, made explicit**

| Field | Type | Req | Notes |
|---|---|---|---|
| session_id | text | yes | |
| person_key | text | yes | |
| status | enum | yes | present, absent, excused, unknown. Raw marks map as: X / ✓ / P / 1 = present, blank / A / 0 = absent, E = excused. |

Cancelled sessions are excluded from both attended and planned counts for every person.

---

## 6. Person tables

### 6.1 person_identity (Identity Vault only)

| Field | Type | Req | Notes |
|---|---|---|---|
| person_key | text | yes | |
| person_key_basis | enum | yes | cdcr_number, org_internal_id |
| cdcr_number | text | no | Demo: always `SYN` + 5 digits, for example `SYN04817`. Never a real-format number in synthetic data. |
| first_name | text | no | Synthetic only in the demo. |
| last_name | text | no | Synthetic only in the demo. |
| date_of_birth | date | no | Synthetic only. |
| org_internal_ids | jsonb | no | `{ "org_a": "A-0042" }` |

### 6.2 consent **NEW**

No consent, no custody check and no individual-level outcome reporting.

| Field | Type | Req | Notes |
|---|---|---|---|
| person_key | text | yes | |
| org_id | text | yes | CBO that collected consent. |
| consent_followup | bool | yes | Allows custody checks after release. |
| consent_share_with_tpw | bool | yes | |
| consent_date | date | yes | |
| revoked_date | date | no | After revocation: stop lookups, keep already aggregated counts, delete vault identifiers. |
| consent_form_version | text | yes | |

### 6.3 person_attributes (analytics zone)

| Field | Type | Req | Notes |
|---|---|---|---|
| person_key | text | yes | |
| birth_year | int | no | Year only. Enough to compute age band. |
| age_band_at_release | enum | derived | CDCR bands: 18_19, 20_24, 25_29, 30_34, 35_39, 40_44, 45_49, 50_54, 55_59, 60_plus, unknown. |
| age_band_raw | text | no | What the CBO gave when they only gave a band, for example `18-29`. Coarse bands cannot be matched to CDCR bands. Keep raw and set `age_band_at_release = unknown`. |
| risk_band | enum | no | low, moderate, high, unknown. CSRA if known. Never invent. |
| commitment_offense_category | enum | no | persons, property, drug, other, unknown |
| sentence_type | enum | no | determinate, determinate_2nd_strike, indeterminate, third_strike, unknown |
| prior_cdcr_stays_band | enum | no | 1, 2, 3, 4, 5_9, 10_plus, unknown |
| county_of_release | text | no | |

### 6.4 enrollment

| Field | Type | Req | Notes |
|---|---|---|---|
| enrollment_id | text | yes | |
| cycle_id | text | yes | |
| person_key | text | yes | |
| enrollment_date | date | no | |
| sessions_attended | int | no | Persona 3: derived from attendance. Persona 4: reported. |
| sessions_planned_for_person | int | no | Excludes cancelled sessions. |
| attendance_rate | number 0-1 | derived | Only when both counts are known and planned > 0. |
| hours_attended | number | no | |
| completed | enum | yes | yes, no, in_progress, unknown. Bool in v1 lost `in_progress`. |
| completion_basis | enum | derived | rule_applied, cbo_marked, unknown |
| completion_date | date | no | |

### 6.5 credit_award

One row per person per credit type per cycle.

| Field | Type | Req | Notes |
|---|---|---|---|
| person_key | text | yes | |
| cycle_id | text | no | |
| credit_type | enum | yes | rac, emc, mcc, other, unknown |
| credit_days_earned | int | yes | |
| credit_days_applied | int | no | Days that actually shortened the sentence. Caps and losses make this <= earned. If unknown, leave null. Do not copy earned into applied. |
| award_date | date | no | |

Years saved = sum(`credit_days_applied`) / 365. If only earned is known, report it separately as "credit days earned (upper bound)".

---

## 7. Custody, release, and outcome tables

### 7.1 custody_status (latest known state per person)

| Field | Type | Req | Notes |
|---|---|---|---|
| person_key | text | yes | |
| status | enum | yes | in_custody, released, unknown |
| projected_release_date | date | no | From the locator or CBO, for people still inside. |
| as_of | timestamp | yes | When this was last confirmed. |
| source | enum | yes | cbo_report, locator, cdcr_file, simulated |

Most program participants are still incarcerated. They are not in any outcome cohort until they have a `release_event`.

### 7.2 release_event

| Field | Type | Req | Notes |
|---|---|---|---|
| release_id | text | yes | |
| person_key | text | yes | |
| release_date | date | yes | Day 0. Not in the future. |
| release_fiscal_year | text | derived | July 1 to June 30, formatted `FY2022_23`. |
| release_type | enum | no | first_release, re_release, discharge, unknown |
| supervision_type | enum | no | parole, prcs, discharged, unknown |
| source | enum | yes | cbo_report, locator, cdcr_file, simulated |
| post_program | bool | derived | True if release_date >= the person's latest completion_date or enrollment_date. A release before program participation does not belong in that program's outcome cohort. |

One person can have many releases. The outcome cohort uses the **first release after program participation**.

### 7.3 custody_check (every lookup, raw log) **NEW**

Every locator query, successful or not, is one row. This is the audit trail and the raw input for return-to-prison.

| Field | Type | Req | Notes |
|---|---|---|---|
| check_id | text | yes | |
| person_key | text | yes | Analytics side. Query inputs stay in the vault. |
| checked_at | timestamp | yes | |
| source_system | enum | yes | eit_locator, mock_locator, cdcr_file |
| query_method | enum | yes | cdcr_number, name, name_plus_cdcr |
| method_of_access | enum | yes | http_script, browser_automation, computer_use, manual |
| result | enum | yes | found_in_custody, not_found, multiple_matches, error, blocked |
| returned_facility | text | no | |
| returned_admission_date | date | no | Key field. A custody hit only counts as a return if admission_date > release_date. |
| returned_release_date | date | no | |
| match_confidence | enum | yes | exact_cdcr, name_and_dob, name_only, none |
| verified_by_human | bool | yes | |
| raw_response_ref | text | no | Pointer to encrypted raw result in the vault. |

### 7.4 outcome_event

First event per person per outcome type per release.

| Field | Type | Req | Notes |
|---|---|---|---|
| person_key | text | yes | |
| release_id | text | yes | |
| outcome_type | enum | yes | return_to_prison, conviction, arrest, county_jail |
| outcome_date | date | yes | >= release_date |
| outcome_date_precision | enum | yes | exact, interval. Locator snapshots only bound the date (see 9.3). |
| outcome_date_earliest | date | no | For interval precision: last check date showing no return. |
| days_to_outcome | int | derived | |
| within_3yr | bool | derived | days_to_outcome <= 1095 |
| outcome_offense_category | enum | no | persons, property, drug_alcohol, other, supervision_violation, unknown |
| outcome_source | enum | yes | simulated, mock_locator, eit_locator_verified, eit_locator_unverified, cdcr_file, doj_file, self_report |
| evidence_check_id | text | no | Link to custody_check row. |

A `found_in_custody` result with `match_confidence = name_only` produces `eit_locator_unverified` and is excluded from headline rates until a human verifies it.

### 7.5 follow_up_status (derived, one row per person per release)

| Field | Type | Notes |
|---|---|---|
| person_key, release_id | text | |
| days_observed | int | min(today, last_successful_check) minus release_date, capped at 1095. |
| last_negative_check | date | Last check that confirmed not in custody. |
| censored | bool | True if no outcome and days_observed < 1095. |
| follow_up_complete | bool | True if days_observed = 1095, or an outcome occurred within the window. |

---

## 8. Reporting tables

### 8.1 cycle_metrics (process, keyed by program cycle)

| Field | Type | Notes |
|---|---|---|
| org_id, program_id, cycle_id | text | |
| facility_code, start_date, end_date | | |
| n_enrolled, n_completed, completion_rate | | completion_rate only if completion_rule is not `unstated`, else flag. |
| total_hours_delivered, mean_hours_per_participant | number | |
| mean_attendance_rate | number | Personas 3 and 4 only. |
| credit_days_earned_total, credit_days_applied_total | int | |
| years_saved | number | applied / 365 |
| dollars_saved | number | years_saved x assumption `cost_per_year`. Cite the assumption. |
| data_quality_flags | text[] | |

### 8.2 cohort_outcome_metrics (outcome, keyed by release cohort)

One row per org (or `TPW_ALL`), program (or `ALL`), release fiscal year, outcome type, and stratum.

| Field | Type | Notes |
|---|---|---|
| org_id | text | or TPW_ALL |
| program_id | text | or ALL |
| release_fiscal_year | text | |
| outcome_type | enum | |
| stratum_field | enum | all, risk_band, supervision_type, age_band_at_release, commitment_offense_category, completed |
| stratum_value | text | |
| n_released | int | People in the cohort. |
| n_with_1yr / n_with_2yr / n_with_3yr | int | **NEW.** People with at least 1, 2, or 3 years of follow-up or an earlier event. The denominator for each interim rate. v1 used one denominator for all years, which understates interim rates. |
| n_event_1yr / n_event_2yr / n_event_3yr | int | Cumulative first events. |
| rate_1yr / rate_2yr / rate_3yr | number | n_event_Ny / n_with_Ny |
| km_3yr_estimate | number | Kaplan-Meier cumulative incidence at day 1095, using censoring. This is the projected 3-year rate for incomplete cohorts. |
| km_3yr_ci_low / km_3yr_ci_high | number | 95% CI |
| benchmark_rate_3yr | number | Matched CDCR rate, same outcome type. |
| expected_events_3yr | number | Indirect standardization: sum over strata of (stratum n x stratum benchmark). Use risk_band when known for >= 70% of the cohort, else the crude benchmark. |
| standardization_basis | enum | risk_band, supervision_type, crude |
| observed_expected_ratio | number | n_event_3yr / expected_events_3yr. Final cohorts only. |
| follow_up_complete | bool | |
| suppressed | bool | n_released < 30 |
| outcome_source_mix | jsonb | Share of events by source, for example `{ "simulated": 1.0 }`. Shown on the report. |
| data_quality_flags | text[] | |

TPW rollup: pool counts, then divide. Never average CBO rates. Show the pooled rate, median CBO rate, and range. Keep fiscal years separate.

### 8.3 benchmark_reference (long format)

v1 stored stratified rates as text blobs. v2 stores one row per rate so code can join on it.

| source | cohort_fy | outcome_type | stratum_field | stratum_value | numerator | denominator | rate |
|---|---|---|---|---|---|---|---|
| CDCR Statewide Recidivism Report FY 2020-21 | FY2020_21 | arrest | all | all | 18807 | 30116 | 0.624 |
| same | FY2020_21 | conviction | all | all | 11886 | 30116 | 0.395 |
| same | FY2020_21 | return_to_prison | all | all | 6249 | 30655 | 0.204 |
| same | FY2020_21 | conviction | risk_band | low | | | 0.184 |
| same | FY2020_21 | conviction | risk_band | moderate | | | 0.410 |
| same | FY2020_21 | conviction | risk_band | high | | | 0.564 |
| same | FY2020_21 | conviction | supervision_type | prcs | 6660 | 13611 | 0.489 |
| same | FY2020_21 | conviction | supervision_type | parole | 5220 | 16471 | 0.317 |
| same | FY2020_21 | conviction | supervision_type | discharged | 6 | 34 | 0.176 |
| same | FY2020_21 | conviction | enhanced_credit | any | 5011 | 15029 | 0.333 |
| same | FY2020_21 | conviction | enhanced_credit | none | 6875 | 15087 | 0.456 |

Notes:
- Return-to-prison by risk band and by supervision type are in the report appendix. Add them before using `return_to_prison` standardization. Until then, return comparisons use the crude rate only.
- Every follow-up year for this cohort overlaps COVID-19. Every benchmark comparison carries a period note.
- The discharged row has 34 people. Never use it for standardization.

---

## 9. Lookup adapter (EIT locator)

The stakeholder provided `https://eit-locator-production.up.railway.app/` for lookups by CDCR number or first and last name. It is a web page, not a documented API.

### 9.1 Access strategy, in order of preference

1. **Inspect the page's network calls.** A Railway-hosted single-page app almost always calls a backend JSON endpoint. If one exists, write a small HTTP client against it. Confirm with the stakeholder that scripted use is allowed. Fastest and most reliable.
2. **Browser automation (Playwright).** Fill the form, read the results table. Use if there is no clean endpoint.
3. **Computer use.** A model operating a browser screen by screen. Only if 1 and 2 fail. Slow and expensive, fine for a demo of a few lookups, not for a batch.
4. **Manual.** TPW staff run the lookup and paste the result into a form. Always available as a fallback.

All four write the same `custody_check` row. The rest of the system does not care how the lookup happened.

### 9.2 Lookup rules

- Only look up people with `consent_followup = true` and no `revoked_date`.
- Query by CDCR number first. Name-only queries produce `match_confidence = name_only` and need human verification.
- Rate limit: at most 1 query every 3 seconds, at most 200 per day, unless the stakeholder confirms higher limits.
- Log every query, including errors and blocks.
- **Never send synthetic names to the real locator.** Synthetic names can match real people, and that creates a false record about a real person. The demo uses `mock_locator` (section 11.6) for synthetic data. The real locator is only for real, consented participants, with TPW authorization.

### 9.3 Turning snapshots into outcomes

The locator shows custody at the moment of the check. It does not show history.
- A person returned and released between two checks can be missed. Check every released person at least quarterly to keep the gap small.
- If `returned_admission_date` is present, use it as `outcome_date` (`precision = exact`).
- If not, the outcome date is somewhere between the last negative check and the first positive check. Store both and use the midpoint (`precision = interval`).
- `not_found` means "not currently in custody according to this tool". It does not prove no return. This is why follow-up status and censoring are tracked separately.

---

## 10. Ingestion lineage

### 10.1 submission **NEW**

Needed for the CBO "historical submissions" report and for audit.

| Field | Type | Req | Notes |
|---|---|---|---|
| submission_id | text | yes | |
| org_id | text | yes | |
| channel | enum | yes | form, email_body, email_attachment, manual |
| received_at | timestamp | yes | |
| sender_email | text | yes | |
| raw_file_ref | text | no | Encrypted pointer. |
| detected_persona | int | no | 1 to 4, from the parser. |
| parser_version | text | yes | |
| llm_mapping_used | bool | yes | |
| status | enum | yes | received, needs_info, awaiting_confirmation, confirmed, rejected, superseded |
| followup_rounds | int | yes | Max 2, then escalate to TPW staff. |
| supersedes_submission_id | text | no | For corrections and resubmissions. |
| confirmed_by_cbo_at | timestamp | no | Data only counts in reports once confirmed. |

### 10.2 field_issue

| Field | Type | Notes |
|---|---|---|
| submission_id | text | |
| table_name, field_name | text | |
| issue_type | enum | missing_required, invalid_value, out_of_range, conflict, ambiguous_mapping |
| raw_value | text | |
| question_asked | text | What Sam asked the CBO. |
| resolved | bool | |

---

## 11. Synthetic data spec (for Muse)

### 11.1 Global rules

- Random seed: `20261024`. Same seed, same output.
- Every row: `is_synthetic = true`.
- Org names are fictional and generic. No real CBO or program names. Facility names are real CDCR institutions (public), since normalization needs them.
- Names: generate from common first and last name lists, but every person also has a `SYN` CDCR number. Never output a number in real CDCR format.
- Emails: `@example.org` only.
- Output every file twice where it applies: the **raw file** as the CBO would send it (messy), and a **ground truth file** in canonical form. The ground truth lets the build check that ingestion parsed correctly.

### 11.2 Orgs and sizes

| Org | Persona | Programs | Cycles | People | Facilities |
|---|---|---|---|---|---|
| Org A (fictional arts org) | 1 rich program-level | 3 | 12 (2021 to 2026) | ~480 total enrolled, aggregate only | SQ, SOL |
| Org B (fictional education org) | 2 sparse program-level | 2 | 8 | ~260, aggregate only | CMC, plus 1 alias variant |
| Org C (fictional healing org) | 3 attendance sheet | 1 | 4 | 60 people, 12 to 18 sessions each cycle | SQ |
| Org D (fictional reentry org) | 4 individual-level | 2 | 10 | 400 people | SOL, CMC, SQ |

Also generate `TPW_ALL` aggregate outputs from the canonical tables, not separately invented.

Persona 4 is the only source of outcomes in the demo. Org C people also get person_keys and can have simulated releases, so the demo shows 2 orgs with outcome reports.

### 11.3 Raw file formats and injected messiness

**Persona 1 (Org A), clean form or CSV, one row per cycle**
Columns: org_name, program_name, facility, yard, start_date, end_date, course_hours_per_participant, participants, completed.
Messiness: 1 facility alias, 1 date in `MM/DD/YYYY`, otherwise clean.

**Persona 2 (Org B), email body text**
A short email paragraph with numbers in prose, for example "We had about 30 guys in the spring writing class at CMC, 22 finished. Fall group was 28."
Messiness:
- missing end dates
- missing completion rule
- "about 30" (flag as approximate, do not round silently)
- 1 cycle with no completed count
- facility written as "Men's Colony"
Ground truth: what the canonical rows should be after Sam asks follow-ups, plus the list of questions Sam should ask.

**Persona 3 (Org C), wide attendance sheet (xlsx or CSV)**
One row per person, one column per session date, marks in cells.
Messiness:
- mixed marks (X, ✓, P, 1, blank, A, E)
- 2 session columns fully blank, which are lockdown days
- a notes row at the top
- 1 duplicate person row with a name spelling variant
- a merged-cell header in the xlsx version
- a "Completed?" column that disagrees with the stated 80% rule for 3 people
Ground truth: session table, attendance rows, derived sessions_attended, attendance_rate, completed under the rule, and a list of the 3 conflicts.

**Persona 4 (Org D), individual CSV**
Columns: name, CDCR #, DOB, program, facility, start, end, hours, completed, credits earned, release date, supervision, risk.
Messiness:
- 5% blank CDCR numbers
- 3 people listed in 2 programs
- column headers in non-standard words ("Inmate #", "Grad?")
- 10% blank risk
- release dates in the future for people still inside (should become projected_release_date, not release_date)
- 2 people whose release is before their program start (should be excluded from that program's outcome cohort)

### 11.4 Distributions (persona 4 and Org C)

- Age at release: 18_19 2%, 20_24 12%, 25_29 18%, 30_34 18%, 35_39 15%, 40_44 11%, 45_49 9%, 50_54 7%, 55_59 5%, 60_plus 3%.
- Risk: low 35%, moderate 30%, high 25%, unknown 10%.
- Supervision: parole 55%, prcs 43%, discharged 2%.
- Completion: 65% yes, 25% no, 10% in_progress.
- Sessions: 12 to 24 planned per cycle. Attendance rate drawn from Beta(6,2) for completers and Beta(2,3) for non-completers.
- Hours: sessions x 2 hours, with 5% blank.
- Credits: completers earn RAC 10 to 40 days, 30% also earn EMC 30 to 90 days. Applied = earned for 85%, lower for 15%, blank for 20% of people.
- Custody: 55% of people released, 45% still in custody with a projected release date.
- Release dates: spread FY2021_22 to FY2025_26, more in recent years. This gives:
  - at least 1 cohort with full 3-year follow-up (FY2021_22 and FY2022_23)
  - several interim cohorts to show the survival curve

### 11.5 Simulated outcomes

Generate with a hazard model so timing looks real:
- Base 3-year return-to-prison probability by risk band:
  - low 0.10
  - moderate 0.21
  - high 0.32
  - unknown 0.20
- Program effect multiplier:
  - completers x 0.75
  - non-completers x 1.0
  - This is a demo assumption, not a finding. Write it in the file header.
- Timing: 45% of returns in year 1, 33% in year 2, 22% in year 3. Uniform within year.
- Conviction: base 3-year probability by risk:
  - low 0.18
  - moderate 0.41
  - high 0.56
  - unknown 0.40
  - Same multipliers.
  - Every return is preceded by a conviction or a supervision violation (set 60% conviction, 40% violation).
- Arrest: conviction probability + 0.20, capped at 0.85.
- Censoring: no events after today (2026-10-24). People released less than 3 years ago are censored at today.
- Every outcome row: `outcome_source = simulated`.

### 11.6 Mock locator

Generate `mock_locator.json`, a fake response for each `SYN` number, shaped like what the real tool returns:
- cdcr_number, first_name, last_name
- status (in_custody / not_found)
- facility, admission_date, projected_release_date

It must agree with the simulated custody and outcome data:
- People with a simulated return inside the window are `in_custody` with `admission_date = outcome_date`.
- Include 3 deliberate edge cases:
  1. name-only query returning 2 matches
  2. a returned-and-released person who shows `not_found`
  3. an `error` response

The lookup adapter calls this in the demo with `source_system = mock_locator`.

### 11.7 Files to produce

```
synthetic/
  README.md                         seed, assumptions, simulation multipliers
  raw/
    org_a_persona1_programs.csv
    org_b_persona2_email.txt
    org_c_persona3_attendance.xlsx
    org_c_persona3_attendance.csv
    org_d_persona4_individuals.csv
  canonical/                        ground truth, one file per table in sections 4 to 7
    org.csv  facility.csv  program.csv  program_cycle.csv
    session.csv  session_attendance.csv
    person_identity.csv  consent.csv  person_attributes.csv
    enrollment.csv  credit_award.csv
    custody_status.csv  release_event.csv
    outcome_event.csv  follow_up_status.csv
  expected/
    cycle_metrics.csv
    cohort_outcome_metrics.csv
    sam_followup_questions.json     expected questions for persona 2 and gaps in 1, 3, 4
    validation_failures.json        rows that should fail section 12 checks, with reasons
  mock_locator.json
```

---

## 12. Validation checks

Each failure gets a plain-language message Sam can send to the CBO.

**Dates**
- `release_date` is valid and not in the future. Future dates move to `projected_release_date`. Message: "Some release dates are in the future. We've saved them as expected release dates."
- `end_date >= start_date`.
- `outcome_date >= release_date`.
- Events after day 1095 are excluded from 3-year rates and flagged.
- A release before program participation is excluded from that program's outcome cohort.

**Counts**
- `n_completed <= n_enrolled`.
- `sessions_attended <= sessions_planned_for_person`.
- `credit_days_applied <= credit_days_earned`.
- Approximate numbers ("about 30") are flagged, never silently rounded.

**Identity**
- No synthetic CDCR number without the `SYN` prefix.
- No identifier fields outside the vault.
- No custody check without active consent.

**Rates**
- Arrest and conviction use the RAP-sheet denominator. Return uses the released denominator. Interim rates use `n_with_Ny`.
- Rates with denominator < 30 are suppressed. Counts 1 to 10 are suppressed outside the owning CBO.
- Pooled rates come from pooled counts, never averaged rates.
- Unverified name-only locator hits are excluded from headline rates.
- `outcome_source` is never changed from `simulated` to anything else.

**Duplicates**
- The same `cycle_id` submitted twice produces `superseded`, not a double count.
- The same `person_key` in one cycle twice produces one enrollment.

---

## 13. Changes from v1 (summary)

| # | Change | Why |
|---|---|---|
| 1 | Three data zones with an Identity Vault | v1 said identifiers never leave the CBO, but lookups need them. |
| 2 | Keyed HMAC on CDCR number for `person_key` | v1's hash could not dedupe across CBOs or link to outcomes. An unkeyed hash of a CDCR number is reversible. |
| 3 | New `program_cycle` table | Program-level data describes one run of a program, not the program forever. Also the dedupe key. |
| 4 | Process metrics and outcome metrics split into 2 tables | v1 put n_enrolled (cycle grain) in a release-year table (cohort grain). |
| 5 | Per-year denominators and Kaplan-Meier estimate | v1 interim rates would understate recidivism. KM gives the honest projected 3-year rate now. |
| 6 | `consent`, `custody_check`, `custody_status`, `follow_up_status` tables | Needed to use the EIT locator responsibly and to handle censoring. |
| 7 | `submission` and `field_issue` lineage tables | Needed for historical CBO reports, Sam's follow-ups, and audit. |
| 8 | Benchmark table in long format with counts | Code can join on it. v1 had rates in text blobs. |
| 9 | Indirect standardization for expected events | Fairer than one crude benchmark when risk mix differs. |
| 10 | `completed` is an enum with `in_progress` | Bool forced current participants into "no". |
| 11 | Coarse age bands kept raw, not mapped | `18-29` cannot be split into CDCR bands without inventing data. |
| 12 | Suppression split into rate threshold (30) and count threshold (1 to 10) | Small counts identify people even when no rate is shown. |
| 13 | `post_program` flag on releases | A release before participation is not a program outcome. |
| 14 | Arrest and conviction marked as unavailable from the locator | Locator shows custody only. Those outcomes need DOJ data. |
| 15 | Mock locator and a rule never to query real tools with synthetic names | Synthetic names can match real people. |
| 16 | Raw plus ground truth files for every persona | So ingestion can be tested against known answers. |
