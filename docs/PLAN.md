# Execution Plan (v2)

Rules: one phase per session. Each phase ends with a deployed build where everything shipped so far works end to end. Tick the box, update `docs/PROGRESS.md`, commit `phase-N: <title>`, tag `phase-N`.

Budget: ~45 to 75 minutes per phase.
- **Phases 0 to 9** = the aggregate email loop. A complete, winning demo on its own.
- **Phases 10 to 14** = individual-level data, vault, report-back, lookups, outcomes.
- **Phases 15 to 17** = stretch. Cut from the bottom.
- Phase 18 (real locator) is post-hackathon only.

Each phase: **Goal**, **Build**, **Not in this phase**, **Done when**.

---

## [x] Phase 0: Skeleton deployed

**Goal:** both apps live and talking, both databases bound.

**Build**
- pnpm monorepo: `apps/worker` (Hono), `apps/web` (Next.js App Router), `packages/shared`. Root scripts: `typecheck`, `test`, `dev`.
- Worker bindings: `DB` (tpw_analytics), `VAULT` (tpw_vault). `GET /health` runs `SELECT 1` on both. Bearer-secret middleware on `/api/*`.
- Web home page server-fetches `/health` and shows it.
- `docs/PROGRESS.md` created.

**Done when**
- [x] `/health` returns `{ ok: true, db: true, vault: true }` from the deployed Worker.
- [x] Vercel URL shows it.
- [x] `pnpm typecheck && pnpm test` passes.

---

## [ ] Phase 1: Schema, seed contract, dashboard v0

**Goal:** frozen schema, a contract Muse can generate against, and a deployed dashboard with real numbers.

**Build**
- Migrations for both DBs per PRD section 8 and `docs/schema-v2.md` (field names and enums).
- `docs/SEED_CONTRACT.md`: one entry per seedable CSV (filename, columns, types, enums, required). Identities in plaintext (`person_identity.csv`: cdcr_number, first_name, last_name, date_of_birth, org_id, org_internal_id). Plus `mock_locator.json` shape.
- Static seed: 31 CDCR facilities with aliases (source: CDCR public institutions list, cite in the file), `assumptions` (cost marked TODO), `benchmark_reference` rows from schema v2 8.3, core `fields`.
- Tiny hand fixture in `/fixtures/seed` (4 fictional orgs, contacts `@example.org`, ~10 confirmed aggregate cycles) so nothing waits on Muse.
- `packages/shared/facility.ts` `normalizeFacility()` with tests ("Men's Colony" -> CMC, "S.Q." -> SQ).
- `pnpm db:reset` (drop, migrate, seed static + fixtures), local and remote.
- Web: admin password gate. `/admin`: participants, completion rate (n/N), hours, prisons covered (x of 31), cycles table.

**Not in this phase:** vault crypto (identities in the fixture are skipped until phase 2).

**Done when**
- [ ] `/admin` shows non-zero numbers from deployed D1.
- [ ] `SEED_CONTRACT.md` exists and matches the migrations. **Hand it to Muse now.**

---

## [ ] Phase 2: Vault module + Muse seed path

**Goal:** identifiers can go in scrambled and come out only through audited code.

**Build**
- `apps/worker/src/vault/`: `normalizeCdcr`, `personKey()` (3 bases, PRD 6), `encrypt/decrypt` (AES-256-GCM, WebCrypto), `upsertIdentity()`, `reidentify(keys, purpose, actor)` writing `vault_access_log`.
- Only `vault/` may reference the `VAULT` binding (add a lint rule or a grep test).
- Tests: deterministic keys, round-trip encryption, different IV each time, wrong key fails, no plaintext in ciphertext.
- `pnpm seed:muse ./synthetic`: loads Muse CSVs per the contract; identities go through `upsertIdentity()`, everything else gets `person_key`s. Validates `SYN` prefix on every CDCR number and refuses the whole load otherwise.
- `pnpm keys:generate` prints fresh `VAULT_HMAC_KEY` / `VAULT_ENC_KEY`.

**Not in this phase:** UI for re-identification.

**Done when**
- [ ] Tests pass.
- [ ] If Muse output exists: seeded remote D1 has persons in the vault (ciphertext only, verify with a raw `SELECT`) and person_keys in analytics. If not yet: the fixture identities load the same way.

---

## [ ] Phase 3: Metrics and suppression

**Goal:** every number on screen comes from tested pure functions.

**Build**
- `packages/shared/metrics.ts`: process metrics (PRD 10). Each returns `{ value, numerator?, denominator?, isEstimate, suppressed }`.
- `packages/shared/suppress.ts`: denominator < 30, counts 1 to 10, facility < 3 orgs -> `"suppressed"`.
- `/admin` uses them; add a by-facility table and a "public view" toggle.

**Done when**
- [ ] Tests cover each metric and suppression rule.
- [ ] Public view on the deployed dashboard shows `suppressed` cells.

---

