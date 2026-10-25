import { Hono } from "hono";
import { makeHealth } from "@tpw/shared";
import { loadAdminSummary } from "./summary";

export type Env = {
  DB: D1Database;
  VAULT: D1Database;
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

// Phase 0 only: SELECT 1 on both bindings. From phase 2 on, only code under
// src/vault/ may query VAULT; move this ping there then.
app.get("/health", async (c) => {
  const [db, vault] = await Promise.all([ping(c.env.DB), ping(c.env.VAULT)]);
  return c.json(makeHealth(db, vault));
});

app.use("/api/*", async (c, next) => {
  if (c.req.header("Authorization") !== `Bearer ${c.env.API_SECRET}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});
app.get("/api/ping", (c) => c.json({ ok: true }));
app.get("/api/admin/summary", async (c) => c.json(await loadAdminSummary(c.env.DB)));

export default app;
