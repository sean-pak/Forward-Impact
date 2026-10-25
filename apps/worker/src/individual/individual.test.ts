import { describe, expect, it } from "vitest";
import { type OrgRow } from "../form";
import { confirmById } from "../form";
import { ingest } from "../ingest";
import { RecordedLlm } from "../ingest/recorded";
import { Vault } from "../vault";
import { testKeys } from "../vault/testKeys";
import { makeD1, readFixture, readJson, sqlite } from "../testing/sqlite";

const TODAY = "2026-10-25";
const org: OrgRow = { org_id: "orgd", org_name: "Org D", primary_contact_email: "d@example.org", is_synthetic: 1 };

async function setup() {
  const a = makeD1("analytics");
  const v = makeD1("vault");
  a.raw.exec(`INSERT INTO orgs (org_id, org_name, data_persona, primary_contact_email, is_synthetic) VALUES ('orgd','Org D',1,'d@example.org',1)`);
  const vault = new Vault(v.db, await testKeys());
  return { a, v, vault, store: () => Promise.resolve(vault) };
}

describe.skipIf(!sqlite)("persona 4: individual rows through the vault", async () => {
  const want = readJson("org_d_persona4_individuals.expected.json");

  async function run() {
    const s = await setup();
    const llm = new RecordedLlm(readJson("org_d_persona4_individuals.llm.json"));
    const out = await ingest(
      s.a.db, llm, org,
      { kind: "table", filename: "org_d_persona4_individuals.csv", bytes: new Uint8Array(readFixture("org_d_persona4_individuals.csv")) },
      { channel: "manual", senderEmail: "d@example.org", today: TODAY }, s.store,
    );
    return { ...s, out, llm };
  }

  it("makes one derived cycle per program, prison and start date, with the planted counts", async () => {
    const { a, out } = await run();
    expect(out).toMatchObject({ status: "awaiting_confirmation", cycles: 4 });
    const cycles = a.q(
      `SELECT p.program_name, c.facility_code, c.start_date, c.n_enrolled, c.n_completed, c.source_grain, c.status
       FROM program_cycles c JOIN programs p ON p.program_id = c.program_id ORDER BY c.start_date`,
    );
    expect(cycles).toHaveLength(4);
    for (const [i, t] of want.cycles.entries()) {
      const got = cycles.find((c) => c.facility_code === t.code && c.start_date === t.start);
      expect(got, `cycle ${i}`).toMatchObject({ program_name: t.program, n_enrolled: t.enrolled, n_completed: t.completed, source_grain: "derived_from_individuals", status: "awaiting_confirmation" });
    }
  });

  it("stores credit days per person and counts a person in two programs once per program", async () => {
    const { a } = await run();
    expect(a.q("SELECT count(*) AS n FROM enrollments")[0]!.n).toBe(want.rows);
    expect(a.q("SELECT count(DISTINCT person_key) AS n FROM enrollments")[0]!.n).toBe(want.people);
    const credits = a.q("SELECT sum(credit_days_earned) AS n, count(*) AS rows, count(credit_days_applied) AS applied FROM credit_awards")[0]!;
    expect(credits.n).toBe(want.cycles.reduce((n: number, c: { credits: number }) => n + c.credits, 0));
    expect(credits.applied).toBe(0); // earned is never copied into applied
  });

  it("scrambles people into the vault: ciphertext only, and the receipt counts are right", async () => {
    const { a, v, vault } = await run();
    expect(v.q("SELECT count(*) AS n FROM person_identity")[0]!.n).toBe(want.people);
    expect(v.q("SELECT count(*) AS n FROM person_identity WHERE person_key_basis = 'cdcr_number'")[0]!.n).toBe(want.people_with_cdcr);
    expect(v.q("SELECT count(*) AS n FROM person_identity WHERE person_key_basis = 'org_name'")[0]!.n).toBe(want.people_with_no_cdcr);
    const dump = v.dump();
    expect(dump).not.toMatch(/SYN5\d{4}|Pellegrino|Radcliffe/);
    expect(a.q("SELECT scrambled_names AS n, scrambled_cdcr AS c FROM submissions")[0]).toEqual({ n: want.people, c: want.people_with_cdcr });
    const sample = v.q("SELECT person_key FROM person_identity LIMIT 1")[0]!.person_key as string;
    const [id] = await vault.reidentify([sample], { purpose: "admin_vault_view", actor: "test" });
    expect(id!.firstName).toBeTruthy();
  });

  it("holds attributes, releases and custody back until the CBO confirms, then promotes them", async () => {
    const { a, out } = await run();
    expect(a.q("SELECT count(*) AS n FROM staged_people")[0]!.n).toBeGreaterThan(0);
    for (const t of ["person_attributes", "release_events", "custody_status"]) expect(a.q(`SELECT count(*) AS n FROM ${t}`)[0]!.n, t).toBe(0);

    // The completion rule is not blocking; confirming works once the rule question is not required.
    expect((await confirmById(a.db, out.submission_id!)).ok).toBe(true);
    expect(a.q("SELECT count(*) AS n FROM staged_people")[0]!.n).toBe(0);
    expect(a.q("SELECT count(*) AS n FROM release_events")[0]!.n).toBe(want.people_released);
    expect(a.q("SELECT count(*) AS n FROM custody_status WHERE status = 'released'")[0]!.n).toBe(want.people_released);
    expect(a.q("SELECT count(*) AS n FROM custody_status WHERE status = 'in_custody' AND projected_release_date > ?", TODAY)[0]!.n).toBe(want.people_with_future_release);
    // A release before the program started is kept but marked not post-program.
    expect(a.q("SELECT count(*) AS n FROM release_events WHERE post_program = 0")[0]!.n).toBe(want.people_released_before_program_start);
    expect(a.q("SELECT count(*) AS n FROM release_events WHERE release_date > ?", TODAY)[0]!.n).toBe(0);
    expect(a.q("SELECT count(*) AS n FROM release_events WHERE release_fiscal_year IS NULL")[0]!.n).toBe(0);
    expect(a.q("SELECT count(*) AS n FROM person_attributes WHERE age_band_at_release <> 'unknown'")[0]!.n).toBe(want.people_released);
  });

  it("shows the model only masked column profiles, never a name, number or date of birth", async () => {
    const { llm } = await run();
    expect(llm.prompts).toHaveLength(1);
    const prompt = llm.prompts[0]!;
    for (const raw of ["Pellegrino", "Radcliffe", "SYN52000", "1/1/1965", "Reentry Readiness", "Folsom"]) expect(prompt).not.toContain(raw);
    expect(prompt).toContain("Inmate #"); // headers are allowed
  });

  it("turns future release dates into expected release dates, never into releases", async () => {
    const { a, out } = await run();
    await confirmById(a.db, out.submission_id!);
    expect(a.q("SELECT count(*) AS n FROM custody_status WHERE projected_release_date IS NOT NULL AND status <> 'in_custody'")[0]!.n).toBe(0);
  });

  it("sends the file to staff, reading nothing, when the vault is not configured", async () => {
    const { a } = await setup();
    const out = await ingest(
      a.db, new RecordedLlm(readJson("org_d_persona4_individuals.llm.json")), org,
      { kind: "table", filename: "x.csv", bytes: new Uint8Array(readFixture("org_d_persona4_individuals.csv")) },
      { channel: "manual", senderEmail: "d@example.org", today: TODAY },
    );
    expect(out.status).toBe("needs_staff");
    expect(a.q("SELECT count(*) AS n FROM enrollments")[0]!.n).toBe(0);
    expect(a.q("SELECT count(*) AS n FROM program_cycles")[0]!.n).toBe(0);
  });

  it("refuses CDCR numbers that are not SYN test numbers and does not store them", async () => {
    const { a, v } = await setup();
    const csv = readFixture("org_d_persona4_individuals.csv").toString("utf8").replaceAll("SYN52000", "A12345");
    await ingest(a.db, new RecordedLlm(readJson("org_d_persona4_individuals.llm.json")), org,
      { kind: "table", filename: "x.csv", bytes: new TextEncoder().encode(csv) }, { channel: "manual", senderEmail: "d@example.org", today: TODAY }, async () => new Vault(v.db, await testKeys()));
    expect(a.dump()).not.toContain("A12345");
    expect(v.q("SELECT count(*) AS n FROM person_identity WHERE person_key_basis = 'cdcr_number'")[0]!.n).toBe(want.people_with_cdcr - 1);
  });
});
