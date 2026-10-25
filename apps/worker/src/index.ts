import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { makeHealth, searchMock } from "@tpw/shared";
import { sendTest, syncGmail } from "./gmail";
import { PIXEL_GIF, importContacts, listOrgs, listOutreach, recordOpen, sendAsks, setPrimary } from "./outreach";
import { FormBodySchema, adminSubmission, confirmSubmission, getSubmission, listSubmissions, loadForm, submitForm, type OrgRow } from "./form";
import { ingest, type IngestInput } from "./ingest";
import { OpenRouterLlm } from "./llm";
import { MAX_PER_CALL, listLookups, pickCohort, revealPerson, runChecks, verifyCheck, mockData, type Deps as LookupDeps } from "./locator";
import { loadOrgReport } from "./report";
import { loadDashboard } from "./summary";
import { loadOutcomePanel } from "./outcomes";
import { createVault, pingVault, vaultFactory } from "./vault";

export type Env = {
  DB: D1Database;
  VAULT: D1Database;
  VAULT_HMAC_KEY: string;
  VAULT_ENC_KEY: string;
  API_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
  MAILBOX_ADDRESS: string;
  ADMIN_EMAILS?: string;
  WORKER_PUBLIC_URL: string;
  WEB_URL: string;
  OPENROUTER_API_KEY?: string;
  LLM_MODEL?: string;
  /** Must be exactly "true" to even consider the real locator, which is not built. Leave it "false". */
  REAL_LOCATOR_ENABLED?: string;
};

export const app = new Hono<{ Bindings: Env }>();

async function ping(d1: D1Database): Promise<boolean> {
  try {
    await d1.prepare("SELECT 1").first();
    return true;
  } catch {
    return false;
  }
}

app.get("/health", async (c) => {
  const [db, vault] = await Promise.all([ping(c.env.DB), pingVault(c.env)]);
  return c.json(makeHealth(db, vault));
});

// Open pixel for the ask email. Public by design (mail clients fetch it); the id is an unguessable outreach id.
app.get("/p/:file", async (c) => {
  const id = c.req.param("file").replace(/\.gif$/, "");
  await recordOpen(c.env.DB, id).catch(() => undefined);
  return new Response(PIXEL_GIF, { headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, max-age=0" } });
});

const requireBearer = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  if (c.req.header("Authorization") !== `Bearer ${c.env.API_SECRET}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});
app.use("/api/*", requireBearer);
// Muse's synthetic locator data, served like the real tool would answer. Behind the same bearer as /api/*.
app.use("/mock-locator/*", requireBearer);
app.get("/mock-locator/search", (c) =>
  c.json(searchMock(mockData(), { cdcr: c.req.query("cdcr"), first: c.req.query("first"), last: c.req.query("last") })),
);
app.get("/api/ping", (c) => c.json({ ok: true }));
app.get("/api/admin/vault/status", async (c) => {
  try {
    return c.json(await (await createVault(c.env)).status());
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "vault unavailable" }, 500);
  }
});
// Suppression happens here, so a public response never contains the hidden numbers.
app.get("/api/admin/summary", async (c) =>
  c.json(await loadDashboard(c.env.DB, c.req.query("view") === "public" ? "public" : "staff")),
);

// Return-to-prison rates by release fiscal year. Suppressed server-side like the summary; every row names its source.
app.get("/api/admin/outcomes", async (c) =>
  c.json(await loadOutcomePanel(c.env.DB, c.req.query("view") === "public" ? "public" : "staff", new Date().toISOString().slice(0, 10))),
);

app.post("/api/gmail/sync", async (c) => {
  try {
    return c.json(await syncGmail(c.env));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "sync failed" }, 500);
  }
});
app.post("/api/gmail/test", async (c) => {
  const body = z.object({ to: z.string().email() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "a valid 'to' address is required" }, 400);
  try {
    const sent = await sendTest(c.env, body.data.to);
    return c.json({ ok: true, threadId: sent.threadId });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "send failed" }, 500);
  }
});
// Metadata only: inbound subjects and bodies are never stored.
app.get("/api/gmail/messages", async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT message_id, direction, kind, org_id, from_email, to_email, subject, occurred_at
       FROM messages ORDER BY occurred_at DESC LIMIT 50`,
    )
    .all();
  return c.json({ messages: results });
});

app.get("/api/contacts", async (c) => c.json({ orgs: await listOrgs(c.env.DB) }));
app.post("/api/contacts/import", async (c) => {
  const body = z.object({ csv: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "csv text is required" }, 400);
  return c.json(await importContacts(c.env.DB, body.data.csv));
});
app.post("/api/contacts/primary", async (c) => {
  const body = z.object({ org_id: z.string().min(1), contact_id: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "org_id and contact_id are required" }, 400);
  return (await setPrimary(c.env.DB, body.data.org_id, body.data.contact_id))
    ? c.json({ ok: true })
    : c.json({ error: "contact is not in that org" }, 404);
});
// Omit org_ids to ask every org that has not been asked yet.
app.post("/api/outreach/send", async (c) => {
  const body = z.object({ org_ids: z.array(z.string()).optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "org_ids must be a list of org ids" }, 400);
  try {
    return c.json(await sendAsks(c.env, body.data.org_ids ?? null));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "send failed" }, 500);
  }
});
app.get("/api/outreach", async (c) => c.json(await listOutreach(c.env.DB)));

