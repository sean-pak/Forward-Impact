import Papa from "papaparse";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmById } from "../form";
import { syncGmail } from "../gmail/sync";
import { ingest } from "../ingest";
import { RecordedLlm } from "../ingest/recorded";
import { Vault } from "../vault";
import { TEST_ENC_B64, TEST_HMAC_B64, testKeys } from "../vault/testKeys";
import { makeGmail, scripted } from "../testing/mail";
import { makeD1, readFixture, readJson, sqlite } from "../testing/sqlite";

// The PII leak test (CLAUDE.md, PLAN phase 10). Every persona fixture goes through the real pipeline; then no name,
// CDCR number or date of birth from any fixture may appear in an analytics row, a log line, an LLM request, or an email.

const rows = (file: string) => Papa.parse<string[]>(readFixture(file).toString("utf8"), { skipEmptyLines: "greedy" }).data;
const usToIso = (d: string) => { const [m, day, y] = d.split("/"); return `${y}-${m!.padStart(2, "0")}-${day!.padStart(2, "0")}`; };

/** Every identifier in the persona 3 and 4 fixtures, in every form it is written. */
function identifiers() {
  const out = new Set<string>();
  const add = (v: string | undefined) => v && out.add(v);
  const p3 = rows("org_c_persona3_attendance.csv").slice(3); // after the notes, label and header lines
  for (const r of p3) { add(r[0]); add(r[1]); r[0]?.split(" ").forEach(add); }
  const p4 = rows("org_d_persona4_individuals.csv").slice(1);
  for (const r of p4) {
    add(r[0]); add(r[1]); r[0]?.split(" ").forEach(add);
    if (r[2]) { add(r[2]); add(usToIso(r[2])); }
  }
  return [...out].filter((s) => s.length >= 5);
}

afterEach(() => vi.restoreAllMocks());

