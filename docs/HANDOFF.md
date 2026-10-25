# Handoff: Sam, TPW's data assistant

For the 4-person team that inherits this. Behavior is in `docs/PRD.md`; the demo is `docs/DEMO.md`; what each phase shipped, and its gaps, is `docs/PROGRESS.md`.

## What runs where

| Piece | Where | Notes |
|---|---|---|
| Worker (API, Gmail sync, cron every minute) | Cloudflare, `tpw-worker` | `pnpm --filter worker run deploy`. Needs Node 22+. |
| Web (admin, form, CBO report, PDF) | Vercel, root `apps/web` | Deploys on push to `main`. Only talks to the Worker, with a bearer secret. |
| `tpw_analytics` (D1) | Cloudflare | Counts, cycles, messages (metadata only), submissions. No identifiers. |
| `tpw_vault` (D1) | Cloudflare | Names, DOB, CDCR numbers as AES-256-GCM ciphertext. Only `apps/worker/src/vault/` may touch it (a test enforces this). |
| Mailbox | Gmail via API, `MAILBOX_ADDRESS` | OAuth refresh token, scope `gmail.modify`. |
| Model | OpenRouter, `LLM_MODEL` | Maps and extracts only. Code computes every number. |

## Accounts to transfer

Cloudflare (Workers Paid, both D1 databases), Vercel project, Google Cloud project (Gmail API, OAuth client, consent screen set to Internal), OpenRouter (credits), the GitHub repo, and the mailbox itself. Put the key values below in the team password manager before the hackathon team leaves.

## Secrets and what rotating each one does

Worker secrets are set with `cd apps/worker && pnpm exec wrangler secret put NAME`. Paste the value with no quotes. Web variables are in the Vercel project settings.

| Secret | Where | If you change it |
|---|---|---|
| `API_SECRET` | Worker **and** Vercel | Change both at the same time, then redeploy the Worker and redeploy Vercel. Until both match, the admin pages show errors. |
| `ADMIN_PASSWORD`, `SESSION_SECRET` | Vercel | Staff must log in again. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | Worker | Mint a new refresh token with `pnpm google:auth`. Mail sync stops until it is set. |
| `OPENROUTER_API_KEY`, `LLM_MODEL` | Worker | Safe to change any time. The model must support structured JSON output (`structured_outputs`) and is called without `temperature`. Without them Sam hands every file to staff at once. |
| `VAULT_ENC_KEY` | Worker | **Do not rotate casually.** It encrypts every identifier. Losing it makes every name and CDCR number unreadable. There is no re-encryption tool. Keep two copies. |
| `VAULT_HMAC_KEY` | Worker | **Do not change.** Every `person_key` in the analytics DB is derived from it. A new key orphans all existing people. There is no re-keying tool. |

Not secrets, in `wrangler.toml`: `MAILBOX_ADDRESS`, `ADMIN_EMAILS` (staff addresses whose mail is accepted), `WEB_URL`, `WORKER_PUBLIC_URL`, `REAL_LOCATOR_ENABLED` (keep `"false"`), `DEMO_MODE` (keep `"false"`; see DEMO.md), `DEMO_CBO_*`.

Generate fresh vault keys for a new deployment with `pnpm keys:generate --write` (writes `apps/worker/.dev.vars`, gitignored).

## What reaches the model

Nothing else is sent. Every call goes through `apps/worker/src/llm.ts`, which logs the model name, time and outcome, never a prompt or an answer.

- **Spreadsheets (CSV, XLSX):** only a masked column profile: each column's header text, inferred type, up to 4 masked value patterns with their share (letters become `A`/`a`, digits `#`), distinct count and empty share. A column whose values are all single characters with at most 8 distinct values (attendance marks like `X`, `P`, `L`) is sent as written. Never a row. Names, CDCR numbers and dates of birth in cells are not sent. A header is sent as written, so a column titled with a person's name would reach the model.
- **Email bodies, Word files, pasted text:** the text itself, first 20,000 characters, after removing ID-shaped tokens (`ABC12345`) and email addresses. **Names typed into free text are not removed.** Tell CBOs to send people-level data as a spreadsheet.
- **Replies to Sam's questions:** the reply with quoted history removed, ID tokens and emails scrubbed, first 2,000 characters, plus the question being answered.
- Never sent: anything from an unknown sender (labeled `sam/ignored`), identifiers read from files, vault contents, locator responses.
- Outbound email text comes from code templates (`packages/shared/src/outreach.ts`, `replies.ts`), not from the model.
- A count the model returns that does not appear in the CBO's text is dropped. The leak tests (`apps/worker/src/individual/pii.test.ts`, `phase10.verify.test.ts`) fail if a planted name or CDCR number shows up in analytics rows, logs, model requests or outbound mail. Run the suite on Node 22.13+: on older Node the SQLite-backed tests, including those, skip silently.