// Admin upload (on-stage fallback): the same pipeline the email path uses. Multipart: org_id plus a file or pasted text.
app.post("/api/ingest/upload", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const orgId = form?.get("org_id");
  if (!form || typeof orgId !== "string" || !orgId) return c.json({ error: "org_id is required" }, 400);
  const org = await c.env.DB
    .prepare("SELECT org_id, org_name, primary_contact_email, is_synthetic FROM orgs WHERE org_id = ?")
    .bind(orgId)
    .first<OrgRow>();
  if (!org) return c.json({ error: "unknown org" }, 404);
  const file = form.get("file");
  const text = form.get("text");
  let input: IngestInput;
  if (file instanceof File && file.size > 0) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const name = file.name.toLowerCase();
    if (name.endsWith(".docx")) input = { kind: "docx", bytes };
    else if (/\.(csv|xlsx)$/.test(name)) input = { kind: "table", filename: file.name, bytes };
    else if (name.endsWith(".txt")) input = { kind: "text", text: new TextDecoder().decode(bytes) };
    else return c.json({ error: "Upload a .csv, .xlsx, .docx or .txt file." }, 400);
  } else if (typeof text === "string" && text.trim()) {
    input = { kind: "text", text };
  } else {
    return c.json({ error: "Choose a file or paste the text." }, 400);
  }
  try {
    const out = await ingest(c.env.DB, new OpenRouterLlm(c.env), org, input, { channel: "manual", senderEmail: org.primary_contact_email }, vaultFactory(c.env));
    return c.json(out);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "ingest failed" }, 500);
  }
});
app.get("/api/submissions", async (c) => c.json({ submissions: await listSubmissions(c.env.DB) }));
app.get("/api/submissions/:id", async (c) => {
  const view = await adminSubmission(c.env.DB, c.req.param("id"));
  return view ? c.json(view) : c.json({ error: "submission not found" }, 404);
});

// Structured form (PRD 7.4). The org is identified by its unguessable form token; the web app calls these server-side.
app.get("/api/form/:token", async (c) => {
  const form = await loadForm(c.env.DB, c.req.param("token"));
  return form ? c.json(form) : c.json({ error: "unknown form link" }, 404);
});
app.post("/api/form/:token/submit", async (c) => {
  const body = FormBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "the form could not be read" }, 400);
  const r = await submitForm(c.env.DB, c.req.param("token"), body.data.rows);
  return r.ok ? c.json(r) : c.json({ error: r.error }, r.status);
});
app.get("/api/form/:token/submissions/:id", async (c) => {
  const view = await getSubmission(c.env.DB, c.req.param("token"), c.req.param("id"));
  return view ? c.json(view) : c.json({ error: "submission not found" }, 404);
});
app.post("/api/form/:token/submissions/:id/confirm", async (c) => {
  const r = await confirmSubmission(c.env.DB, c.req.param("token"), c.req.param("id"));
  return r.ok ? c.json(r) : c.json({ error: r.error }, r.status);
});

// The CBO's private report (PRD 5): its own numbers and its own people, re-identified. The web page calls this
// server-side; the token is the only thing that picks the org.
app.get("/api/org/:token/report", async (c) => {
  c.header("Cache-Control", "no-store");
  const report = await loadOrgReport(c.env.DB, c.req.param("token"), vaultFactory(c.env));
  return report ? c.json(report) : c.json({ error: "unknown report link" }, 404);
});

// Custody lookups (PRD 9). Mock locator only for synthetic people; the real adapter is guarded and not built.
const lookupDeps = (env: Env): LookupDeps => ({ db: env.DB, openVault: vaultFactory(env), realEnabled: env.REAL_LOCATOR_ENABLED === "true" });
app.get("/api/lookups", async (c) => {
  const deps = lookupDeps(c.env);
  return c.json({ rows: await listLookups(deps), max_per_click: MAX_PER_CALL, real_locator_enabled: deps.realEnabled });
});
app.post("/api/lookups/check", async (c) => {
  const body = z.object({ person_keys: z.array(z.string().min(1)).min(1).max(200) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "person_keys is required" }, 400);
  try {
    return c.json({ results: await runChecks(lookupDeps(c.env), body.data.person_keys) });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "lookup failed" }, 500);
  }
});
app.post("/api/lookups/check-cohort", async (c) => {
  const deps = lookupDeps(c.env);
  try {
    const keys = pickCohort(await listLookups(deps), (deps.now?.() ?? new Date()).toISOString().slice(0, 10));
    return c.json({ results: keys.length ? await runChecks(deps, keys) : [] });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "lookup failed" }, 500);
  }
});
app.post("/api/lookups/checks/:id/verify", async (c) => {
  const r = await verifyCheck(lookupDeps(c.env), c.req.param("id"));
  return r.ok ? c.json(r) : c.json({ error: r.error }, r.status);
});
app.post("/api/lookups/reveal", async (c) => {
  const body = z.object({ person_key: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "person_key is required" }, 400);
  c.header("Cache-Control", "no-store");
  try {
    const who = await revealPerson(lookupDeps(c.env), body.data.person_key);
    return who ? c.json(who) : c.json({ error: "not on the lookup list" }, 404);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "vault unavailable" }, 500);
  }
});

export default {
  fetch: app.fetch,
  // Cron Trigger (every minute): same sync as the admin button.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      syncGmail(env).catch((e) => console.error("gmail sync failed:", e instanceof Error ? e.message : "unknown")),
    );
  },
};
