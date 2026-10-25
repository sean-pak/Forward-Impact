# PRD: Sam, TPW's Data Assistant (v2)

Hackathon MVP. Hack for Social Impact SF, Oct 24 to 25, 2026. Solo build.
All demo data is synthetic (generated with Meta Muse). Supersedes PRD v1.

---

## 1. Problem and goal

Transformative Programming Works (TPW) is a coalition of ~120 community-based orgs (CBOs) running rehab programs in California's 31 state prisons. Only ~25% of members submit program data, because the current Google Form is tedious, lands in a noisy listserv, and asks orgs to build the data themselves. So TPW lobbies with anecdotes.

**Goal:** turn member reporting into a 2-minute reply, store it safely (identifiers scrambled), and give TPW a dashboard plus outcome lookups that produce legislator-ready numbers.

## 2. The loop

1. **Ask.** Sam (from `hello@seanpak.com`, a Google Workspace inbox) emails **one contact per CBO**, individually, from an imported mailing list. The email offers two paths: a private structured form link, or "just reply with whatever you have" (typed numbers, spreadsheets, attendance sheets, photos; program-level or individual-level).
2. **Ingest.** Sam parses the reply. Identifiers (names, DOB, CDCR numbers) are split off in code, encrypted, and stored in a separate **Identity Vault**. Everything else is stored keyed by a pseudonymous `person_key`. The LLM never sees vault contents.
3. **Clarify.** If fields are missing or ambiguous (e.g. initials or "L" marks on an attendance sheet: attended, late, or absent? does late count?), Sam replies in-thread with **one question per email**, max 2 rounds, then flags TPW staff.
4. **Confirm.** Sam replies with a receipt: what was kept, what was scrambled, and a private report link. The CBO replies "yes" (or fixes something). Data only counts once confirmed.
5. **Report back.** The CBO's private report page re-identifies their own participants through deterministic code (vault lookup + decrypt). No LLM in that path. Access is logged.
6. **TPW dashboard.** Key metrics across all orgs (suppressed where small), a one-click one-pager PDF, and **custody lookups** via the locator adapter to compute return-to-prison outcomes for consented, released participants.

## 3. Users

| User | Does | Surface |
|---|---|---|
| TPW staff | Imports list, sends asks, reviews submissions, manages fields, runs lookups, downloads report | Admin web app (password-gated) |
| CBO contact | Replies to email or fills the form; views own report | Email, `/submit/[token]`, `/o/[token]` |
| Judges | Watch the live loop | Both |

## 4. Scope

### MVP (in plan order)
- Gmail connection: poll `hello@seanpak.com`, send in-thread replies.
- Mailing list import, one-per-org asks, outreach tracking.
- Structured form path.
- Aggregate ingest (text, CSV, XLSX, DOCX) with clarify/confirm loop.
- Individual-level ingest (attendance sheets, individual rows) through the vault.
- CBO re-identified report page.
- Mock locator lookups (synthetic data) writing `custody_check` rows, and labeled-simulated outcome metrics.
- Field registry (add/retire fields; questions follow). This is an explicit judging criterion.
- TPW dashboard + one-pager PDF.

### Stretch
- Sign-in sheet photo ingest (vision).
- Follow-up nudges and escalation with a time-warp button.
- Gmail push notifications (Pub/Sub) instead of 1-minute polling.

### Not during the hackathon
- **Querying the real locator.** The adapter is built and guarded but not enabled. See section 9.
- Kaplan-Meier CIs, matched comparison groups, DOJ conviction/arrest data.
- Org-vs-org rankings.

## 5. Architecture

```
 CBO contact (any email)            TPW staff browser            CBO browser
        |  ^                                |                          |
        v  |                                v                          v
 Gmail: hello@seanpak.com          Next.js on Vercel (apps/web): /admin, /submit/[t], /o/[t]
 (Google Workspace)                         | server-side fetch + bearer secret
        |  ^ Gmail API (poll + send)        v
        +--+-------------------- Cloudflare Worker (apps/worker, Hono)
                                   scheduled(): poll Gmail every minute
                                   fetch(): /api/*, /mock-locator/*, /p/:id.gif
                                    |            |              |
                              D1: analytics   D1: vault      OpenRouter
                              (person_key     (encrypted     (never sees
                               only)           identifiers)   vault data)
```

### Stack