## Moving to a TPW-owned mailbox

1. Create the mailbox in TPW's Google Workspace. In a Google Cloud project there: enable the Gmail API, set the OAuth consent screen to Internal, create a Desktop OAuth client.
2. Put the client id and secret in `apps/worker/.dev.vars`, run `pnpm google:auth` signed in as the new mailbox, and `wrangler secret put` the three `GOOGLE_*` values.
3. Change `MAILBOX_ADDRESS` in `wrangler.toml` and add TPW staff to `ADMIN_EMAILS`. Deploy the Worker.
4. Sam creates the `sam/processed` and `sam/ignored` labels itself.
5. Expect: conversations already open in the old mailbox cannot continue (replies are matched by Gmail thread id, which is per mailbox). Contacts still match by sender address, so a CBO's next email starts a fresh conversation. Finish or hand off open submissions first (`/admin/submissions`). Ask emails already sent keep working for the form link and the open-tracking pixel, which point at the web and Worker URLs, not the mailbox.
6. Tell CBO contacts the new address; the old one is the `From` on past asks.

## Before the real locator is ever enabled

The EIT locator holds real CDCR data. Today `eitLocator` throws "not built" even if every guard passes, so nothing can reach the real site. Do not build or enable it until all of these are true:

- TPW's written authorization to query it, and written confirmation that scripted access is allowed.
- A consent process, with real participants who have signed follow-up consent that is recorded (today no ingest path captures consent, so only seeded people are eligible).
- A decision on how often to query, who sees results, and what is retained (`locator_raw` stores the encrypted query and response).
- Then: inspect the site's network calls for a JSON endpoint; if there is none, run a browser automation outside the Worker. Set `REAL_LOCATOR_ENABLED = "true"`.

The adapter already refuses synthetic people, any `SYN` number, anyone without active consent, and any call while the flag is off; the mock locator refuses real people. Keep both. Real lookups write `vault_access_log` rows.

## Known gaps and decisions for TPW

- **Org internal IDs are stored in plain JSON** in the vault database (`person_identity.org_ids`), as `docs/PRD.md` specifies. `CLAUDE.md` says they should be ciphertext. Names, DOB and CDCR numbers are encrypted. Decide whether to encrypt this column; it needs a migration and a change to the merge SQL in `vault/identity.ts`.
- `API_SECRET` is compared with `!==`, not in constant time; the login has no rate limit; public form routes have none.
- The demo reset deletes the vault access log. It only runs when `DEMO_MODE` is `"true"`.
- Open questions from the PRD for TPW: which annual cost figure (21,534 vs ~136K), which recidivism benchmark (the page shows the 20.4% return-to-prison rate, not the 45.6% conviction figure), how RAC/MCC credit days are calculated per program, and whether "scrambling" may be reversible (it is: TPW's key holder can reverse it, which the lookups and CBO reports depend on).
- More: the "Gaps" line of each phase in `docs/PROGRESS.md`.

## Everyday operations

- Tests: `pnpm typecheck && pnpm test` on Node 22.13+.
- Local database: `pnpm db:reset --local`. Deployed: `pnpm db:reset --remote --yes` drops **both** databases, the vault included.
- Backups: `pnpm exec wrangler d1 export tpw_analytics --remote --output backup.sql` (and `tpw_vault`; the vault export is ciphertext but still sensitive). Cloudflare also offers D1 Time Travel; check their current docs for the retention window.
- Add a question for CBOs: `/admin/fields` (no code). Retire it there too.
- A submission stuck as `needs_staff` (`/admin/submissions`) means Sam could not finish it: the model was down, a setting was wrong, or two question rounds did not settle it. The CBO was told a person will follow up. Nothing from it is counted.
