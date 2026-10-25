import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stripQuoted } from "@tpw/shared";
import { ingest, type IngestInput } from ".";
import type { OrgRow } from "../form";
import { RecordedLlm } from "./recorded";

const DIR = join(__dirname, "../../../../fixtures/ingest");
const read = (f: string) => readFileSync(join(DIR, f));
const json = (f: string) => JSON.parse(read(f).toString("utf8"));

type Call = { sql: string; params: unknown[] };
const COLS = /INSERT INTO program_cycles\s*\(([^)]+)\)/;

/** Fake D1 that records writes. Reads return no programs and no registry fields. */
function fakeD1() {
  const calls: Call[] = [];
  const bound = (sql: string, params: unknown[]) => ({
    sql, params,
    run: async () => (calls.push({ sql, params }), { meta: { changes: 1 } }),
    first: async () => null,
    all: async () => ({ results: [] }),
  });
  const db = {
    prepare: (sql: string) => ({ ...bound(sql, []), bind: (...p: unknown[]) => bound(sql, p) }),
    batch: async (list: Call[]) => (list.forEach((s) => calls.push({ sql: s.sql, params: s.params })), []),
  } as unknown as D1Database;
  return { db, calls };
}

function written(calls: Call[]) {
  const cycles = calls.filter((c) => c.sql.includes("INSERT INTO program_cycles")).map((c) => {
    const names = COLS.exec(c.sql)![1]!.split(",").map((s) => s.trim()).filter((n) => n !== "source_grain");
    return Object.fromEntries(names.map((n, i) => [n, c.params[i]])) as Record<string, unknown>;
  });
  const issues = calls.filter((c) => c.sql.includes("INSERT INTO field_issues")).map((c) => ({
    row_ref: c.params[2] as string, field_name: c.params[1] as string, issue_type: c.params[3] as string,
  }));
  return { cycles, issues };
}

const org: OrgRow = { org_id: "o1", org_name: "Org", primary_contact_email: "a@real.test", is_synthetic: 0 };

const CASES: { name: string; file: string; input: () => IngestInput }[] = [
  { name: "persona 2 email text", file: "org_b_persona2_email", input: () => ({ kind: "text", text: read("org_b_persona2_email.txt").toString("utf8") }) },
  { name: "persona 1 CSV", file: "org_a_persona1_programs", input: () => ({ kind: "table", filename: "org_a_persona1_programs.csv", bytes: new Uint8Array(read("org_a_persona1_programs.csv")) }) },
];

describe.each(CASES)("fixture: $name", ({ file, input }) => {
  const expected = json(`${file}.expected.json`) as {
    status: string;
    cycles: Record<string, unknown>[];
    issues: { cycle: number; field_name: string; issue_type: string }[];
  };

  async function run(channel: "email_body" | "email_attachment" | "manual") {
    const { db, calls } = fakeD1();
    const llm = new RecordedLlm(json(`${file}.llm.json`));
    const out = await ingest(db, llm, org, input(), { channel, senderEmail: "a@real.test" });
    return { out, llm, calls, ...written(calls) };
  }

  it("produces the expected cycles and issues", async () => {
    const r = await run("manual");
    expect(r.out.status).toBe(expected.status);
    expect(r.cycles).toHaveLength(expected.cycles.length);
    expected.cycles.forEach((want, i) => expect(r.cycles[i]).toMatchObject(want));
    // Cycles are drafts or awaiting confirmation: nothing counts until the CBO confirms.
    expect(r.cycles.every((c) => c.status === undefined || c.status !== "confirmed")).toBe(true);
    for (const want of expected.issues) {
      expect(r.issues).toContainEqual({ row_ref: expect.any(String), field_name: want.field_name, issue_type: want.issue_type });
    }
  });

  it("gives the same result by email or upload", async () => {
    const a = await run("email_body");
    const b = await run("manual");
    const strip = (cs: Record<string, unknown>[]) => cs.map(({ cycle_id: _i, submission_id: _s, cycle_key: _k, program_id: _p, ...rest }) => rest);
    expect(strip(a.cycles)).toEqual(strip(b.cycles));
    expect(a.issues.map(({ row_ref: _r, ...i }) => i)).toEqual(b.issues.map(({ row_ref: _r, ...i }) => i));
  });
});

