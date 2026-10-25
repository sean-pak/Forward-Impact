# Progress

## Phase 0: Skeleton (done)
- Shipped: pnpm monorepo (`apps/worker` Hono, `apps/web` Next.js, `packages/shared`), `/health` pinging `DB` and `VAULT`, bearer middleware on `/api/*`, web home page showing health.
- URLs: Worker https://tpw-worker.sean-mk-pak.workers.dev (`/health` returns `{ ok: true, db: true, vault: true }`); web https://forward-impact-seanpaks-projects.vercel.app (shows the same health JSON).
- Gaps: Vercel Authentication is on, so the web URL needs a Vercel login (or turn it off before the demo). API_SECRET compare is not constant-time.
- Notes: docs moved into `docs/` to match CLAUDE.md. `docs/schema-v2.md` is referenced but missing from the repo; needed in phase 1. Deploy the Worker with `pnpm --filter worker run deploy` (plain `pnpm deploy` is a pnpm built-in); needs Node 22+. Vercel project must have Root Directory `apps/web`, framework Next.js.
- Dependencies: hono (Worker router), zod (boundary validation), next/react (web), wrangler + @cloudflare/workers-types (Worker tooling), vitest + typescript (tests, strict types).

## Phase 1.a: Schema, seed contract, static seed, fixtures (code done, remote reset pending)
- Shipped: migrations for `tpw_analytics` (24 tables) and `tpw_vault` (3 tables); `docs/SEED_CONTRACT.md` (tested against the migrations); 31 CDCR facilities + `normalizeFacility()`; assumptions (cost marked `todo_confirm`), 11 benchmark rows, 10 core registry fields; `/fixtures/seed` (4 orgs, 10 confirmed cycles); `pnpm db:reset --local | --remote --yes`.
- Verified locally with Node 24: reset runs twice cleanly, 31 facilities / 4 orgs / 10 confirmed cycles / 11 benchmarks seeded.
- Decisions: Muse files reference people by `person_ref` (SYN number, or `org_id:internal_id`) because only the loader can compute `person_key`. Codes follow schema-v2 (`SQ`, `SATF`); CDCR's `SQRC` / `SATF-CSP` are aliases. Shared towns (Soledad, Delano, Chowchilla, Vacaville) and bare "Corcoran" are deliberately unmatched so Sam asks. `cycle_metrics` / `cohort_outcome_metrics` are computed, not stored. `messages` stores metadata only, never bodies. `submissions.status` also allows `needs_staff` (PRD). `person_identity.org_ids` follows the PRD (schema-v2 calls it `org_internal_ids`).
- Gaps: remote D1 not yet reset/seeded; dashboard is 1.b. Wrangler needs Node 22+ (`.nvmrc`).
- Dependencies: papaparse (read seed CSVs, in the stack list), tsx (run TypeScript scripts), zod in `scripts` (validate seed rows), @types/papaparse + @types/node (types).
