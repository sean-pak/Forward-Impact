import { Hono } from "hono";
import { z } from "zod";
import { makeHealth } from "@tpw/shared";
import { sendTest, syncGmail } from "./gmail";
import { PIXEL_GIF, importContacts, listOrgs, listOutreach, recordOpen, sendAsks, setPrimary } from "./outreach";
import { loadDashboard } from "./summary";
import { createVault, pingVault } from "./vault";

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

app.use("/api/*", async (c, next) => {
  if (c.req.header("Authorization") !== `Bearer ${c.env.API_SECRET}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});
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

export default {
  fetch: app.fetch,
  // Cron Trigger (every minute): same sync as the admin button.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      syncGmail(env).catch((e) => console.error("gmail sync failed:", e instanceof Error ? e.message : "unknown")),
    );
  },
};