| Layer | Choice | Notes |
|---|---|---|
| Mailbox | Gmail API on `hello@seanpak.com` | No DNS changes. Google Cloud project in the seanpak.com Workspace, OAuth consent type **Internal**, scope `gmail.modify`. Refresh token stored as a Worker secret. Mailbox address is configurable for handoff to a TPW-owned mailbox. |
| Inbound | Worker Cron Trigger every minute + "Sync now" button | Query `in:inbox -label:sam/processed`. Only messages from known contacts or in known threads are processed. Everything else gets `sam/ignored` and is never sent to the LLM. |
| Outbound | Gmail API `users.messages.send` with `threadId`, `In-Reply-To`, `References` | MIME built with `mimetext`. |
| Runtime | Cloudflare Workers **Paid ($5/mo)** | Free tier's 10 ms CPU cap breaks XLSX parsing and crypto over many rows. |
| Databases | Two D1 databases: `tpw_analytics`, `tpw_vault` | Separate DBs make the zone boundary real. Only vault-module code holds the vault binding's queries. |
| Crypto | WebCrypto: HMAC-SHA256 for keys, AES-256-GCM for identifiers | Keys are Worker secrets. |
| LLM | OpenRouter, pinned paid model via `LLM_MODEL` | Provider `data_collection: "deny"`. No `:free` models. |
| Frontend | Next.js App Router on Vercel | Calls Worker `/api/*` only. No direct DB access. |
| Auth | Admin password (middleware + httpOnly cookie). Org pages: unguessable token links. | Upgrade path: Clerk / email OTP. |
| PDF | `@react-pdf/renderer` in a Next route handler | |
| Object storage | None | Vault rows live in D1. Raw files are processed in memory. |

## 6. Identity handling ("scrambling")

TPW's condition: names and CDCR numbers are scrambled. Implementation is **keyed pseudonymization + encryption**, not plain hashing (hashes cannot be reversed, so they cannot support re-identification or lookups; unkeyed hashes of CDCR numbers are brute-forceable in seconds).

- `normalize(cdcr)` = uppercase, strip spaces and dashes.
- `person_key = "pk_" + hex(HMAC_SHA256(VAULT_HMAC_KEY, "cdcr:" + normalize(cdcr)))[0:16]`, basis `cdcr_number`.
- No CDCR number: `HMAC(VAULT_HMAC_KEY, "org:" + org_id + ":" + internal_id)`, basis `org_internal_id`; else `HMAC(..., "name:" + org_id + ":" + normalize(first last) + ":" + dob?)`, basis `org_name`. These cannot be looked up or deduped across orgs; flagged.
- Vault stores `cdcr_enc`, `first_enc`, `last_enc`, `dob_enc` as AES-256-GCM ciphertext (random 12-byte IV per field, `base64(iv|ct)`), key `VAULT_ENC_KEY`.
- Re-identification = `vault.reidentify(person_keys, purpose, actor)`: select + decrypt + write `vault_access_log`. Only called by: the CBO report page (own org only), the locator adapter, and an admin vault view.
- Analytics DB, logs, LLM prompts, and error messages never contain identifiers. Enforced by tests.
- Revocation: deleting a person's vault row leaves analytics rows orphaned and unidentifiable (crypto-shred).
- Disclosure for handoff: a sign-in sheet **photo** and free-text email bodies reach the vision/LLM model before identifiers can be stripped. Spreadsheets do not (section 7.3). Raw emails also remain in the Gmail mailbox; after processing Sam labels and archives them, and production should use a TPW-owned mailbox with a retention policy.

## 7. Pipelines

### 7.1 Gmail sync
1. Cron (every minute) or "Sync now": list unprocessed inbox messages, fetch `format=raw`, parse with `postal-mime`.
2. Match: thread in `messages` table, or sender in `contacts`. Otherwise label `sam/ignored`, stop.
3. Route: reply to an open question -> 7.5. New data -> 7.2 to 7.4. Label `sam/processed`, archive.

### 7.2 Text and DOCX (program-level)
DOCX -> text (mammoth). LLM returns `ExtractionResult` (zod): cycles with program, facility_raw, yard, dates, sessions, hours, enrolled/completed with `_approx` flags, completion_rule_stated, evidence; plus detected persona. Code normalizes facilities, parses dates, validates.

