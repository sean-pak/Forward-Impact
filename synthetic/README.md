# Synthetic demo dataset

Everything here is invented: orgs, people, names, CDCR numbers (`SYN` + 5 digits, `SYN10000` to `SYN39999`) and emails (`@example.org`).
Seed `20261024`. Data is censored at `2026-10-24`. Regenerate with `pnpm exec tsx scripts/synthetic/generate.ts` (same seed, same bytes).

**Demo assumption, not a finding.** Simulated 3-year return-to-prison probability is a base rate by risk band (low 0.12, moderate 0.22, high 0.32, unknown 0.21),
times 0.92 for people who completed, times a supervision factor (parole 0.92, PRCS 1.12, discharged 0.6). That lands near the CDCR FY2020-21 rate of 20.4%.
Timing: 45% of returns in year 1, 33% in year 2, 22% in year 3. Participants self-select, so the product says "association, not cause".

## What is here

| File | Rows |
|---|---|
| canonical/org.csv | 12 |
| canonical/contacts.csv | 15 |
| canonical/program.csv | 25 |
| canonical/program_cycle.csv | 66 |
| canonical/session.csv | 184 |
| canonical/session_attendance.csv | 3375 |
| canonical/person_identity.csv | 1429 |
| canonical/consent.csv | 1429 |
| canonical/person_attributes.csv | 1389 |
| canonical/enrollment.csv | 1429 |
| canonical/credit_award.csv | 932 |
| canonical/custody_status.csv | 1389 |
| canonical/release_event.csv | 493 |
| canonical/outcome_event.csv | 464 |
| canonical/follow_up_status.csv | 469 |
| **total** | **13100** (about 0.76 MB of CSV) |

Also: `expected/cohort_outcome_metrics.csv`, `expected/cycle_metrics.csv`, `expected/sam_followup_questions.json`, `expected/validation_failures.json`, `mock_locator.json`.

## Shape

- 12 orgs, 3 per persona. Persona 4 orgs have `has_data_agreement = true`.
- 66 program cycle rows (65 live cycles plus 1 superseded resubmission), 2022-01 to 2026-09, at 14 of the 31 institutions: CIM, CIW, CMC, CRC, CTF, FSP, LAC, MCSP, PVSP, RJD, SAC, SCC, SOL, SQ.
- Served by fewer than 3 orgs (facility-level suppression): CIW (2), PVSP (2), SCC (1).
- 1389 distinct people (persona 3 and 4 only). Persona 1 and 2 cycles are counts only.
- 40 people attend programs at two orgs (two `person_identity` rows, same CDCR number).
- 58 persona 4 people have no CDCR number (`org_id:org_internal_id` refs). They are all still inside, because they cannot be looked up.

## Release cohorts (return to prison, TPW_ALL, post-program first release)

| Fiscal year | n_released | n_with_3yr | n_event_3yr | follow_up_complete | Public view |
|---|---|---|---|---|---|
| FY2021_22 | 27 | 27 | 6 | true | whole row (n_released < 30) |
| FY2022_23 | 158 | 158 | 22 | true | nothing hidden at 3 years |
| FY2023_24 | 152 | 58 | 39 | false | nothing hidden at 3 years |
| FY2024_25 | 98 | 13 | 13 | false | 3-yr rate (n_with_3yr < 30) |
| FY2025_26 | 28 | 3 | 3 | false | whole row (n_released < 30) |

FY2021_22 and FY2022_23 have the full 3 years of follow-up. FY2023_24 to FY2025_26 are interim (checks run about every 90 days, so the newest people have less than 3 years).
There is no FY2020_21 cohort: programs start in 2022, so releases in FY2020_21 happen before participation (`post_program = false`).
Rates differ between cohorts partly by chance (about 150 people each). An interim cohort's naive `rate_3yr` is inflated because people with an early event count in `n_with_3yr` before most others do: read `km_3yr_estimate` for the projected rate.

## Planted cases

| Case | Where | Count |
|---|---|---|
| Released before the program, came back, released again (`re_release`) | `release_event.csv` `post_program = false` rows | 24 |
| Returned and released again; only the first return counts | `release_event.csv` second `re_release` rows | 6 |
| First return after day 1,095, so excluded from 3-year rates | `outcome_event.csv` `days_to_outcome > 1095` | 2 |
| Interval-precision returns (`outcome_date_earliest`) | `outcome_event.csv` | 28 |
| Consent revoked | `consent.csv` `revoked_date` | 54 people |
| Declined follow-up | `consent.csv` `consent_followup = false` | 372 people |
| Cancelled sessions (lockdown etc.) | `session.csv` | 24 |
| Cycle with no completed count | persona 2 | 2 |
| Cycle with approximate-looking counts (30 enrolled, 22 finished) | `cy_scl_rights_pvsp_2204` | 1 |
| Cycle with no end date | persona 2 | 4 |
| Program rule `unstated` | Riverbend Release Readiness Workshop | 1 |
| Cycles still running (end date in the future, no completed count) | 5 cycles | 5 |
| Cycles waiting for CBO confirmation (do not count yet) | status `awaiting_confirmation` | 2 |
| Superseded resubmission | `cy_riv_housing_fsp_2207_v1` | 1 |

Mock locator edge cases: name-only query with two matches (Alberto Rhodes), a person who returned and was released again (`SYN34655`, shows `not_found`), an error response (`SYN28404`).
All three are released, consented people, so they appear on the lookups page.

## Choices where the contract was ambiguous

- Release rows are written only for people with follow-up consent (including those who later revoked). The Worker counts every `post_program = 1` release in `n_released` with no consent filter, and nobody may check a person who declined, so a declined person would block every cohort from `follow_up_complete`. Declined people have a consent row and `custody_status = unknown`.
- The cycle `status` enum has no `in_progress`, so a running cycle is `confirmed` with a future end date and no completed count.
- The approximate flags (`n_enrolled_approx` etc.) are filled by the loader, not the CSV. The approximate cycle just has round numbers; `expected/cycle_metrics.csv` flags it `approximate_counts`.
- Persona 3 attendance uses a shifted draw (completers 0.8 to 1.0, non-completers Beta(2,3)) instead of Beta(6,2), so an 80% rule gives about 65 to 70% completion. Completion follows the rule when it parses.
- Persona 3 birth dates are blank (an attendance sheet has none). `age_band_raw` keeps a coarse band and `age_band_at_release` is `unknown`.
- A returned person who was released again is `not_found` in the mock: they are out now. For every return still in custody the mock says `in_custody` with `admission_date = outcome_date`, including interval-precision returns (the number agrees; the real tool would not give that date).
- `release_id` and `enrollment_id` are opaque, so no identifier reaches the analytics database.
- `outcome_source_mix` is `{}` for a cohort with no events.