## [ ] Phase 4: One-pager PDF

**Build**
- `apps/web/app/api/report/route.ts` (Node runtime), `@react-pdf/renderer`, public view.
- Participants, completion (n/N), hours, prisons covered, program deserts, assumption footnotes, "association, not cause", recidivism context placeholder marked "pending TPW confirmation".

**Done when**
- [ ] One click downloads a clean one-page PDF with live numbers; suppressed metrics read `suppressed`.

---

## [ ] Phase 5: Gmail connection

**Goal:** the Worker can read and send as `hello@seanpak.com`.

**Build**
- `scripts/google-auth.ts` (`pnpm google:auth`): loopback OAuth, prints refresh token. Print the human setup checklist (PRD 11) if env is missing.
- `apps/worker/src/gmail/`: token refresh (cache access token in memory with expiry), `listUnprocessed()`, `getRaw()`, `send({ to, cc?, subject, text, html?, threadId?, inReplyTo?, references? })` via `mimetext`, `label()`, `archive()`. Creates `sam/processed` and `sam/ignored` labels if missing.
- Cron Trigger every minute + `POST /api/gmail/sync`. Sync only **logs** matched messages (sender known or thread known) to `messages`; unknown senders get `sam/ignored` and nothing else. No LLM yet.
- Admin: "Send test email" form and "Sync now" button, plus an inbound messages list.

**Done when**
- [ ] Test email from admin arrives in the CBO account.
- [ ] A reply from the CBO account shows in admin within ~60 s, labeled `sam/processed` in Gmail.
- [ ] Mail from an unknown sender is labeled `sam/ignored` and not logged.

---

## [ ] Phase 6: Mailing list import + asks

**Goal:** TPW sends one ask per CBO from its list.

**Build**
- Admin `/admin/contacts`: CSV import (org, name, email, title), create orgs if new, pick one primary per org (default: highest rank).
- "Send asks" (all or selected orgs): `ask` template with the org's form link (`/submit/[form_token]`) and "or just reply with whatever you have: numbers, spreadsheets, attendance sheets, photos." Sent individually, never as a group.
- `outreach` rows, open pixel `GET /p/:message_id.gif` (labeled approximate), reply detection on sync.
- `/admin/outreach`: sent, opened (approx), replied, time to reply, response rate.

**Done when**
- [ ] Import a 3-org CSV, send asks, the CBO account receives one; replying marks it replied in outreach.

---

## [ ] Phase 7: Structured form

**Build**
- `/submit/[token]`: org's programs, facility picker (31 + alias search), dates, sessions, hours, enrolled, completed, completion rule, active registry fields. Pre-filled from last confirmed cycle.
- Writes `submission` (`channel = form`) + draft cycles + issues; shows a confirm screen; confirm marks it confirmed.

**Done when**
- [ ] Submitting the form updates the deployed dashboard after confirm.

---

## [ ] Phase 8: Aggregate ingest (email + admin upload)

**Goal:** program-level replies become draft cycles with issues.

**Build**
- `packages/shared/schemas.ts`: `ExtractionResult`, `ColumnMapping` (zod).
- `apps/worker/src/llm.ts`: OpenRouter, JSON-schema output, zod validation, one retry, timeout. Logs model + latency, never inputs.
- `ingestText` (body + DOCX via mammoth) and `ingestTable` for **persona 1** via masked column profiles (PRD 7.3).
- Sync routes new-data messages from known contacts into ingest -> `submission` (`needs_info` or `awaiting_confirmation`) + `field_issues`.
- Admin `/admin/upload` runs the same pipeline (on-stage fallback). `/admin/submissions` list + detail.
- Fixtures: persona 2 email text, persona 1 CSV, with expected JSON. `pnpm test:fixtures` uses recorded LLM responses. Prefer Muse's raw files when present.

**Not in this phase:** replies to the CBO, person-level files.

**Done when**
- [ ] Persona 2 email: "about 30" flagged approximate, missing completion rule flagged, "Men's Colony" -> CMC.
- [ ] Persona 1 CSV produces expected cycles.
- [ ] Same results whether sent by email or uploaded.

---

## [ ] Phase 9: Clarify, answer, confirm loop

**Goal:** the live demo loop works over email. **Aggregate MVP complete here. Record a backup video.**

**Build**
- `packages/shared/questions.ts` (PRD 7.7), tested.
- Templates: `clarify`, `confirm_receipt`, `thanks`, `escalated`.
- Replies sent in-thread (`threadId`, `In-Reply-To`, `References`, `Re:` subject).
- Reply handling (PRD 7.5): intent classification, apply, next question or receipt. Superseding by `cycle_key`. Max 2 rounds -> `needs_staff`.

**Done when**
- [ ] From the CBO account: send persona 2 text -> one question -> answer -> receipt -> "yes" -> dashboard updates. Under ~90 s per hop (or immediate with Sync now).
- [ ] Three runs in a row from `db:reset`.

---

