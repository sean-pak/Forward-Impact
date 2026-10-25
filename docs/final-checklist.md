# Final Checklist: Deferred Human Checks (Phases 9 to 15)

Every manual check deferred through phase 15, in one place. Work top to bottom: Part A (setup) unblocks everything, then each phase in order. Later phases reuse data from earlier ones (phase 11 needs a confirmed phase 10 submission, for example).

Phases 0 to 8 were verified on the deployed build and are not repeated here.

**How to use this file**
- Tick `[ ]` → `[x]` as you go. If a check fails, write what you saw under it (`> FAIL: ...`) and keep going where you can.
- "Expect" lines are what should happen. Anything else counts as a failure, even if it looks harmless.
- When a phase passes, tick it in `docs/PLAN.md` and tag it (`git tag phase-N`). Part C has the commands.

---

## Reference

| Thing | Value |
|---|---|
| Worker | https://tpw-worker.sean-mk-pak.workers.dev |
| Web (admin) | https://forward-impact-seanpaks-projects.vercel.app/admin |
| Sam's mailbox | `hello@seanpak.com` |
| CBO test inbox (plays the community organization) | `sean-pak@bmore-designful.com` → org "Bmore Designful Collective" |
| Staff/admin address (accepted, never ingested) | `sean.mk.pak@gmail.com` |
| Test files | `fixtures/ingest/` (persona 1 to 4), `fixtures/cbo-test/mailing-list.csv` |

**Run a SQL check against the deployed databases** (from the repo root):

```sh
cd apps/worker
pnpm exec wrangler d1 execute tpw_analytics --remote --command "SELECT ..."
pnpm exec wrangler d1 execute tpw_vault --remote --command "SELECT ..."
```

**Start from a clean state.** Two ways to do it:
- **Demo reset (recommended once Part A is done):** `/admin/demo` → tick "Delete everything and reset" → **Reset demo**. This recreates Bmore Designful Collective with the test inbox as its contact, so you don't need to re-import anything. Requires `DEMO_MODE = "true"` (A7).
- **Full reset:** `pnpm db:reset --remote --yes`. This removes the CBO test contact. Afterwards, re-import `fixtures/cbo-test/mailing-list.csv` at `/admin/contacts` (expect 3 orgs, 4 contacts, 0 rejected).

> Both resets delete everything, including the vault access log. If you loaded Muse data (A8), a demo reset wipes it unless you bundled it with `pnpm demo:bundle ./synthetic`.

**Email timing:** the cron syncs every minute. To skip the wait, click **Sync now** on `/admin/email`. The banner may read 0 if the cron got there first; that is fine.

---

## Part A: One-time setup (do this before any phase check)

These are the "HUMAN" items left in `PROGRESS.md`. Most phase checks will fail without them.

- [ ] **A1. Node 22.13 or newer.** Run `node -v`. Older versions silently skip the SQLite-backed tests, including the PII leak test, and `pnpm test` still looks green.
- [ ] **A2. Wrangler logged in.** Run `cd apps/worker && pnpm exec wrangler whoami`. If you're not logged in, run `pnpm exec wrangler login`.
- [ ] **A3. Fix the vault secrets on the deployed Worker.** On the phase 10 attempt the deployed `VAULT_ENC_KEY` was malformed (`must be base64 of exactly 32 bytes`). From `apps/worker`:
  ```sh
  pnpm exec wrangler secret put VAULT_HMAC_KEY   # paste the exact value from apps/worker/.dev.vars, no quotes
  pnpm exec wrangler secret put VAULT_ENC_KEY    # same
  ```
  The remote vault was seeded with the `.dev.vars` keys, so they must match exactly. Keep a copy in a password manager. Losing the encryption key makes identities unreadable, and changing the HMAC key orphans every person_key.
- [ ] **A4. Model secrets are set.** `pnpm exec wrangler secret list` shows `OPENROUTER_API_KEY` and `LLM_MODEL`. `LLM_MODEL` must support structured outputs.
- [ ] **A5. Apply migration 0004 (phase 14) to the remote analytics DB.**
  ```sh
  cd apps/worker
  pnpm exec wrangler d1 migrations apply tpw_analytics --remote
  ```
  Expect `0004_field_suggestions.sql` applied (0001 to 0003 are already applied). Check: `SELECT name FROM sqlite_master WHERE name = 'field_suggestions'` returns 1 row.