### 7.3 Spreadsheets (CSV/XLSX, any persona)
- Code parses, finds the header row (skips notes rows, handles merged headers).
- Code builds a **masked column profile** per column: header, inferred type, pattern (`Aaaa Aaaa`, `SYN#####`, `YYYY-MM-DD`, `X|P|L|A|blank`), distinct count, null share. No raw values.
- LLM returns `ColumnMapping`: column -> canonical field | `id_first_name` | `id_last_name` | `id_full_name` | `id_cdcr` | `id_dob` | `session_date` | `ignore`, plus detected persona and any unmapped mark symbols.
- Code splits each row: identifier columns -> vault (get `person_key`), the rest -> analytics.
  - Persona 1 (one row per cycle): `program_cycles`.
  - Persona 3 (wide attendance): `sessions`, `session_attendance`, `enrollments` with derived attended/planned/rate and rule-based completion. Fully blank columns = cancelled. Unknown marks (initials, "L") -> `ambiguous_mapping` issue asking for the legend and whether late counts as attended. Duplicate name variants -> flagged for confirmation, not silently merged.
  - Persona 4 (individual rows): `enrollments`, `person_attributes`, `credit_awards`, `custody_status`, `release_events` (future "release" dates become `projected_release_date`; releases before program start get `post_program = false`).
  - Cycle aggregates for personas 3/4 are **derived** from enrollments (`source_grain = derived_from_individuals`).

### 7.4 Structured form
`/submit/[token]` shows the org's programs and active registry fields, pre-filled from the last confirmed cycle. Submits to the same submission + issues pipeline, `channel = form`. Supports CSV upload too.

### 7.5 Reply handling
LLM classifies the reply against the open question: `{ intent: confirm | answer | correction | unclear, field_key, value, approx }`. Code validates, applies, resolves the issue, then asks the next question or sends the confirmation receipt. `confirm` -> cycles/enrollments `confirmed`; same `cycle_key` confirmed twice -> prior `superseded`.

### 7.6 Validation (each failure becomes a `field_issue` with a plain-language message)
Schema v2 section 12, plus: approximate counts flagged; unstated completion rule blocks completion rate; derived count beats typed aggregate (conflict logged); unmatched facility -> `ambiguous_mapping`; missing required registry field -> `missing_required`.

### 7.7 Question selection (deterministic, in `packages/shared`)
Priority: required core fields (enrolled, facility, start date) > conflict > ambiguous_mapping (incl. attendance legend) > approximate > other required > registry fields. One question per email. After 2 rounds -> `needs_staff`.

### 7.8 Outbound templates (code, not LLM prose)
`ask`, `clarify`, `confirm_receipt` (kept per cycle, "N names and M CDCR numbers scrambled", report link, "Reply YES to confirm"), `thanks`, `escalated`. Plain text + minimal HTML (open pixel). Signature: `Sam, TPW's data assistant`. Never claims to be human.

## 8. Data model

Follows `docs/schema-v2.md` sections 4 to 10 for field names and enums, with these placements and changes.

**tpw_vault**: `person_identity` (person_key PK, person_key_basis, cdcr_enc, first_enc, last_enc, dob_enc, org_ids JSON, is_synthetic, created_at), `vault_access_log` (id, at, actor, purpose, org_id, n_person_keys), `locator_raw` (check_id, query_enc, response_enc).

**tpw_analytics**: `orgs` (+ `private_token`, `form_token`, `has_data_agreement`), `contacts` (+ `is_primary`, `rank`), `facilities`, `programs`, `program_cycles` (+ `status`, `_approx` flags, `extra` JSON for registry fields), `sessions`, `session_attendance` (status enum adds `late`), `enrollments`, `person_attributes`, `credit_awards`, `consents`, `custody_status`, `release_events`, `custody_checks`, `outcome_events`, `submissions`, `field_issues`, `fields`, `messages`, `outreach`, `assumptions`, `benchmark_reference`, `settings`.

Every table: `created_at`, `submission_id` where applicable, `is_synthetic`.

**Seed contract:** phase 1 writes `docs/SEED_CONTRACT.md`: exact CSV filenames and columns the seed script accepts. Muse generates to that contract (identities in **plaintext**, synthetic only; the seed script runs them through the vault). Muse also generates `mock_locator.json` (schema v2 section 11.6).

## 9. Locator (custody lookups)

