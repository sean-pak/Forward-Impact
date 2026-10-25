# CLAUDE.md: Sam, TPW's Data Assistant (hackathon build)

Read before writing code:
1. `docs/PRD.md`: behavior and rules. Source of truth.
2. `docs/PLAN.md`: phased plan. Source of truth for order.
3. `docs/schema-v2.md`: field names, enums, outcome definitions, synthetic data spec. Where it conflicts with the PRD, the PRD wins.
4. `docs/PROGRESS.md`: what previous sessions shipped.

## How to work

- One phase at a time, in order. Do not start phase N+1 until phase N's "Done when" checks pass on the **deployed** build.
- Session start: read PROGRESS.md, find the first unchecked phase in PLAN.md, say which phase you're on.
- Phase end:
  1. `pnpm typecheck && pnpm test`
  2. Deploy (worker: `pnpm --filter worker deploy`; web deploys on push to main via Vercel).
  3. Walk the "Done when" list against deployed URLs.
  4. Tick the box in PLAN.md; append 3 to 6 lines to PROGRESS.md (shipped, URLs, gaps, notes for the next phase).
  5. Commit `phase-N: <title>`, `git tag phase-N`.
- If a phase is too big, split it into N.a / N.b in PLAN.md. Every commit on main deploys and works.
- If blocked on something only the human can do (Google Cloud console, Cloudflare dashboard, secrets, Muse output), stop and print an exact checklist. Do not fake it or stub it silently.
- For Gmail API, Cloudflare D1/Workers, and OpenRouter specifics, check current docs rather than relying on memory.

## Non-negotiable rules

**Identity and privacy**
- Identifiers (names, DOB, CDCR numbers, org internal IDs) exist in plaintext only in memory during ingest and during an audited `vault.reidentify()` call. They are stored only as AES-256-GCM ciphertext in the `tpw_vault` D1.
- Only code under `apps/worker/src/vault/` may query the `VAULT` binding.
- `person_key` = keyed HMAC (PRD section 6). Never an unkeyed hash.
- Identifiers never appear in the analytics DB, logs, error messages, or LLM prompts. Tabular files reach the LLM only as masked column profiles. The PII leak test must stay green.
- Every re-identification writes `vault_access_log`.

**Locator**
- The EIT locator holds **real CDCR data**. The `eitLocator` adapter must refuse: synthetic persons, any `SYN` CDCR number, persons without active consent, and any call when `REAL_LOCATOR_ENABLED` is not `true`. Never call the real URL during development or the demo. Use `mockLocator`.

**Data correctness**
- The LLM maps and extracts. Deterministic code computes every count, rate, and derived field.
- Never invent a missing value. Use null/`unknown`, flag it, ask about it. Approximate inputs keep an `_approx` flag.
- A rate always travels with numerator and denominator. Suppressed cells render `suppressed`, never 0.
- Data counts only once confirmed by the CBO.
- Simulated outcomes are labeled SIMULATED everywhere they appear. `outcome_source` is never overwritten.
- Synthetic data only: CDCR numbers `SYN` + 5 digits, emails `@example.org` (except the human's own test accounts). The seed loader refuses non-`SYN` CDCR numbers.

**Email**
- Mailbox: `MAILBOX_ADDRESS` (hello@seanpak.com) via Gmail API. Only process mail from known contacts or known threads; label everything else `sam/ignored` and never send it to the LLM.
- One ask per org contact, sent individually. One question per email. Max 2 clarification rounds, then `needs_staff`.
- Signature `Sam, TPW's data assistant`. Never claims to be human.
- Outbound text comes from code templates, not LLM prose.

## Stack (do not swap without asking)

- pnpm monorepo: `apps/worker` (Cloudflare Worker, Hono), `apps/web` (Next.js App Router on Vercel), `packages/shared` (zod schemas, metrics, suppression, questions, facility normalization).
- D1 x2: `DB` = tpw_analytics, `VAULT` = tpw_vault. Worker is the only DB client; web calls Worker `/api/*` server-side with a bearer secret.
- Gmail API (OAuth refresh token, scope `gmail.modify`), `postal-mime` to parse, `mimetext` to build.
- OpenRouter, model from `LLM_MODEL`, JSON-schema output, zod validation, one retry.
- `papaparse`, `xlsx` (SheetJS), `mammoth`, `@react-pdf/renderer`, `vitest`.
- WebCrypto for HMAC and AES-GCM. No crypto libraries.

## Code style

- TypeScript strict. zod at every boundary (HTTP, LLM output, email parse, seed files).
- Numeric logic as small pure functions in `packages/shared` with unit tests.
- No new dependencies without a one-line justification in PROGRESS.md.
- Boring and readable. This is handed to a 4-person nonprofit.