- [ ] **A6. Commit, push and deploy the current code.** Phase 13, phase 14 and the phase 15 work in progress are **not deployed**, and the phase 15 files are uncommitted. From the repo root:
  ```sh
  pnpm typecheck && pnpm test              # all green on Node 22.13+
  pnpm test:fixtures
  git add -A && git commit -m "..." && git push   # Vercel deploys the web app from main
  pnpm --filter worker run deploy
  ```
  Expect the Vercel deployment for the new commit to show **Ready** in the Vercel dashboard. `/admin` should have links for Lookups, Fields and Demo.
- [ ] **A7. Turn on demo mode for testing.** In `apps/worker/wrangler.toml`, set `DEMO_MODE = "true"`. Confirm `DEMO_CBO_EMAIL = "sean-pak@bmore-designful.com"`. Then run `pnpm --filter worker run deploy`. Set it back to `"false"` at the end (Part C).
- [ ] **A8. Vercel Authentication.** In Vercel → Project → Settings → Deployment Protection, turn Vercel Authentication **off**. Without this, the form link and the `/o/` report link hit a Vercel login for anyone not signed in to Vercel. To check, open `/submit/<any token>` in a private window: you should see the form or a 404, not a Vercel login.
- [ ] **A9. Muse synthetic data (needed for phases 12 and 13 only).** The fixture seed has no consents or releases, so `/admin/lookups` and the outcome panel will be empty without it.
  1. Put Muse's output at `./synthetic/` (with `canonical/` and `expected/`).
  2. Copy Muse's `mock_locator.json` over `apps/worker/src/locator/mock_locator.json`. The current file is a stand-in.
  3. Run `pnpm test` again. `scripts/src/outcomes.muse.test.ts` now runs instead of skipping, and it must pass.
  4. Run `pnpm --filter worker run deploy` (the mock locator is bundled into the Worker).
  5. Do this step just before phase 12, after phases 9 to 11 pass: `pnpm db:reset --remote --yes --data ./synthetic`, or `pnpm seed:muse ./synthetic --remote --yes`.
  - If Muse data isn't available, mark phases 12 and 13 **BLOCKED** and move on.

---

## Part B: Phase checks

### Phase 9: Clarify, answer, confirm loop

**What it set out to do:** make the core demo work entirely over email. A CBO emails rough numbers. Sam asks one question at a time (at most two rounds), sends a receipt summarizing what it understood, and the data counts on the dashboard only after the CBO replies YES. This is where the aggregate MVP is complete.

**Setup:** start from a clean state (demo reset). Bmore Designful Collective must exist with `sean-pak@bmore-designful.com` as its primary contact (`/admin/contacts`).

- [ ] **9.1 Send the data.** From `sean-pak@bmore-designful.com`, send a **new** email (not a reply) to `hello@seanpak.com`. Use any subject and paste the body of `fixtures/ingest/org_b_persona2_email.txt` (the "spring writing class ... about 30 guys" text). Click **Sync now** on `/admin/email`.
  - Expect, in under 90 seconds, a reply **in the same thread** (subject `Re: <your subject>`) signed "Sam, TPW's data assistant", asking **one** question about the approximate count: *"You gave 'about 30' for people enrolled..."*
  - Expect `/admin/submissions` to show a new submission for Bmore Designful Collective with status `needs_info`.
- [ ] **9.2 Answer question 1.** Reply in the thread: `It was exactly 31`. Sync.
  - Expect the next question in the same thread: *"What counts as completing Writing Class?"*. It's a single question, not a list.
- [ ] **9.3 Answer question 2.** Reply: `attended at least 80% of sessions`. Sync.
  - Expect a **receipt** listing two cycles:
    - Writing Class at California Men's Colony, started 2025-02-03: **31 enrolled, 22 completed**; completion means: at least 80% of sessions.
    - Writing Class at San Quentin, started 2025-09-08: **28 enrolled, completed not provided**.
  - Expect a "Not provided yet (left out of totals until you tell me)" section that mentions people completed at San Quentin.
  - Expect a line asking you to reply YES to confirm.
  - Expect `/admin` to **not** show these cycles yet.