## [ ] Phase 10: Individual-level ingest through the vault

**Goal:** attendance sheets and individual rows land scrambled.

**Build**
- XLSX via SheetJS: header detection, notes rows, merged headers.
- Persona 3 path (PRD 7.3): marks, cancelled columns, `late` status, unknown marks -> legend question ("What do 'JT' and 'L' mean? Does late count as attended?"), duplicate-name flag, rule-based completion, conflict count.
- Persona 4 path: enrollments, attributes, credits, custody_status, release_events, future dates -> projected, pre-program releases -> `post_program = false`.
- Identifier columns -> `vault.upsertIdentity()`; analytics gets `person_key` only.
- **PII leak test:** run all persona fixtures, then assert no fixture name, CDCR number, or DOB appears in any analytics row, log line, or LLM request body.
- Receipt says "N names and M CDCR numbers scrambled".

**Done when**
- [ ] Persona 3 fixture by email: legend question asked, answer applied, attended/planned and completions match expected.
- [ ] Persona 4 fixture: per-program counts match expected; vault has ciphertext only.
- [ ] PII leak test passes.

---

## [ ] Phase 11: CBO report page (re-identified)

**Goal:** the CBO sees its own people, mapped back, without the LLM in the path.

**Build**
- `/o/[private_token]`: org's confirmed cycles, metrics (unsuppressed for own data), and a participant table re-identified via `vault.reidentify(..., purpose: "org_report")`.
- Worker route returns re-identified rows only for that org's person_keys. Every view logs to `vault_access_log`.
- Receipt email includes the link. "Use this in your grant" copy block.

**Done when**
- [ ] Link from the receipt shows names for that org only; another org's token never returns them; access log row written.

---

## [ ] Phase 12: Mock locator + lookups

**Goal:** TPW runs custody checks from the dashboard (synthetic data only).

**Build**
- Worker serves `GET /mock-locator/search?cdcr=&first=&last=` from Muse's `mock_locator.json` (include the 3 edge cases from schema v2 11.6).
- `locator/` adapter interface; `mockLocator` and an `eitLocator` stub that **throws** unless every guard passes (PRD 9). Guard tests: synthetic person refused, `SYN` number refused, no consent refused, flag off refused.
- Admin `/admin/lookups`: eligible released + consented people (shown by person_key and org, names only on hover via audited reidentify), "Check" and "Check cohort" buttons, rate limited.
- Results -> `custody_checks`, encrypted `locator_raw`, `outcome_events` (exact vs interval dates; name-only = unverified, excluded until a human verifies in the UI).

**Done when**
- [ ] Checking a cohort writes checks and outcome events; the multiple-match edge case shows as needs verification.
- [ ] All guard tests pass.

---

## [ ] Phase 13: Outcome metrics (labeled simulated)

**Build**
- `packages/shared/outcomes.ts`: cohort building (first post-program release), 1/2/3-year return rates with `n_with_Ny` denominators, censoring, suppression. Tests against Muse's `expected/cohort_outcome_metrics.csv`.
- Dashboard outcome panel per release fiscal year with n/N, big **SIMULATED** label, `outcome_source_mix`, benchmark line naming outcome + cohort + source.
- Add the outcome panel to the one-pager behind a toggle (off by default).

**Done when**
- [ ] Rates match Muse's expected metrics; every outcome number shows its source label.

---

## [ ] Phase 14: Field registry

**Build**
- `/admin/fields`: add (key, label, type, required, ask template), retire. AI-suggested fields queue (recurring unmapped columns -> `pending`).
- Question selector and form both read active fields; answers land in `extra`.

**Done when**
- [ ] Add "RAC eligible?" -> next email asks it and the form shows it; retiring stops both.

---

## [ ] Phase 15: Hardening and rehearsal

**Build**
- `POST /api/demo/reset` (DEMO_MODE): exact demo starting state.
- Errors: LLM timeout -> holding reply + `needs_staff`; unsupported file -> ask for CSV/XLSX.
- `docs/DEMO.md` (exact emails, clicks, timings) and `docs/HANDOFF.md` (accounts, secrets rotation, what reaches the LLM, mailbox migration, real-locator prerequisites).

**Done when**
- [ ] Reset -> full demo -> reset -> full demo, no manual fixes.

---

## [ ] Phase 16 (stretch): Sign-in sheet photo
Vision extraction to rows; names go straight to the vault; receipt notes the photo was read by the model. Done when a photo yields correct counts and scrambled identities.

## [ ] Phase 17 (stretch): Follow-ups and memory
Cron nudges (day 3), escalation to next contact (day 7), max 3 touches, time-warp button; asks pre-filled from last confirmed cycle.

## [ ] Phase 18 (post-hackathon only): Real locator
Requires TPW written authorization, confirmation that scripted access is allowed, and real consented participants. Inspect the site's network calls for a JSON endpoint; else Playwright outside the Worker. Never enabled against synthetic data.
