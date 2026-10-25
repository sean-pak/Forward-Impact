import { describe, expect, it } from "vitest";
import { app } from "../index";
import { DEMO_FILES } from "../vault/demo";
import { TEST_ENC_B64, TEST_HMAC_B64 } from "../vault/testKeys";
import { makeD1, sqlite } from "../testing/sqlite";
import { resetDemo } from "./reset";

const SECRET = "test-secret";

function setup(over: Record<string, string | undefined> = {}) {
  const a = makeD1("analytics");
  const v = makeD1("vault");
  const env = {
    DB: a.db, VAULT: v.db, VAULT_HMAC_KEY: TEST_HMAC_B64, VAULT_ENC_KEY: TEST_ENC_B64, API_SECRET: SECRET,
    DEMO_MODE: "true", DEMO_CBO_EMAIL: "Cbo@Real.test", DEMO_CBO_ORG: "Test CBO",
    GOOGLE_CLIENT_ID: "i", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r", MAILBOX_ADDRESS: "hello@example.org",
    ...over,
  };
  return { a, v, env };
}

const count = (q: ReturnType<typeof makeD1>["q"], table: string) => Number(q(`SELECT COUNT(*) AS n FROM ${table}`)[0]!.n);

/** Leftovers from a demo run: a real org, a message, a submission, and an extra vault identity. */
function dirty(s: ReturnType<typeof setup>) {
  s.a.raw.exec(`INSERT INTO orgs (org_id, org_name, data_persona, primary_contact_email, private_token, form_token, is_synthetic)
    VALUES ('o_old','Old Org',1,'old@real.test','p','f',0);
    INSERT INTO messages (message_id, gmail_thread_id, direction, kind, org_id, from_email, to_email, occurred_at, is_synthetic)
    VALUES ('m_old','t_old','inbound','inbound','o_old','old@real.test','hello@example.org','2026-10-01T00:00:00Z',0);
    INSERT INTO submissions (submission_id, org_id, channel, received_at, sender_email, parser_version, status, is_synthetic)
    VALUES ('sub_old','o_old','manual','2026-10-01T00:00:00Z','old@real.test','ingest-1','needs_staff',0);`);
  s.v.raw.exec(`INSERT INTO vault_access_log (actor, purpose, n_person_keys) VALUES ('x','org_report',1)`);
}

describe.skipIf(!sqlite)("demo reset", () => {
  it("refuses unless DEMO_MODE is exactly true, and changes nothing", async () => {
    for (const mode of [undefined, "false", "TRUE", "1"]) {
      const s = setup({ DEMO_MODE: mode });
      dirty(s);
      const r = await resetDemo(s.env as never);
      expect(r).toMatchObject({ ok: false, status: 403 });
      expect(count(s.a.q, "orgs")).toBe(1);
      expect(count(s.a.q, "messages")).toBe(1);
    }
  });

  it("a malformed vault secret stops before anything is deleted", async () => {
    const s = setup({ VAULT_ENC_KEY: "not-a-key" });
    dirty(s);
    const r = await resetDemo(s.env as never);
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(r.ok ? "" : r.error).toMatch(/Nothing was changed.*vault secret/);
    expect(count(s.a.q, "orgs")).toBe(1);
    expect(count(s.v.q, "vault_access_log")).toBe(1);
  });

  it("a bad bundle stops before anything is deleted", async () => {
    const s = setup();
    dirty(s);
    const r = await resetDemo(s.env as never, { ...DEMO_FILES, "org.csv": "org_id,org_name\nx,y\n" });
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(count(s.a.q, "orgs")).toBe(1);
  });

  it("restores the exact starting state, twice in a row, with fresh tokens", async () => {
    const s = setup();
    dirty(s);
    const first = await resetDemo(s.env as never);
    expect(first).toMatchObject({ ok: true, cbo: { org_name: "Test CBO", email: "cbo@real.test" } });
    const snapshot = () => ({
      orgs: s.a.q("SELECT org_id, org_name, is_synthetic FROM orgs ORDER BY org_id"),
      contacts: s.a.q("SELECT email, is_primary FROM contacts ORDER BY email"),
      cycles: count(s.a.q, "program_cycles"),
      confirmed: Number(s.a.q("SELECT COUNT(*) AS n FROM program_cycles WHERE status = 'confirmed'")[0]!.n),
      facilities: count(s.a.q, "facilities"),
      benchmarks: count(s.a.q, "benchmark_reference"),
      fields: count(s.a.q, "fields"),
      messages: count(s.a.q, "messages"),
      submissions: count(s.a.q, "submissions"),
      outreach: count(s.a.q, "outreach"),
      identities: count(s.v.q, "person_identity"),
      accessLog: count(s.v.q, "vault_access_log"),
    });
    const one = snapshot();
    expect(one).toMatchObject({ cycles: 10, confirmed: 10, facilities: 31, messages: 0, submissions: 0, outreach: 0, identities: 3, accessLog: 0 });
    expect(one.orgs.map((o) => o.org_id)).not.toContain("o_old");
    expect(one.orgs).toHaveLength(5);
    // the CBO test org is the one real org, and its inbox is the primary contact
    expect(one.orgs.filter((o) => o.is_synthetic === 0)).toEqual([expect.objectContaining({ org_name: "Test CBO" })]);
    expect(one.contacts).toContainEqual({ email: "cbo@real.test", is_primary: 1 });
    const tokens = s.a.q("SELECT form_token FROM orgs ORDER BY org_id");

    dirty(s);
    await resetDemo(s.env as never);
    const two = snapshot();
    expect({ ...two, orgs: two.orgs.map((o) => o.org_name) }).toEqual({ ...one, orgs: one.orgs.map((o) => o.org_name) });
    expect(s.a.q("SELECT form_token FROM orgs ORDER BY org_id")).not.toEqual(tokens);
  });

  it("identities land as ciphertext only", async () => {
    const s = setup();
    await resetDemo(s.env as never);
    // names, CDCR numbers and dates of birth are ciphertext in the vault and absent from analytics.
    // (The vault's org_ids column holds each org's own id for the person as plain JSON, per the PRD schema; see HANDOFF.md.)
    for (const value of ["Personone", "Persontwo", "SYN90001", "SYN90002", "1985-03-14"]) {
      expect(s.v.dump(), value).not.toContain(value);
      expect(s.a.dump(), value).not.toContain(value);
    }
    expect(s.a.dump()).not.toContain("D-0001");
    expect(count(s.v.q, "person_identity")).toBe(3);
  });

  it("the route needs the bearer secret and a confirm body", async () => {
    const s = setup();
    dirty(s);
    const call = (headers: Record<string, string>, body?: unknown) =>
      app.fetch(new Request("https://w.test/api/demo/reset", { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }), s.env as never);
    expect((await call({}, { confirm: "reset" })).status).toBe(401);
    expect((await call({ Authorization: `Bearer ${SECRET}` })).status).toBe(400);
    expect((await call({ Authorization: `Bearer ${SECRET}` }, { confirm: "yes" })).status).toBe(400);
    expect(count(s.a.q, "orgs")).toBe(1);
    const ok = await call({ Authorization: `Bearer ${SECRET}` }, { confirm: "reset" });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(await ok.json())).not.toMatch(/token/);
    expect(count(s.a.q, "orgs")).toBe(5);
  });
});