- [ ] **9.4 Confirm.** Reply: `YES`. Sync.
  - Expect a reply starting *"Confirmed. Thank you. The information for Bmore Designful Collective now counts toward TPW's numbers."* With phase 11 deployed, it also includes a private report link.
  - Expect `/admin` (staff view) to list both cycles (CMC and SQ). Participants and hours go up accordingly. Completion rate counts only the CMC cycle, because SQ has no completed count.
  - Expect the submission on `/admin/submissions` to show as confirmed.
- [ ] **9.5 Each hop took under ~90 seconds** (or was immediate with Sync now).
- [ ] **9.6 Edge: an invented number is ignored.** Reset, then repeat 9.1. Reply to question 1 with `Around 50 I think, plus 12 more joined late`.
  - Expect Sam not to store a number the reply doesn't clearly give. It asks again or treats the reply as unclear, and nothing reads "62".
- [ ] **9.7 Edge: two unclear replies go to staff.** Reset, repeat 9.1, then reply `not sure` twice.
  - Expect, after the second round, an "escalated" email (*"...I have passed it to TPW staff. Nothing from it is counted yet..."*). The submission shows `needs_staff` on `/admin/submissions`.
- [ ] **9.8 Three clean runs in a row.** Do reset → 9.1 to 9.4 three times. All three pass with no manual fixes. (If you use `db:reset` instead of demo reset, re-import the mailing list each time.)
- [ ] **9.9 Record the backup video** of one clean run (email client and `/admin` side by side).

Known behavior (not a failure): persona 2 gets two questions, not one, because the "approximate" question ranks ahead of the completion rule.

---

### Phase 10: Individual-level ingest through the vault

**What it set out to do:** accept person-level files (attendance sheets for persona 3, individual enrollment and release rows for persona 4) from email or upload. Names, CDCR numbers and dates of birth are scrambled into the encrypted vault. The analytics database gets only keyed person IDs. Sam asks about unknown attendance marks and possible duplicate names, computes completion from the stated rule, and the receipt says how many identifiers were scrambled.

**Setup:** A3 (vault secrets) must be done, or this phase fails with no reply. Start from a clean state. Optional: to avoid an extra "which program" item in the receipt, first create a "Healing Circle" program for Bmore Designful Collective. Submit one cycle through its form link (get the token with `SELECT org_name, form_token FROM orgs` and open `/submit/<form_token>`), or ignore the extra item.

**Persona 3: attendance sheet by email**
- [ ] **10.1** From the CBO test inbox, send a new email to `hello@seanpak.com` with `fixtures/ingest/org_c_persona3_attendance.xlsx` attached and a one-line body. Sync.
  - Expect one question in the thread: *"What do 'JT' and 'L' mean ...? And does a late count as attended?"*
- [ ] **10.2** Reply: `JT means excused (court) and L means late. A late counts as attended.` Sync.
  - Expect a question about possible duplicate names, mentioning **lines 21 and 64**.
- [ ] **10.3** Reply: `YES`. Sync.
  - Expect a receipt with **60 enrolled, 37 completed**, and the line *"61 names and 60 CDCR numbers were scrambled and stored separately."*
  - Expect a "While reading your file" note mentioning the cancelled class dates (columns with no marks).
- [ ] **10.4** Reply `YES`. Expect "Confirmed...", and `/admin` now shows the cycle.
- [ ] **10.5 Same file as CSV.** Reset, then repeat 10.1 to 10.4 with `org_c_persona3_attendance.csv`. Expect the same questions and counts.

**Persona 4: individual rows**

Send this one **by email**. A staff upload at `/admin/upload` has no confirm button, and the confirmation email would only go to an `@example.org` contact, which is never emailed.
- [ ] **10.6** From the CBO test inbox, email `fixtures/ingest/org_d_persona4_individuals.csv` to `hello@seanpak.com`. Sync. Answer any question Sam asks, using the ground truth in `fixtures/ingest/org_d_persona4_individuals.expected.json`.
  - Expect a receipt with **4 cycles: 40, 38, 36, 36 enrolled; 23, 25, 27, 28 completed**, plus notes about future releases and releases before the program, if present.
