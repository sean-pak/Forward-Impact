# Task: generate the synthetic demo dataset (replaces "Muse")

You are working in the repo at `/Users/seanpak/Development-Sandbox/Forward-Impact`. Read `CLAUDE.md` first, then `docs/SEED_CONTRACT.md` (the exact file layout; it wins for layout) and `docs/schema-v2.md` (the meaning, enums, outcome definitions in sections 8 to 12; it wins for meaning). Do not change application code. You only produce data files, a generator script, and a short README.

## What this data is for

A demo of "Sam, TPW's data assistant": California prison-program nonprofits (CBOs) report class data, and TPW sees confirmed counts, completion rates, and 1/2/3-year return-to-prison rates for people who went through programs. The data must look believable to someone who knows California corrections, exercise the product's rules (suppression of small cells, "SIMULATED" labels, consent-gated custody lookups, program deserts), and stay **entirely synthetic**.

## Hard rules

- CDCR numbers are `SYN` + 5 digits. Emails end in `@example.org`. The loader refuses the whole load otherwise.
- **Use only `SYN10000` to `SYN39999`.** The repo's own fixtures use `SYN41xxx` (attendance demo) and `SYN90xxx`; do not collide with them.
- Do not use these org names (case-insensitive): `Bmore Designful Collective`, `Test CBO`, or any name starting with `Fixture`. Do not reuse ids starting `org_fx_`.
- Names are fictional and not copied from real people. No real addresses, real CDCR numbers, or real offenders.
- Same seed, same output: seed `20261024`. Use a seeded RNG; running the generator twice must give byte-identical files.
- "Today" is `2026-10-25`. Data is censored at `2026-10-24` (as of). No release date, outcome date or timestamp after that.
- Outcome rates must be plausible and honest. Make them roughly in line with the benchmark rows in `packages/shared/src/` (CDCR FY2020-21 return-to-prison 20.4%, with some variation by risk band and supervision type). Do not engineer the program group to look dramatically better; the product tells viewers "association, not cause".
- Never write `NULL`, `N/A` or `unknown` to mean missing unless the column's enum lists `unknown`. Never copy `credit_days_earned` into `credit_days_applied`.

## What to build

Write a deterministic generator at `scripts/synthetic/generate.ts` (TypeScript, run with `pnpm exec tsx`; no new dependencies, use `papaparse` which is already installed, and `node:crypto`/`node:fs`). It writes:

1. `synthetic/canonical/*.csv`: `org`, `contacts`, `program`, `program_cycle`, `session`, `session_attendance`, `person_identity`, `consent`, `person_attributes`, `enrollment`, `credit_award`, `custody_status`, `release_event`, `outcome_event`, `follow_up_status` (names and columns exactly as in `docs/SEED_CONTRACT.md`; `org.csv` is required, the rest optional but build all of them).
2. `synthetic/expected/cohort_outcome_metrics.csv` (columns exactly as schema-v2 section 8.2), `cycle_metrics.csv` (section 8.1), `sam_followup_questions.json`, `validation_failures.json`.
3. `synthetic/mock_locator.json`, then copy it over `apps/worker/src/locator/mock_locator.json`.
4. `synthetic/README.md`: what is in it, the seed, counts per file, and how the planted cases map to the product.

### Shape

