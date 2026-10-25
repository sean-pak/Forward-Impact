# Progress

## Phase 0: Skeleton (done)
- Shipped: pnpm monorepo (`apps/worker` Hono, `apps/web` Next.js, `packages/shared`), `/health` pinging `DB` and `VAULT`, bearer middleware on `/api/*`, web home page showing health.
- URLs: Worker https://tpw-worker.sean-mk-pak.workers.dev (`/health` returns `{ ok: true, db: true, vault: true }`); web https://forward-impact-seanpaks-projects.vercel.app (shows the same health JSON).
- Gaps: Vercel Authentication is on, so the web URL needs a Vercel login (or turn it off before the demo). API_SECRET compare is not constant-time.
- Notes: docs moved into `docs/` to match CLAUDE.md. `docs/schema-v2.md` is referenced but missing from the repo; needed in phase 1. Deploy the Worker with `pnpm --filter worker run deploy` (plain `pnpm deploy` is a pnpm built-in); needs Node 22+. Vercel project must have Root Directory `apps/web`, framework Next.js.
- Dependencies: hono (Worker router), zod (boundary validation), next/react (web), wrangler + @cloudflare/workers-types (Worker tooling), vitest + typescript (tests, strict types).