- [ ] **10.7** Reply `YES`. Expect `/admin` to count the 4 cycles.
- [ ] **10.8 Upload path reads the same.** Reset, go to `/admin/upload`, pick Bmore Designful Collective, and upload the same CSV. Expect the submission detail page to show the same 4 cycles and counts, marked as not counting until the organization confirms.

**Privacy checks** (after 10.4 or 10.7)
- [ ] **10.9 Vault holds ciphertext only.**
  ```sql
  -- tpw_vault
  SELECT person_key, cdcr_enc, first_enc, last_enc, dob_enc FROM person_identity LIMIT 5;
  ```
  Expect long base64 strings. No readable names, no `SYN` numbers, no dates.
- [ ] **10.10 No identifiers in analytics.** Open `fixtures/ingest/org_c_persona3_attendance.csv` and copy one last name and one CDCR number. Then run:
  ```sql
  -- tpw_analytics
  SELECT COUNT(*) FROM enrollments WHERE person_key LIKE '%SYN%' OR person_key LIKE '%<CDCR number>%';
  SELECT COUNT(*) FROM staged_people WHERE payload LIKE '%<last name>%' OR payload LIKE '%<CDCR number>%';
  ```
  Expect 0 for both.
- [ ] **10.11 No identifiers in Worker logs.** While you do 10.1, run `cd apps/worker && pnpm exec wrangler tail` and send the email. Expect log lines like `map_columns ok` with model and latency, and no names, CDCR numbers or dates of birth.
- [ ] **10.12 Automated PII leak test passes** on Node 22.13+: `pnpm --filter worker exec vitest run src/individual/pii.test.ts src/individual/phase10.verify.test.ts`. Both must **run** (not skip) and pass.

---

### Phase 11: CBO report page (re-identified)

**What it set out to do:** give each CBO a private link (`/o/[token]`) showing its own confirmed numbers, a "Use this in your grant" paragraph, and its own participants with names. Names are decrypted through the audited vault for that org only, with no LLM involved. Another org's link must never show those names, and every view is logged.

**Setup:** a confirmed persona 3 or persona 4 submission for Bmore Designful Collective (from 10.4 or 10.7). Don't reset before this phase.

- [ ] **11.1** Open the **thanks email** from 10.4 or 10.7. Expect a line *"Your private report, with a paragraph you can use in grant applications: https://.../o/<token>"*. The receipt email also carries a report link.
- [ ] **11.2** Open the link in a **private window** (not signed in to admin or Vercel). Expect:
  - Bmore Designful Collective's confirmed numbers (participants, completion as n of N, hours). These are unsuppressed, because it's the org's own data.
  - A "Use this in your grant" paragraph using only confirmed counts. If an input was approximate, the paragraph says "about".
  - A participant table with **names and CDCR numbers** for this org's people.
  - No draft or unconfirmed cycles.
- [ ] **11.3 Access was logged.**
  ```sql
  -- tpw_vault
  SELECT * FROM vault_access_log ORDER BY id DESC LIMIT 3;
  ```
  Expect a new row with `purpose = 'org_report'`, the org's `org_id`, and `n_person_keys` > 0. Reload the page and expect one more row.
- [ ] **11.4 Another org's link shows none of these names.** On `/admin/contacts`, click **report** for a different org (for example, Fixture Reentry Network). Expect none of the names from 11.2 to appear.
- [ ] **11.5 A bad token reveals nothing.** Open `/o/not-a-real-token`. Expect a not-found page and **no** new `vault_access_log` row.
- [ ] **11.6 Page is not indexable.** View the page source of the report page. Expect a `noindex` robots meta tag and a `no-referrer` referrer policy.

Known gaps (not failures): staff views and CBO views log as the same actor. Tokens never expire. Someone in two classes appears twice in the table.

---

### Phase 12: Mock locator + custody lookups

**What it set out to do:** let TPW staff run custody checks from the dashboard against a **mock** locator (synthetic data only), so return-to-prison outcomes can be recorded. Name-only or multiple matches need a human to verify them. The real EIT locator adapter is guarded so it can never be called.