describe.skipIf(!sqlite)("PII leak test", () => {
  it("no fixture name, CDCR number or date of birth reaches analytics, logs, LLM requests or email", async () => {
    const logs: string[] = [];
    for (const k of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));

    const a = makeD1("analytics");
    const v = makeD1("vault");
    a.raw.exec(`INSERT INTO orgs (org_id, org_name, data_persona, primary_contact_email, form_token, is_synthetic) VALUES
      ('oa','Org A',1,'a@real.test','t1',0), ('ob','Org B',2,'b@real.test','t2',0), ('oc','Org C',3,'dana@real.test','t3',0), ('od','Org D',4,'d@real.test','t4',0);
      INSERT INTO contacts (contact_id, org_id, name, email, is_primary, is_synthetic) VALUES ('k3','oc','Dana','dana@real.test',1,0);
      INSERT INTO programs (program_id, org_id, program_name, is_synthetic) VALUES ('p3','oc','Healing Circle',0);`);
    const vault = new Vault(v.db, await testKeys());
    const org = (id: string, name: string) => ({ org_id: id, org_name: name, primary_contact_email: `${id}@real.test`, is_synthetic: 0 });
    const prompts: string[] = [];
    const run = async (orgRow: ReturnType<typeof org>, file: string, rec: string, input: "table" | "text") => {
      const llm = new RecordedLlm(readJson(rec));
      const bytes = readFixture(file);
      const out = await ingest(
        a.db, llm, orgRow,
        input === "text" ? { kind: "text", text: bytes.toString("utf8") } : { kind: "table", filename: file, bytes: new Uint8Array(bytes) },
        { channel: "manual", senderEmail: orgRow.primary_contact_email, today: "2026-10-25" }, () => Promise.resolve(vault),
      );
      prompts.push(...llm.prompts);
      return out;
    };

    // Persona 1 and 2 (no identifiers by design) and persona 4 through ingest.
    await run(org("oa", "Org A"), "org_a_persona1_programs.csv", "org_a_persona1_programs.llm.json", "table");
    await run(org("ob", "Org B"), "org_b_persona2_email.txt", "org_b_persona2_email.llm.json", "text");
    const p4 = await run(org("od", "Org D"), "org_d_persona4_individuals.csv", "org_d_persona4_individuals.llm.json", "table");
    await confirmById(a.db, p4.submission_id!);

    // Persona 3 by email, the whole conversation, through confirmation.
    const g = makeGmail();
    const m = scripted({
      map_columns: readJson("org_c_persona3_attendance.llm.json").map_columns,
      classify_legend: [{ marks: [{ mark: "JT", meaning: "excused" }, { mark: "L", meaning: "late" }], late_counts_as_attended: true }],
    });
    const env = { GOOGLE_CLIENT_ID: "i", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r", MAILBOX_ADDRESS: "hello@example.org", DB: a.db, VAULT: v.db, VAULT_HMAC_KEY: TEST_HMAC_B64, VAULT_ENC_KEY: TEST_ENC_B64 };
    g.receive("T1", "Attendance attached.", [{ filename: "attendance.csv", type: "text/csv", bytes: new Uint8Array(readFixture("org_c_persona3_attendance.csv")) }]);
    for (const reply of [null, "JT is excused, L is late, late counts.", "YES", "YES"]) {
      if (reply) g.receive("T1", reply);
      await syncGmail(env, g.gmail, m.llm);
    }
    expect(a.q("SELECT status FROM program_cycles WHERE org_id = 'oc'")[0]!.status).toBe("confirmed");
    prompts.push(...m.prompts);

    // The fixtures really did produce people (so the checks below are not vacuous).
    expect(v.q("SELECT count(*) AS n FROM person_identity")[0]!.n).toBeGreaterThan(200);
    expect(a.q("SELECT count(*) AS n FROM enrollments")[0]!.n).toBeGreaterThan(200);
    expect(prompts.length).toBeGreaterThanOrEqual(5);

    const haystacks: Record<string, string> = {
      "analytics rows": a.dump(),
      "log lines": logs.join("\n"),
      "LLM requests": prompts.join("\n"),
      "outbound email": g.sent.map((s) => `${s.subject}\n${s.text}`).join("\n"),
      "vault (ciphertext only)": v.dump(),
    };
    const ids = identifiers();
    expect(ids.length).toBeGreaterThan(300);
    for (const [where, text] of Object.entries(haystacks)) {
      const leaked = ids.filter((id) => text.includes(id));
      expect(leaked, `${where} contains identifiers`).toEqual([]);
    }

    // And the vault does hold them, recoverable only through reidentify (which logs the access).
    const someKey = a.q("SELECT person_key FROM enrollments LIMIT 1")[0]!.person_key as string;
    const [who] = await vault.reidentify([someKey], { purpose: "admin_vault_view", actor: "test" });
    expect(ids).toContain(who!.firstName);
    expect(v.q("SELECT count(*) AS n FROM vault_access_log")[0]!.n).toBe(1);
  });

  it("a failed vault write leaves no analytics rows behind and no identifier in the error", async () => {
    const a = makeD1("analytics");
    a.raw.exec("INSERT INTO orgs (org_id, org_name, data_persona, primary_contact_email, is_synthetic) VALUES ('od','Org D',4,'d@real.test',1)");
    const broken = { upsertIdentities: async () => { throw new Error("vault unavailable"); } };
    const error = await ingest(
      a.db, new RecordedLlm(readJson("org_d_persona4_individuals.llm.json")), { org_id: "od", org_name: "Org D", primary_contact_email: "d@real.test", is_synthetic: 1 },
      { kind: "table", filename: "x.csv", bytes: new Uint8Array(readFixture("org_d_persona4_individuals.csv")) },
      { channel: "manual", senderEmail: "d@real.test", today: "2026-10-25" }, () => Promise.resolve(broken),
    ).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/SYN5|Pellegrino/);
    for (const t of ["submissions", "program_cycles", "enrollments", "staged_people"]) expect(a.q(`SELECT count(*) AS n FROM ${t}`)[0]!.n, t).toBe(0);
  });
});
