# Progress

## Phase 0: Skeleton (done)
- Shipped: pnpm monorepo (`apps/worker` Hono, `apps/web` Next.js, `packages/shared`), `/health` pinging `DB` and `VAULT`, bearer middleware on `/api/*`, web home page showing health.
- URLs: Worker https://tpw-worker.sean-mk-pak.workers.dev (`/health` returns `{ ok: true, db: true, vault: true }`); web https://forward-impact-seanpaks-projects.vercel.app (shows the same health JSON).
- Gaps: Vercel Authentication is on, so the web URL needs a Vercel login (or turn it off before the demo). API_SECRET compare is not constant-time.
- Notes: docs moved into `docs/` to match CLAUDE.md. `docs/schema-v2.md` is referenced but missing from the repo; needed in phase 1. Deploy the Worker with `pnpm --filter worker run deploy` (plain `pnpm deploy` is a pnpm built-in); needs Node 22+. Vercel project must have Root Directory `apps/web`, framework Next.js.
- Dependencies: hono (Worker router), zod (boundary validation), next/react (web), wrangler + @cloudflare/workers-types (Worker tooling), vitest + typescript (tests, strict types).

## Phase 1.a: Schema, seed contract, static seed, fixtures (done)
- Shipped: migrations for `tpw_analytics` (24 tables) and `tpw_vault` (3 tables); `docs/SEED_CONTRACT.md` (tested against the migrations); 31 CDCR facilities + `normalizeFacility()`; assumptions (cost marked `todo_confirm`), 11 benchmark rows, 10 core registry fields; `/fixtures/seed` (4 orgs, 10 confirmed cycles); `pnpm db:reset --local | --remote --yes`.
- Verified locally with Node 24: reset runs twice cleanly, 31 facilities / 4 orgs / 10 confirmed cycles / 11 benchmarks seeded.
- Decisions: Muse files reference people by `person_ref` (SYN number, or `org_id:internal_id`) because only the loader can compute `person_key`. Codes follow schema-v2 (`SQ`, `SATF`); CDCR's `SQRC` / `SATF-CSP` are aliases. Shared towns (Soledad, Delano, Chowchilla, Vacaville) and bare "Corcoran" are deliberately unmatched so Sam asks. `cycle_metrics` / `cohort_outcome_metrics` are computed, not stored. `messages` stores metadata only, never bodies. `submissions.status` also allows `needs_staff` (PRD). `person_identity.org_ids` follows the PRD (schema-v2 calls it `org_internal_ids`).
- Remote D1 verified after `db:reset --remote --yes`: 31 facilities, 4 orgs, 10 confirmed cycles, 11 benchmarks, 10 fields, 5 contacts; vault has 3 tables and 0 identities.
- Gaps: dashboard is 1.b. Wrangler needs Node 22+ (`.nvmrc`).
- Dependencies: papaparse (read seed CSVs, in the stack list), tsx (run TypeScript scripts), zod in `scripts` (validate seed rows), @types/papaparse + @types/node (types).

## Phase 1.b: Dashboard v0 (done)
- Shipped: Worker `GET /api/admin/summary` (bearer-protected, confirmed cycles only); pure metrics in `packages/shared/src/summary.ts` (participants, completion n/N, hours, prisons x of 31); web `proxy.ts` password gate (signed httpOnly cookie, constant-time compare), `/login`, `/admin` with stat tiles and cycles table.
- URLs: Worker https://tpw-worker.sean-mk-pak.workers.dev; web `/admin` on the Vercel URL (needs `WORKER_URL`, `API_SECRET`, `ADMIN_PASSWORD`, `SESSION_SECRET` set in Vercel).
- Decisions: completion rate counts only cycles with a stated rule and both counts known (excluded cycles reported). Hours use delivered when present, else planned per participant x enrolled, labeled approx. Staff view is unsuppressed until phase 3.
- Gaps: Vercel Authentication still on. Worker `API_SECRET` compare is still not constant-time. No login rate limiting.
- Dependencies: none new (vitest added to web test script).

## Phase 2: Vault module + Muse seed path (done)
- Shipped: `apps/worker/src/vault/` (`normalizeCdcr`, `personKey()` 3 bases, AES-256-GCM field encryption bound to person_key+field via AAD, `Vault.upsertIdentity()`, `Vault.reidentify()` that writes `vault_access_log` first and can filter to one org, `status()`); `GET /api/admin/vault/status` (counts + can_decrypt, never plaintext). Scripts: `pnpm keys:generate [--write]`, `pnpm seed:muse <dir> --local | --remote --yes`, `pnpm db:reset ... [--data <dir>]` now loads fixture identities through the vault. Loader handles every file in SEED_CONTRACT (person_ref -> person_key), validates everything before writing.
- Verified: local and remote `SELECT` on `person_identity` shows ciphertext only (3 fixture people); analytics still 31 facilities / 4 orgs / 10 confirmed cycles. Local: one person at two orgs merges into one row, Worker decrypted a stored row and logged it.
- Boundary tests (`scripts/src/boundary.test.ts`): only `vault/` names the VAULT binding, vault keys, or vault tables; web has no DB access.
- GAPS / HUMAN: Worker secrets are NOT set on the deployed Worker, so `/api/admin/vault/status` returns 500 until they are. Local keys live in `apps/worker/.dev.vars` (gitignored) and were also used to seed the remote vault. Run `cd apps/worker && pnpm exec wrangler secret put VAULT_HMAC_KEY` and `... VAULT_ENC_KEY`, pasting the two values from `.dev.vars`, and keep a copy in a password manager (lose the enc key = identities unreadable; change the HMAC key = person_keys orphaned). No Muse output in `./synthetic` yet; fixture identities were used. Muse's derived columns are loaded as given, not yet recomputed (phase 10/13).
- Notes: `person_ref` forms accepted: `SYN#####` or `org_id:internal_id` (either form resolves to the same person). Blank enum cells that default to `unknown` in the schema load as `unknown`. Wrangler needs Node 22+ (`/opt/homebrew/bin` had it here). `org_ids` stores `""` when an org gave no internal id.
- Dependencies: none new (zod already in scripts).


## Phase 3: Metrics and suppression (done)
- Shipped: `packages/shared/src/suppress.ts` (rate denominator < 30, counts 1 to 10, facility < 3 orgs) and `metrics.ts` (`Metric = { value, numerator?, denominator?, isEstimate, suppressed }`, `byFacility()`, `buildDashboard()`); replaced the old `summarize`/`AdminSummary`. Worker `GET /api/admin/summary?view=staff|public` suppresses server-side (suppressed metrics carry no numbers; public drops per-cycle detail and org counts). `/admin` has a Staff/Public toggle (`?view=public`), a by-facility table, and a program-deserts count. Worker deployed; typecheck and 66 tests pass.
- Verified on the deployed web build by the human: public view shows `suppressed` cells with no cycles table or Orgs column; staff view shows all. Worker not curl-checked directly (deployed `API_SECRET` not in `.dev.vars`).
- Gaps: Mean attendance, est. credit days and est. cost avoided (PRD 10) are not built: no attendance rows in the fixtures and cost is `todo_confirm`. Hours in public view follow the participant count rule. Facility `Prisons covered` is not a person count and is not suppressed. No complementary suppression: with one suppressed facility row, totals minus other rows could reveal it.
- Notes for next phase: the one-pager should call `buildDashboard(..., "public")` via the same endpoint. Fixture data is small, so most public cells will read `suppressed`, which is the expected demo of the rule until Muse data is loaded.
- Dependencies: none new.
