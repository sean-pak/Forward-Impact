import Papa from "papaparse";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrgReportSchema } from "@tpw/shared";
import { app } from "../index";
import { confirmById } from "../form";
import { TEST_ENC_B64, TEST_HMAC_B64 } from "../vault/testKeys";
import { makeD1, readFixture, readJson, sqlite } from "../testing/sqlite";
import { orgReportUrl } from ".";

const SECRET = "test-secret";

async function worker() {
  const a = makeD1("analytics");
  const v = makeD1("vault");
  a.raw.exec(`INSERT INTO orgs (org_id, org_name, data_persona, primary_contact_email, private_token, form_token, is_synthetic) VALUES
    ('od','Org D',4,'d@real.test','priv_d','form_d',0), ('oe','Org E',1,'e@real.test','priv_e','form_e',0),
    ('of','Org F',1,'f@real.test',NULL,'form_f',0);`);
  const env = {
    DB: a.db, VAULT: v.db, VAULT_HMAC_KEY: TEST_HMAC_B64, VAULT_ENC_KEY: TEST_ENC_B64, API_SECRET: SECRET,
    OPENROUTER_API_KEY: "k", LLM_MODEL: "test/model",
    GOOGLE_CLIENT_ID: "i", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r", MAILBOX_ADDRESS: "hello@example.org",
  };
  const call = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`https://w.test${path}`, { ...init, headers: { Authorization: `Bearer ${SECRET}`, ...(init.headers ?? {}) } }), env as never);
  const report = async (token: string) => {
    const res = await call(`/api/org/${token}/report`);
    return { status: res.status, text: await res.text() };
  };
  return { a, v, env, call, report };
}

/** Persona 4 CSV uploaded for Org D, with the recorded column mapping standing in for OpenRouter. */
async function uploadPersona4(w: Awaited<ReturnType<typeof worker>>): Promise<string> {
  const mapping = readJson("org_d_persona4_individuals.llm.json").map_columns;
  vi.stubGlobal("fetch", async () => Response.json({ choices: [{ message: { content: JSON.stringify(mapping) } }] }));
  const form = new FormData();
  form.set("org_id", "od");
  form.set("file", new File([readFixture("org_d_persona4_individuals.csv")], "org_d_persona4_individuals.csv", { type: "text/csv" }));
  const res = await w.call("/api/ingest/upload", { method: "POST", body: form });
  expect(res.status).toBe(200);
  return ((await res.json()) as { submission_id: string }).submission_id;
}

const fixtureCdcrs = () => {
  const [, ...rows] = Papa.parse<string[]>(readFixture("org_d_persona4_individuals.csv").toString("utf8"), { skipEmptyLines: "greedy" }).data;
  return [...new Set(rows.map((r) => r[1]!).filter(Boolean))];
};

afterEach(() => vi.unstubAllGlobals());

describe.skipIf(!sqlite)("CBO report page", () => {
  it("shows the org its own people, re-identified, only after it confirms; every view is logged", async () => {
    const w = await worker();
    const submissionId = await uploadPersona4(w);
    const cdcrs = fixtureCdcrs();
    expect(cdcrs.length).toBeGreaterThan(10);

    // Draft data is not on the report yet.
    const draft = OrgReportSchema.parse(JSON.parse((await w.report("priv_d")).text));
    expect(draft.dashboard.cycles).toHaveLength(0);
    expect(draft.participants).toEqual([]);
    expect(draft.grant_text).toBeNull();

    expect((await confirmById(w.a.db, submissionId)).ok).toBe(true);
    const { status, text } = await w.report("priv_d");
    expect(status).toBe(200);
    const r = OrgReportSchema.parse(JSON.parse(text));
    expect(r.org_name).toBe("Org D");
    expect(r.dashboard.cycles).toHaveLength(4);
    const enrollments = w.a.q("SELECT COUNT(*) AS n FROM enrollments")[0]!.n as number;
    expect(r.participants).toHaveLength(enrollments);
    for (const cdcr of cdcrs) expect(text).toContain(cdcr);
    expect(r.participants!.every((p) => p.last_name !== null || p.cdcr_number !== null)).toBe(true);
    expect(r.grant_text).toContain("Org D ran 4 classes");
    // Persona 4 marks completion itself with no stated rule, so there is no rate to state.
    expect(r.grant_text).not.toContain("completed (");

    const log = w.v.q("SELECT actor, purpose, org_id, n_person_keys FROM vault_access_log WHERE purpose = 'org_report'");
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({ actor: "org_report_link", org_id: "od", n_person_keys: new Set(w.a.q("SELECT person_key FROM enrollments").map((e) => e.person_key)).size });
  });

  it("another org's token never returns them, even if its rows point at the same person_keys", async () => {
    const w = await worker();
    expect((await confirmById(w.a.db, await uploadPersona4(w))).ok).toBe(true);
    // Org E confirms a class whose enrollment rows reuse Org D's person_keys (a bug or a tampered row).
    w.a.raw.exec(`INSERT INTO programs (program_id, org_id, program_name, is_synthetic) VALUES ('pe','oe','Art',0);
      INSERT INTO program_cycles (cycle_id, org_id, program_id, cycle_key, facility_code, start_date, n_enrolled, n_completed, status, source_grain, is_synthetic)
        VALUES ('ce','oe','pe','k_e','SQ','2025-02-01',3,2,'confirmed','aggregate',0);`);
    for (const { person_key } of w.a.q("SELECT DISTINCT person_key FROM enrollments LIMIT 3")) {
      w.a.raw.prepare("INSERT INTO enrollments (enrollment_id, cycle_id, person_key, completed, is_synthetic) VALUES (?, 'ce', ?, 'yes', 0)").run(`e_${person_key}`, person_key as string);
    }

    const { status, text } = await w.report("priv_e");
    expect(status).toBe(200);
    const r = OrgReportSchema.parse(JSON.parse(text));
    expect(r.participants).toHaveLength(3);
    expect(r.participants!.every((p) => p.first_name === null && p.last_name === null && p.cdcr_number === null)).toBe(true);
    for (const cdcr of fixtureCdcrs()) expect(text).not.toContain(cdcr);
    expect(w.v.q("SELECT org_id FROM vault_access_log WHERE purpose = 'org_report'")).toEqual([{ org_id: "oe" }]);
  });

  it("an unknown token is a 404 and reaches no vault", async () => {
    const w = await worker();
    expect((await w.report("nope")).status).toBe(404);
    expect(w.v.q("SELECT * FROM vault_access_log")).toEqual([]);
  });

  it("builds the emailed link, minting a private token for an org that has none", async () => {
    const w = await worker();
    expect(await orgReportUrl(w.a.db, "https://web.test/", "od")).toBe("https://web.test/o/priv_d");
    expect(await orgReportUrl(w.a.db, undefined, "od")).toBeUndefined();
    const url = await orgReportUrl(w.a.db, "https://web.test", "of");
    const token = w.a.q("SELECT private_token FROM orgs WHERE org_id = 'of'")[0]!.private_token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(url).toBe(`https://web.test/o/${token}`);
    expect(await orgReportUrl(w.a.db, "https://web.test", "of")).toBe(url);
  });
});
