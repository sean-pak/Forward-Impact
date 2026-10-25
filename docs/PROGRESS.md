# Progress

## Phase 0: Skeleton (code done, deploy pending human steps)
- Shipped: pnpm monorepo (`apps/worker` Hono, `apps/web` Next.js, `packages/shared`), `/health` pinging `DB` and `VAULT`, bearer middleware on `/api/*`, web home page showing health. `pnpm typecheck && pnpm test` pass; `next build` passes.
- Not yet done: Cloudflare D1 databases, Worker deploy, Vercel project. Phase 0 box stays unticked until the deployed `/health` returns `{ ok: true, db: true, vault: true }`.
- Notes: docs moved into `docs/` to match CLAUDE.md. `docs/schema-v2.md` is referenced but missing from the repo; needed in phase 1.
- Dependencies: hono (Worker router), zod (boundary validation), next/react (web), wrangler + @cloudflare/workers-types (Worker tooling), vitest + typescript (tests, strict types).