**Setup:** A9 (Muse data plus Muse's `mock_locator.json`) loaded on the remote databases and the Worker redeployed. If Muse data isn't available, mark this phase BLOCKED.

- [ ] **12.1** Open `/admin/lookups`. Expect a list of eligible people: released after their program, release date not in the future, active consent on file. Each row shows a **person_key and org, not a name**.
- [ ] **12.2 Name on hover is audited.** Hover over a row's name control. Expect a name to appear, and `SELECT * FROM vault_access_log ORDER BY id DESC LIMIT 3` (tpw_vault) shows a new `admin_vault_view` row.
- [ ] **12.3 Check one person.** Click **Check** on one row. Expect a status line such as "1 checked, 0 returns recorded, ...", and the row's last check filled in.
- [ ] **12.4 Check cohort.** Click **Check cohort**. Expect a summary ("N checked, X returns recorded, Y need verification, ..."). Each click is capped at 20 people, so repeat until it says *"Nothing to check: everyone eligible was checked today..."*.
- [ ] **12.5 Rows were written.**
  ```sql
  -- tpw_analytics
  SELECT result, match_confidence, COUNT(*) FROM custody_checks GROUP BY 1, 2;
  SELECT outcome_source, outcome_date_precision, COUNT(*) FROM outcome_events GROUP BY 1, 2;
  -- tpw_vault
  SELECT COUNT(*) FROM locator_raw;   -- equals the number of custody_checks rows
  SELECT * FROM vault_access_log WHERE purpose = 'locator_check' ORDER BY id DESC LIMIT 3;
  ```
  Expect every check to come from `mock_locator`, outcomes with `outcome_source = 'mock_locator'`, `locator_raw` holding only base64 ciphertext, and no names or CDCR numbers in `custody_checks`.
- [ ] **12.6 Multiple-match edge case.** Find the person whose name matches two locator records (the "twin" case in `mock_locator.json` → `edge_cases`). Expect the row to show **Needs verification** and **no** `outcome_events` row for that person.
- [ ] **12.7 Verify a single name-only hit.** For a row that needs verification and has exactly one match, click **Verify match**. Expect a return to be recorded, an `outcome_events` row to appear, and the custody check to show `verified_by_human = 1`. A row with several matches should say to look up by CDCR number instead.
- [ ] **12.8 SIMULATED label.** Expect mock outcomes to show **SIMULATED** on the page.
- [ ] **12.9 Real locator stays off.** `apps/worker/wrangler.toml` has `REAL_LOCATOR_ENABLED = "false"`. Run `pnpm --filter worker exec vitest run src/locator`: all guard tests pass (flag off, synthetic person, any `SYN` number, no or revoked consent, rate limit, real adapter never calls `fetch`).

---

### Phase 13: Outcome metrics (labeled SIMULATED)

**What it set out to do:** turn releases and outcome events into 1-, 2- and 3-year return-to-prison rates per release fiscal year. Each rate shows its numerator and denominator, censoring, suppression and a Kaplan-Meier projection. Every number is clearly labeled **SIMULATED** with its source, next to a named CDCR benchmark. The panel can optionally appear on the one-pager.

**Setup:** A9 loaded, and phase 13 deployed (A6).

- [ ] **13.1 Rates match Muse's expected metrics.** `pnpm --filter @tpw/scripts exec vitest run src/outcomes.muse.test.ts` **runs** (not skipped) and passes. It compares n_released, n_with_Ny, events, follow-up and KM against `synthetic/expected/cohort_outcome_metrics.csv`. If it fails, check whether Muse censored at a date other than 2026-10-24.
- [ ] **13.2 Staff view panel.** Open `/admin`. Expect an outcome panel with:
  - A red **SIMULATED** banner.
  - One row per release fiscal year (years are never pooled), each with 1/2/3-year rates shown as **n of N**.
  - A **Source** on every row (for example `simulated`, `mock_locator`).
  - Interim cohorts marked as interim.
  - A benchmark line naming the outcome, cohort and source: *CDCR FY2020-21 all releases, return to prison 20.4% (6,249 of 30,655)*.
- [ ] **13.3 Public view suppression.** Open `/admin?view=public`. Expect a cohort under 30 to show `suppressed` for the row, a year with a denominator under 30 or with 1 to 10 events to read `suppressed`, and **never 0** in place of a suppressed value.
- [ ] **13.4 One-pager with outcomes.** Click **One-pager with outcomes (PDF)** (`/api/report?outcomes=1`). Expect **exactly one page**, the outcome section labeled SIMULATED with sources, no cell text overflowing or clipped, and the "pending TPW confirmation" box replaced by the outcomes.
- [ ] **13.5 Default one-pager unchanged.** Click **Download one-pager (PDF)** (`/api/report`). Expect no outcome section and the "Recidivism context: pending TPW confirmation" placeholder still present.

---

### Phase 14: Field registry

**What it set out to do:** let TPW staff add or retire custom questions (for example "RAC eligible?") without code changes. An active field is asked by email and shown on the form; retiring it stops both. Column headers that keep showing up unmapped in uploaded tables are suggested as pending fields for staff to approve or dismiss.

**Setup:** A5 (migration 0004) and A6 (deployed). Start from a clean state.

- [ ] **14.1 Add a field.** Go to `/admin/fields` → add label `RAC eligible?`, type **Yes/no**, not required. Expect it in the active list with key `rac_eligible`.
- [ ] **14.2 Form shows it.** Get Bmore's form token (`SELECT org_name, form_token FROM orgs`) and open `/submit/<form_token>`. Expect a "RAC eligible?" input on each program box.
- [ ] **14.3 Email asks it.** From the CBO test inbox, email a **complete** submission so no other questions come first. For example:
  > Our Printmaking class at San Quentin started March 2, 2026 with 32 people enrolled and 27 completed. Completion means attending at least 80% of sessions.

  Sync. Expect a question: *"For Printmaking: RAC eligible? Please reply YES or NO."*
- [ ] **14.4 Plain YES is the answer.** Reply `YES`. Expect the receipt next, with no extra round. The answer is stored on the cycle: `SELECT extra FROM program_cycles ORDER BY rowid DESC LIMIT 1` contains `"rac_eligible"`. Reply `YES` again to confirm.
- [ ] **14.5 Retire stops both.** On `/admin/fields`, click **Retire** on RAC eligible?. Reload the form: the input is gone. Email another complete submission (change the start date): Sam does **not** ask about RAC. The answer stored in 14.4 is still there.
- [ ] **14.6 Suggested fields queue.** Copy `fixtures/ingest/org_a_persona1_programs.csv`, add a column `Volunteer count` with a number in each row, and upload it **twice** at `/admin/upload` (same org). Expect `/admin/fields` to show **Volunteer count** as **pending**. **Approve** it with a type and it becomes active. Do it again with another made-up column and **Dismiss** it: it never comes back, even after more uploads.
- [ ] **14.7 Identifier headers are never suggested.** Add a column `CDCR #` (with `SYN` values) to the same copy and upload twice. Expect it **never** to appear as a suggestion, and `SELECT * FROM field_suggestions` has no row for it.

---

### Phase 15: Hardening and rehearsal

**What it set out to do:** make the demo repeatable and safe to run live. A one-click reset restores the exact starting state. Model failures get a polite holding reply and go to staff instead of silence. Unreadable attachments get a request for CSV or Excel. A written demo script and a handoff document exist.

**Status when this list was written:** the reset (`/admin/demo`, `POST /api/demo/reset`), the holding reply, the unsupported-file reply and config errors going straight to staff are built but **uncommitted and undeployed** (Part A, step A6). `docs/DEMO.md` and `docs/HANDOFF.md` are **not written yet**. Checks 15.8 and 15.9 stay open until they exist.

**Demo reset**
- [ ] **15.1 Refuses when off.** With `DEMO_MODE = "false"` deployed, use `/admin/demo` → tick the box → **Reset demo**. Expect *"Failed (403): Demo reset is off..."* and no data changed. (Skip this if you'd rather not redeploy twice; the automated tests cover it.)
- [ ] **15.2 Needs the tick box.** With `DEMO_MODE = "true"`, click **Reset demo** without ticking the box. Expect *"Tick the box to confirm the reset."* and nothing deleted.
- [ ] **15.3 Resets to the exact start.** Tick the box and reset. Expect *"Reset done. 4 seed orgs, 10 cycles, 3 scrambled people. Bmore Designful Collective is ready for sean-pak@bmore-designful.com."* Then run:
  ```sql
  -- tpw_analytics
  SELECT (SELECT COUNT(*) FROM orgs) orgs, (SELECT COUNT(*) FROM program_cycles WHERE status='confirmed') cycles,
         (SELECT COUNT(*) FROM facilities) facilities, (SELECT COUNT(*) FROM messages) msgs,
         (SELECT COUNT(*) FROM submissions) subs, (SELECT COUNT(*) FROM outreach) outreach;
  -- tpw_vault
  SELECT (SELECT COUNT(*) FROM person_identity) people, (SELECT COUNT(*) FROM vault_access_log) log;
  ```
  Expect orgs 5, cycles 10, facilities 31, msgs 0, subs 0, outreach 0, people 3, log 0.
- [ ] **15.4 Old threads don't leak in.** After a reset, reply to an **old** Sam thread from before the reset. Expect it not to continue the old conversation. The thread is unknown now, though the sender is still a known contact.

**Error handling**
- [ ] **15.5 Unsupported file.** From the CBO test inbox, email a PDF or PNG as a **real attachment** (not pasted inline) with no numbers in the body. Sync. Expect one reply in the thread: *"Thanks for sending <filename>. I cannot read that kind of file. I can read CSV files, Excel (.xlsx) files, Word (.docx) files..."*. Sync again and expect **no second** reply.
- [ ] **15.6 Missing setting → holding reply at once.** Back up the current `LLM_MODEL` value first, then from `apps/worker` run `pnpm exec wrangler secret delete LLM_MODEL`. Email the persona 2 text from the CBO test inbox and sync.
  - Expect, within a minute, *"Thank you. I received what you sent, but I am having trouble reading it right now. I have passed it to TPW staff..."*
  - Expect `/admin/submissions` to show a `needs_staff` submission.
  - Sync a few more times: no second holding reply and no second submission.
  - **Restore it:** `pnpm exec wrangler secret put LLM_MODEL`.
- [ ] **15.7 Model outage → holding reply after ~3 minutes.** Set `LLM_MODEL` to `nonexistent/model-xyz` and email the persona 2 text again. Expect no reply for the first ~3 minutes (Sam retries), then the same holding reply and one `needs_staff` submission. **Restore `LLM_MODEL`** afterwards and confirm a fresh persona 2 email gets a normal question.

**Docs and rehearsal**
- [ ] **15.8 `docs/DEMO.md` exists** with the exact emails to send, the exact clicks, and the expected timings. Follow it word for word once.
- [ ] **15.9 `docs/HANDOFF.md` exists** and covers: accounts, secrets rotation (including the vault-key warning in A3), exactly what reaches the LLM (masked column profiles, never identifiers), mailbox migration, and the prerequisites for the real locator.
- [ ] **15.10 Rehearsal x2 (the phase's done-when check).** Run **reset → full demo → reset → full demo** with **no manual fixes** in between. A full demo here means:
  1. Phase 9 loop (persona 2 email → questions → receipt → YES → `/admin` updates).
  2. Phase 10 persona 3 attendance sheet → legend question → receipt with scrambled counts → YES.
  3. Open the report link from the thanks email (phase 11).
  4. `/admin` public view (suppressed cells), then download the one-pager.
  5. (If Muse data is bundled) `/admin/lookups` → Check cohort, and the outcome panel.

  Note how long each run took.

---

## Part C: Wrap-up

- [ ] **C1. Turn demo mode off** after testing, or right after the live demo: set `DEMO_MODE = "false"` in `wrangler.toml`, then `pnpm --filter worker run deploy`. Reset deletes everything, including the audit log, so it must not stay on.
- [ ] **C2. Real locator still off:** `REAL_LOCATOR_ENABLED = "false"`.
- [ ] **C3. Tick and tag each phase that passed.** In `docs/PLAN.md`, change `## [ ] Phase N` to `## [x] Phase N` and tick its "Done when" boxes. Add one line to that phase's section in `docs/PROGRESS.md` (for example: "Verified by the human on the deployed build on <date>"). Then:
  ```sh
  git commit -am "phases 9-15: human checks passed"
  git tag phase-9 && git tag phase-10 && git tag phase-11   # only the ones that passed
  git push && git push --tags
  ```
- [ ] **C4. Write down failures and blocked items** (for example phases 12 and 13 if Muse data never arrived) in `docs/PROGRESS.md` under the phase, so the next session picks them up.
