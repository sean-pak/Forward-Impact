import { describe, expect, it } from "vitest";
import app, { type Env } from "./index";

function fakeD1(up: boolean): D1Database {
  return {
    prepare: () => ({
      first: async () => {
        if (!up) throw new Error("down");
        return { 1: 1 };
      },
    }),
  } as unknown as D1Database;
}

const env = (db: boolean, vault: boolean): Env => ({
  DB: fakeD1(db),
  VAULT: fakeD1(vault),
  API_SECRET: "secret",
});

describe("worker", () => {
  it("/health reports both databases", async () => {
    const res = await app.request("/health", {}, env(true, true));
    expect(await res.json()).toEqual({ ok: true, db: true, vault: true });
    const bad = await app.request("/health", {}, env(true, false));
    expect(await bad.json()).toEqual({ ok: false, db: true, vault: false });
  });

  it("/api/* requires the bearer secret", async () => {
    const e = env(true, true);
    expect((await app.request("/api/ping", {}, e)).status).toBe(401);
    const ok = await app.request("/api/ping", { headers: { Authorization: "Bearer secret" } }, e);
    expect(ok.status).toBe(200);
  });
});
