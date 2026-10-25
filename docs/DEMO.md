# Demo script: Sam, TPW's data assistant

About 8 minutes. Everything is synthetic except the CBO test inbox. Run it twice before the real thing: reset, full run, reset, full run (`apps/worker/src/demo/rehearsal.test.ts` does the same against fakes; this is the live version).

## Before you start (the day before)

Do these once. Each one has bitten a previous session.

- [ ] Worker secrets match `apps/worker/.dev.vars`, no quotes: `cd apps/worker && pnpm exec wrangler secret put VAULT_ENC_KEY` (and `VAULT_HMAC_KEY`, `OPENROUTER_API_KEY`, `LLM_MODEL`, `API_SECRET`, the three `GOOGLE_*`). The phase 10 test failed on a malformed `VAULT_ENC_KEY`. Reset checks both keys first and says so if one is bad.
- [ ] Apply migrations to the remote DB if any are pending (`0004_field_suggestions.sql` at last check): `cd apps/worker && pnpm exec wrangler d1 migrations apply DB --remote`.
- [ ] Put Muse's output in `./synthetic` (per `docs/SEED_CONTRACT.md`), then `pnpm demo:bundle ./synthetic`. Until then reset restores the 4 fixture orgs only, so the outcomes panel is empty. The Worker has no file access, so the seed travels inside the deploy.
- [ ] Set `DEMO_MODE = "true"` in `apps/worker/wrangler.toml`, then `pnpm --filter worker run deploy`. Set it back to `"false"` after the demo (reset deletes everything, including the vault's audit log).
- [ ] `git push` so Vercel deploys. Turn off Vercel Authentication for the project, or CBO form and report links hit a Vercel login.
- [ ] Files ready on the CBO laptop, from `fixtures/ingest/`: `org_c_persona3_attendance.xlsx`. For the fallback: `org_b_persona2_email.txt`.
- [ ] The CBO test inbox is `DEMO_CBO_EMAIL` in `wrangler.toml` (`sean-pak@bmore-designful.com`). It must be signed in on the CBO laptop.
- [ ] Open `/admin` (staff) and `/admin/email` in tabs. Log in with `ADMIN_PASSWORD`.

## Five minutes before

1. `/admin/demo` -> tick "Delete everything and reset" -> **Reset demo**. Expect: `Reset done. 4 seed orgs, 10 cycles, 3 scrambled people. <org> is ready for <inbox>.` (counts grow once Muse data is bundled.)
2. `/admin/contacts`: the CBO org is listed with the inbox as its primary contact. `/admin/email`: no messages. `/admin/submissions`: empty.
3. `/admin`: dashboard shows only the fixture cycles. Switch to **Public view**: small cells read `suppressed`, not 0.
4. Open the CBO's form in a tab (the token changes on every reset, and no page lists it yet):
   `cd apps/worker && pnpm exec wrangler d1 execute DB --remote --command "SELECT form_token FROM orgs WHERE is_synthetic = 0"`, then `<web URL>/submit/<token>`.

## The script

| Time | Who | Do | Expect |
|---|---|---|---|
| 0:00 | Presenter | Say: TPW funds classes in prisons; each CBO reports differently; Sam turns whatever they send into confirmed numbers. Show `/admin` public view. | `suppressed` cells. |
| 0:45 | CBO laptop | New email **from the CBO inbox to hello@seanpak.com**. Subject: `Attendance for Healing Circle`. Body: `Attendance for spring.` Attach `org_c_persona3_attendance.xlsx`. Send. | |
| 1:00 | Presenter | `/admin/email` -> **Sync now** (or wait: the Worker syncs every minute). | Within ~90 s Sam replies **in the same thread** with one question: *What do 'JT' and 'L' mean in the attendance sheet for Healing Circle? For each one, is it present, absent, excused or late? And does a late count as attended?* |
| 2:30 | CBO laptop | Reply, exactly: `JT means excused (court) and L means late. A late counts as attended.` | Next email: *Lines 21 and 64 of your file for Healing Circle look like the same person ... Reply YES to count them once, or NO.* |
| 3:30 | CBO laptop | Reply: `YES` | The receipt: *Healing Circle at San Quentin Rehabilitation Center, started 2026-01-12: 60 enrolled, 37 completed; completion means: attended at least 80% of sessions. 61 names and 60 CDCR numbers were scrambled and stored separately.* Plus notes: 2 cancelled class dates, 1 person with no CDCR number, 3 people where the sheet's own "completed" disagrees with the rule (the rule was used). It links the private report. |
| 4:30 | Presenter | Point out: names never went to the model; the model only saw column headers and masked patterns; the counts were computed by code. `/admin/submissions` shows the submission still *awaiting confirmation*, and `/admin` has not changed. | Nothing counts yet. |
| 5:00 | CBO laptop | Reply to the receipt: `YES` | *Confirmed. Thank you ...* |
| 5:30 | Presenter | Reload `/admin`. | The cycle counts: participants and completion (37 of 60) moved. |
| 6:00 | CBO laptop | Open the report link from the receipt. | The CBO's own numbers, a paragraph for grant applications, and its 60 participants' names and CDCR numbers (re-identified; only this org's people). |
| 6:30 | Presenter | `/admin` -> **Download one-pager (PDF)**, then the version with outcomes. | One page, `suppressed` where cells are small, the outcome section labeled **SIMULATED**. |
| 7:15 | Presenter | `/admin/fields`: add `RAC eligible?` (Yes/no). Reload the CBO's form tab. | The new question is on the form. Retire it and it disappears. |
| 7:45 | Presenter | Close: `/admin/lookups` shows the mock locator (synthetic people only; the real adapter is guarded and off). | Mock outcomes marked SIMULATED. |

## If something goes wrong

- **Sam has not answered after 2 minutes.** Click **Sync now** on `/admin/email`. Then check Worker logs (`pnpm exec wrangler tail`): `map_columns` ok means the model works; `ingest failed: ... must be base64` means a vault secret is wrong.
- **The model is down.** Sam retries for about 3 minutes, then replies *I am having trouble reading it right now ... passed it to TPW staff* and the submission shows `needs_staff` on `/admin/submissions`. Use this as a talking point, then switch to the fallback.
- **A PDF or an old .xls file is attached.** Sam replies asking for a CSV or Excel file. Worth showing on purpose: attach a PDF to a fresh email and watch the reply.
- **Email is down (Gmail, or the cron).** `/admin/upload`, pick the CBO org, choose `org_c_persona3_attendance.xlsx`. It runs the same reading step and `/admin/submissions` shows what Sam found (cycles, flags, scrambled counts), but it does not start the email conversation, so nothing is confirmed or counted. Use it to show the reading, not the loop.
- **Second, simpler act (typed email):** paste `fixtures/ingest/org_b_persona2_email.txt` as the body of an email from the CBO inbox. Sam asks about "about 30" and the completion rule, one question per email, then sends the receipt.
- **Wrong state.** Reset again. It is safe to run repeatedly. If it says *Nothing was changed*, a secret or the bundle is bad. If it says *stopped part way*, run it again.

## What each reset changes

Everything in both databases, then: the 31 prisons, assumptions, benchmark rows and core fields; the bundled seed (orgs, programs, cycles, people, consents, releases, outcomes); the CBO test org with the inbox as contact and `DEMO_CBO_PROGRAMS` as known programs. Form and report tokens are new after every reset, so old links die. Gmail is not touched: old threads stay in the inbox, and a reply in a pre-reset thread is treated as new data.
