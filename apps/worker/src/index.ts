import { Hono } from "hono";
import { makeHealth } from "@tpw/shared";
import { loadDashboard } from "./summary";
import { createVault, pingVault } from "./vault";

export type Env = {
  DB: D1Database;
  VAULT: D1Database;
  VAULT_HMAC_KEY: string;
  VAULT_ENC_KEY: string;
  API_SECRET: string;
};

const app = new Hono<{ Bindings: Env }>();

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

export default app;