The EIT locator (`https://eit-locator-production.up.railway.app/`) holds **real CDCR data**.

- Adapter interface: `lookup({ cdcr? , first?, last? }) -> LocatorResult`. Implementations: `mockLocator` (served by the Worker from Muse's `mock_locator.json`), `eitLocator` (real).
- Every lookup writes a `custody_checks` row (analytics, no identifiers) and an encrypted `locator_raw` row (vault). Results become `outcome_events` per schema v2 section 9.3; name-only hits are `eit_locator_unverified` and excluded from headline rates until a human verifies.
- **Hard guards on `eitLocator`** (enforced in code and tested):
  - Disabled unless `REAL_LOCATOR_ENABLED=true`.
  - Refuses any person with `is_synthetic = 1` or any CDCR number starting with `SYN`. Synthetic names can match real people and create false records about them.
  - Requires active consent (`consent_followup = true`, no `revoked_date`).
  - Rate limit 1 query / 3 s, 200 / day.
- During the hackathon the dashboard runs lookups only against the mock. Enabling the real adapter requires TPW authorization, confirmation that scripted access is allowed, and real consented participants.

## 10. Metrics

**Process (per cycle, from confirmed data):** participants, completion rate (stated rule only, n/N shown), hours, mean attendance, prisons covered (x of 31), program deserts, est. credit days and est. cost avoided (labeled estimate / upper bound, citing `assumptions`).

**Outcomes (per release cohort, schema v2 section 8.2):** return-to-prison 1/2/3-year rates with per-year denominators (`n_with_Ny`), post-program releases only, first event only. Every outcome view carries `outcome_source_mix` and a visible **SIMULATED** label in the demo. Benchmark context names the outcome, cohort year, and source; association, not cause.

**Suppression (outside the owning org):** rate denominator < 30, counts 1 to 10, facility cells with < 3 orgs -> `suppressed`. Pool counts then divide. The private org page is exempt for its own data.

## 11. Setup the human must do

- [ ] Cloudflare account on Workers Paid. Create D1 `tpw_analytics` and `tpw_vault`.
- [ ] Google Cloud project under the seanpak.com Workspace: enable Gmail API, OAuth consent screen **Internal**, OAuth client (Desktop). Run `pnpm google:auth` once to mint a refresh token.
- [ ] Gmail labels are created by the code; nothing manual.
- [ ] OpenRouter key with ~$10 credits; choose `LLM_MODEL` (vision + structured outputs).
- [ ] Vercel project, root `apps/web`.
- [ ] A second email account to play the CBO.
- [ ] Muse output in `/synthetic` per `docs/SEED_CONTRACT.md`.

### Secrets
Worker: `API_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `MAILBOX_ADDRESS`, `OPENROUTER_API_KEY`, `LLM_MODEL`, `VAULT_HMAC_KEY`, `VAULT_ENC_KEY`, `PUBLIC_WEB_URL`, `PUBLIC_WORKER_URL`, `DEMO_MODE`, `REAL_LOCATOR_ENABLED` (false).
Web: `WORKER_URL`, `API_SECRET`, `ADMIN_PASSWORD`, `SESSION_SECRET`.

## 12. Acceptance (mapped to judging)

- **Technical (35%):** reply from the CBO account with a messy attendance sheet -> in-thread legend question within ~90 s -> answer -> receipt with report link -> "yes" -> dashboard updates. Three times in a row from reset.
- **Impact (30%):** TPW adds a field in the UI and the next email asks it. One-pager downloads with live, suppressed, labeled numbers. Outcome view shows 1/2/3-year return rates with n/N (simulated, labeled).
- **Innovation (20%):** scrambled-identity receipt; masked-profile mapping (spreadsheets never reach the LLM row by row); re-identification only in deterministic code with an audit log; guarded locator adapter.
- **Story (15%):** `docs/DEMO.md` script runs end to end with a one-click reset.

## 13. Open items for TPW
- Confirm "scrambling" = encrypted and keyed (reversible by TPW's key holder). If they meant irreversible, re-identification and lookups are impossible by design.
- Written authorization and consent process before any real locator query; confirm scripted access is allowed.
- Which annual cost figure (136K vs 21,534) and which recidivism benchmark figure to show.
- How RAC/MCC credit days are calculated per program.
- A TPW-owned mailbox for production.