describe("persona 2 email specifics", () => {
  it("flags 'about 30' approximate, maps Men's Colony to CMC, and asks for the missing completion rule", async () => {
    const { db, calls } = fakeD1();
    await ingest(db, new RecordedLlm(json("org_b_persona2_email.llm.json")), org,
      { kind: "text", text: read("org_b_persona2_email.txt").toString("utf8") }, { channel: "email_body", senderEmail: "a@real.test" });
    const { cycles, issues } = written(calls);
    expect(cycles[0]).toMatchObject({ facility_code: "CMC", n_enrolled: 30, n_enrolled_approx: 1 });
    expect(issues.some((i) => i.field_name === "completion_rule")).toBe(true);
  });

  it("drops a count that the text never contains instead of keeping an invented one", async () => {
    const rec = json("org_b_persona2_email.llm.json");
    rec.extract_cycles.cycles[1].n_enrolled = 99;
    const { db, calls } = fakeD1();
    await ingest(db, new RecordedLlm(rec), org, { kind: "text", text: read("org_b_persona2_email.txt").toString("utf8") }, { channel: "manual", senderEmail: "a@real.test" });
    const { cycles, issues } = written(calls);
    expect(cycles[1]!.n_enrolled).toBeNull();
    expect(issues.some((i) => i.field_name === "n_enrolled")).toBe(true);
  });

  it("scrubs ID-shaped tokens and emails before the model sees the text", async () => {
    const llm = new RecordedLlm(json("org_b_persona2_email.llm.json"));
    const { db } = fakeD1();
    await ingest(db, llm, org, { kind: "text", text: "We had 30 people. Contact dana@example.org or A12345 about it. Started 2025-02-03 at CMC." }, { channel: "manual", senderEmail: "a@real.test" });
    expect(llm.prompts[0]).not.toMatch(/dana@|A12345/);
  });

  it("reports no data without writing anything when the model finds no cycles", async () => {
    const { db, calls } = fakeD1();
    const out = await ingest(db, new RecordedLlm({ extract_cycles: { persona: null, cycles: [] } }), org, { kind: "text", text: "Thanks, see you soon" }, { channel: "manual", senderEmail: "a@real.test" });
    expect(out.status).toBe("no_data");
    expect(calls).toHaveLength(0);
  });
});

describe("persona 1 table specifics", () => {
  it("shows the model only masked column profiles, never a cell value", async () => {
    const llm = new RecordedLlm(json("org_a_persona1_programs.llm.json"));
    const { db } = fakeD1();
    await ingest(db, llm, org, { kind: "table", filename: "x.csv", bytes: new Uint8Array(read("org_a_persona1_programs.csv")) }, { channel: "manual", senderEmail: "a@real.test" });
    const prompt = llm.prompts[0]!;
    for (const raw of ["Poetry Workshop", "Job Skills", "San Quentin", "Folsom", "Mule Creek", "2025-01-13", "Yard A", "Org A"]) {
      expect(prompt).not.toContain(raw);
    }
    expect(prompt).toContain("program_name"); // headers are allowed
  });

  it("sends a person-level mapping to staff and reads no rows", async () => {
    const rec = json("org_a_persona1_programs.llm.json");
    rec.map_columns.columns[1].target = "id_full_name";
    const { db, calls } = fakeD1();
    const out = await ingest(db, new RecordedLlm(rec), org, { kind: "table", filename: "x.csv", bytes: new Uint8Array(read("org_a_persona1_programs.csv")) }, { channel: "manual", senderEmail: "a@real.test" });
    expect(out.status).toBe("needs_staff");
    expect(calls.some((c) => c.sql.includes("INSERT INTO program_cycles"))).toBe(false);
  });
});

describe("stripQuoted", () => {
  it("keeps only the new text", () => {
    expect(stripQuoted("We had 20.\n\nOn Mon, Jan 5, Sam wrote:\n> Hi\n> there")).toBe("We had 20.");
  });
});