- **About 12 orgs** across personas 1 to 4 (3 each; persona 4 has `has_data_agreement = true`). Org types mixed (arts, education, reentry, healing, faith, legal, employment).
- **Facilities:** cycles at about 14 of the 31 institutions (codes from `packages/shared/src/facilities.ts`; read it). Leave the rest with no program, so the "program deserts" count is meaningful. Make two or three facilities served by fewer than 3 orgs, so facility-level suppression triggers.
- **Cycles:** 45 to 70 program cycles from 2022-01 to 2026-09, mostly `status = confirmed`, a few `in_progress` (end date in the future, `n_completed` blank). Completion rules written the way real CBOs write them ("attended at least 80% of sessions", "completed all 12 modules", "unstated"). A few cycles with null `n_completed`, one with approximate-looking counts, one rule `unstated`.
- **People:** about 900 to 1,400 distinct people. For persona 3 and 4 orgs, every enrollee has a `person_identity`, `enrollment`, `session_attendance` (persona 3) and so on. For persona 1 and 2 (aggregate) orgs, cycles have counts only and **no** person rows. About 5% of persona 4 people have no CDCR number (then `org_internal_id` is required, for example `D-0042`). About 40 people attend programs at two different orgs (two `person_identity` rows with the same `cdcr_number`).
- **Sessions:** persona 3 cycles get `session.csv` rows including 1 to 3 cancelled dates (lockdown, staff_unavailable, ...). `sessions_planned_for_person` excludes cancelled sessions. `attendance_rate`, `completion_basis`, `completed` follow the cycle's stated rule when it parses.
- **Consent:** about 70% of released persona 3/4 people have `consent_followup = true`; some declined; about 5% have a `revoked_date`. Only consented people may appear in `mock_locator.json` records used for outcomes.
- **Releases and outcomes:** releases from FY2020_21 to FY2025_26 (fiscal year = July 1 to June 30, label `FY2022_23`). Early cohorts have full 3-year follow-up; the last two are interim (some people have under 3 years observed, `censored = true`). About 25 to 30 releases per fiscal year in the smaller cohorts and 150 or more in at least two, so some cohort rows fall under the product's suppression thresholds (rate denominator below 30, event counts 1 to 10) and others do not. `release_date` is never in the future. `post_program` is true only when the release is on or after the person's earliest program start. Include a few `re_release` rows and people who return and are released again (only the first event counts).
- **Outcomes:** `outcome_type = return_to_prison` for most, with some `conviction`, `arrest`, `county_jail`. `outcome_source` is always `simulated`. Mix exact and interval dates (`outcome_date_precision`, `outcome_date_earliest`). `days_to_outcome` and `within_3yr` are derived; compute them.
- **Derived columns** (`age_band_at_release`, `release_fiscal_year`, `post_program`, `attendance_rate`, `completion_basis`, `days_to_outcome`, `within_3yr`) must be filled wherever the inputs are known, per schema-v2. The repo recomputes some and diffs against yours.
- **`mock_locator.json`:** exactly the shape in `docs/SEED_CONTRACT.md`: one `records` entry per `SYN` number in the data, consistent with the simulated outcomes (a simulated return inside the window is `in_custody` with `admission_date = outcome_date`), plus the three `edge_cases`: a name-only query with two matches, a person who returned and was released again (shows `not_found`), and an `error_response`. Pick people for the edge cases who are released and consented, so they show up on the lookups page.

### The expected metrics must be independent

Compute `expected/cohort_outcome_metrics.csv` yourself from the CSVs you wrote, **straight from the definitions in schema-v2 section 8.2** (`n_released`, `n_with_1yr/2yr/3yr`, `n_event_1yr/2yr/3yr`, `follow_up_complete`, `km_3yr_estimate`, `outcome_source_mix`). Do **not** import code from `packages/shared` or `apps/worker` for this: the point is a second implementation that the repo's code is checked against. Rows needed at minimum: `org_id = TPW_ALL`, `program_id = ALL`, `outcome_type = return_to_prison`, `stratum_field = all`, one row per `release_fiscal_year`, and only post-program releases. Add per-org rows if schema-v2 asks for them.

## Check your work (all must pass before you finish)

Use Node 22 (`export PATH=/opt/homebrew/bin:$PATH`; `node --version` must be 22+).

1. Run the generator twice; `diff -r` the two outputs: no differences.
2. `pnpm --filter @tpw/scripts exec vitest run` (the contract test checks your columns against the migrations; `scripts/src/outcomes.muse.test.ts` stops skipping once `synthetic/` exists and compares the repo's cohort rates to your `expected/` file). Fix your data, not the tests, unless a test is plainly wrong, and then tell me instead of editing it.
3. `pnpm db:reset --local --data ./synthetic` completes (needs `apps/worker/.dev.vars` keys; they exist). Then `cd apps/worker && pnpm exec wrangler d1 execute DB --local --command "SELECT COUNT(*) FROM program_cycles"` and the same for `enrollments`, `release_events`, `outcome_events`.
4. `pnpm typecheck && pnpm test` pass.
5. Confirm no `SYN4xxxx` or `SYN9xxxx` numbers and no non-`@example.org` emails: `grep -rhoE 'SYN[0-9]{5}' synthetic | sort -u | awk '{n=substr($0,4)+0; if (n<10000||n>39999) print}'` prints nothing.
6. Total CSV size under 2.5 MB and under about 20,000 rows overall (the demo reset ships the CSV text inside a Cloudflare Worker and writes it in small batches).

## Do not

- Do not run `pnpm db:reset --remote`, `wrangler deploy`, or anything that touches the deployed databases or Gmail.
- Do not edit `apps/worker/src/vault/`, the migrations, `docs/PRD.md` or `docs/schema-v2.md`.
- Do not run `pnpm demo:bundle`. I will do that after reviewing.
- Do not commit. Leave the changes in the working tree.

When done, print: row counts per file, the fiscal-year cohort table (n_released, n_with_3yr, n_event_3yr, follow_up_complete) from your expected file, which cohorts fall under suppression, the list of facilities with programs, and anything in the contract or schema you found ambiguous and how you resolved it.
