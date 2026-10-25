import { describe, expect, it } from "vitest";
import { app } from "../index";
import { syncGmail } from "../gmail/sync";
import { TEST_ENC_B64, TEST_HMAC_B64 } from "../vault/testKeys";
import { makeGmail, scripted } from "../testing/mail";
import { makeD1, readFixture, readJson, sqlite } from "../testing/sqlite";

// docs/DEMO.md as a test: reset, run the attendance-sheet demo by email, reset, run it again. Nothing is fixed by hand
// between runs; only OpenRouter (scripted with the recorded answers) and Gmail (a fake mailbox) are replaced.

const SECRET = "test-secret";
const CBO = "cbo@real.test";

async function rig() {
  const a = makeD1("analytics");
  const v = makeD1("vault");
  const env = {
    DB: a.db, VAULT: v.db, VAULT_HMAC_KEY: TEST_HMAC_B64, VAULT_ENC_KEY: TEST_ENC_B64, API_SECRET: SECRET,
    DEMO_MODE: "true", DEMO_CBO_EMAIL: CBO, DEMO_CBO_ORG: "Test CBO", DEMO_CBO_PROGRAMS: "Healing Circle",
    OPENROUTER_API_KEY: "k", LLM_MODEL: "test/model",
    GOOGLE_CLIENT_ID: "i", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r", MAILBOX_ADDRESS: "hello@example.org",
  };
  const call = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`https://w.test${path}`, { ...init, headers: { Authorization: `Bearer ${SECRET}`, ...(init.headers ?? {}) } }), env as never);
  const reset = async () => {
    const res = await call("/api/demo/reset", { method: "POST", body: JSON.stringify({ confirm: "reset" }) });
    expect(res.status, await res.clone().text()).toBe(200);
  };
  // Cycle ids are random per run; everything else in the dashboard must come out the same.
  const summary = async () => JSON.stringify(await (await call("/api/admin/summary")).json()).replace(/"cycle_id":"[^"]*"/g, '"cycle_id":"-"');
  return { a, v, env, reset, summary };
}

/** The demo: email the attendance sheet, answer the legend question, answer the duplicate, confirm the receipt. */
async function runDemo(w: Awaited<ReturnType<typeof rig>>) {
  const g = makeGmail(CBO);
  const m = scripted({
    map_columns: readJson("org_c_persona3_attendance.llm.json").map_columns,
    classify_legend: [{ marks: [{ mark: "JT", meaning: "excused" }, { mark: "L", meaning: "late" }], late_counts_as_attended: true }],
  });
  const xlsx = { filename: "attendance.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: new Uint8Array(readFixture("org_c_persona3_attendance.xlsx")) };
  const step = async (text: string, files = [] as typeof xlsx[]) => {
    g.receive("DEMO", text, files);
    await syncGmail(w.env as never, g.gmail, m.llm);
    return g.sent.at(-1)!.text;
  };
  const q1 = await step("Attendance for spring.", [xlsx]);
  const q2 = await step("JT means excused (court) and L means late. A late counts as attended.");
  const receipt = await step("YES");
  const thanks = await step("YES");
  return { q1, q2, receipt, thanks, sent: g.sent.length, llmCalls: m.calls };
}

describe.skipIf(!sqlite)("demo rehearsal", () => {
  it("reset -> full demo -> reset -> full demo gives the same result with no manual fixes", async () => {
    const w = await rig();
    await w.reset();
    const start = await w.summary();
    const startRows = w.a.q("SELECT (SELECT COUNT(*) FROM program_cycles) AS cycles, (SELECT COUNT(*) FROM messages) AS messages");

    const first = await runDemo(w);
    expect(first.q1).toMatch(/What do 'JT' and 'L' mean/);
    expect(first.receipt).toMatch(/60 enrolled, 37 completed/);
    expect(first.receipt).toMatch(/61 names and 60 CDCR numbers were scrambled/);
    expect(first.thanks).toMatch(/^Confirmed\./);
    expect(first.llmCalls).toEqual(["map_columns", "classify_legend"]);
    const afterFirst = await w.summary();
    expect(afterFirst).not.toBe(start);
    expect(w.a.q("SELECT n_enrolled, n_completed, status FROM program_cycles WHERE org_id IN (SELECT org_id FROM orgs WHERE is_synthetic = 0)")).toEqual([
      { n_enrolled: 60, n_completed: 37, status: "confirmed" },
    ]);

    await w.reset();
    expect(await w.summary()).toBe(start);
    expect(w.a.q("SELECT (SELECT COUNT(*) FROM program_cycles) AS cycles, (SELECT COUNT(*) FROM messages) AS messages")).toEqual(startRows);

    const second = await runDemo(w);
    expect(second).toEqual(first);
    expect(await w.summary()).toBe(afterFirst);
  });
});
