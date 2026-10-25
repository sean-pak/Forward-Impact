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
  VAULT_HMAC_KEY: "",
  VAULT_ENC_KEY: "",
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

  it("/api/admin/summary is bearer-protected and computes from confirmed cycles", async () => {
    const row = {
      cycle_id: "c1", org_id: "o1", org_name: "Org", program_name: "Prog",
      completion_rule: "attendance >= 80%", facility_code: "SQ", facility_name: "San Quentin",
      start_date: "2025-01-01", end_date: null, course_hours_planned_per_participant: 20,
      n_enrolled: 10, n_completed: 8, total_course_hours_delivered: null,
      n_enrolled_approx: 0, n_completed_approx: 0, total_course_hours_delivered_approx: 0,
    };
    const db = {
      prepare: (sql: string) => ({
        all: async () => {
          if (sql.includes("FROM facilities")) {
            return { results: [{ facility_code: "SQ", facility_name: "San Quentin" }, { facility_code: "SATF", facility_name: "SATF" }] };
          }
          expect(sql).toContain("status = 'confirmed'");
          return { results: [row] };
        },
      }),
    } as unknown as D1Database;
    const e = { ...env(true, true), DB: db };
    expect((await app.request("/api/admin/summary", {}, e)).status).toBe(401);
    const res = await app.request("/api/admin/summary", { headers: { Authorization: "Bearer secret" } }, e);
    const body = (await res.json()) as { participants: { value: number }; prisons: { covered: number; total: number } };
    expect(body.participants.value).toBe(10);
    expect(body.prisons).toEqual({ covered: 1, total: 2 });
    // Public view suppresses server-side: 10 participants is a small count, and no cycle detail is sent.
    const pub = await app.request("/api/admin/summary?view=public", { headers: { Authorization: "Bearer secret" } }, e);
    const pubBody = (await pub.json()) as { participants: { value: number | null; suppressed: boolean }; cycles: unknown[] };
    expect(pubBody.participants).toMatchObject({ value: null, suppressed: true });
    expect(pubBody.cycles).toEqual([]);
  });
});
