import { describe, expect, it } from "vitest";
import { syncGmail } from "../gmail/sync";
import { ingest } from "../ingest";
import { RecordedLlm } from "../ingest/recorded";
import { Vault } from "../vault";
import { TEST_ENC_B64, TEST_HMAC_B64, testKeys } from "../vault/testKeys";
import { classify, makeGmail, scripted } from "../testing/mail";
import { makeD1, readFixture, readJson, sqlite } from "../testing/sqlite";

const want = readJson("org_c_persona3_attendance.expected.json") as {
  sessions: { total: number; cancelled_columns: number[]; planned: number };
  duplicate: { lines: number[] };
  people: { line: number; attended: number; planned: number; rate: number; completed: boolean }[];
  n_enrolled: number; n_completed: number; n_completed_if_late_not_counted: number; conflicts: number[];
};
const mapping = readJson("org_c_persona3_attendance.llm.json").map_columns;
const csvBytes = () => new Uint8Array(readFixture("org_c_persona3_attendance.csv"));
const legend = (over: Record<string, unknown> = {}) => ({
  marks: [{ mark: "JT", meaning: "excused" }, { mark: "L", meaning: "late" }], late_counts_as_attended: true, ...over,
});

async function world(opts: { program?: boolean } = {}) {
  const a = makeD1("analytics");
  const v = makeD1("vault");
  a.raw.exec(`INSERT INTO orgs (org_id, org_name, data_persona, primary_contact_email, form_token, is_synthetic) VALUES ('o1','Healing Org',3,'dana@real.test','ftok',0);
              INSERT INTO contacts (contact_id, org_id, name, email, is_primary, is_synthetic) VALUES ('k1','o1','Dana','dana@real.test',1,0);`);
  if (opts.program !== false) a.raw.exec("INSERT INTO programs (program_id, org_id, program_name, is_synthetic) VALUES ('p1','o1','Healing Circle',0)");
  const g = makeGmail();
  const env = {
    GOOGLE_CLIENT_ID: "i", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r", MAILBOX_ADDRESS: "hello@example.org",
    DB: a.db, VAULT: v.db, VAULT_HMAC_KEY: TEST_HMAC_B64, VAULT_ENC_KEY: TEST_ENC_B64,
  };
  const csv = { filename: "attendance.csv", type: "text/csv", bytes: csvBytes() };
  return { a, v, g, env, csv };
}

const cycle = (a: ReturnType<typeof makeD1>) => a.q("SELECT cycle_id, n_enrolled, n_completed, status, sessions_planned, start_date, end_date, facility_code, source_grain, extra FROM program_cycles")[0]!;

describe.skipIf(!sqlite)("persona 3 attendance sheet by email (real SQLite, real vault)", () => {
  it("asks what the marks mean, applies the answer, asks about the possible duplicate, then confirms", async () => {
    const { a, v, g, env, csv } = await world();
    const m = scripted({
      map_columns: mapping,
      classify_legend: [legend()],
    });
    const run = () => syncGmail(env, g.gmail, m.llm);

    // 1. The sheet arrives. One question, in the same thread, naming the marks and late.
    g.receive("T1", "Here is our attendance sheet.", [csv]);
    expect(await run()).toMatchObject({ ingested: 1 });
    expect(g.sent).toHaveLength(1);
    expect(g.sent[0]!.text).toContain("What do 'JT' and 'L' mean in the attendance sheet for Healing Circle?");
    expect(g.sent[0]!.text).toContain("And does a late count as attended?");
    expect(g.sent[0]!.text.trim().endsWith("Sam, TPW's data assistant")).toBe(true);
    // Nothing is guessed while the marks are unexplained, and nothing counts yet.
    expect(a.q("SELECT status, followup_rounds, scrambled_names, scrambled_cdcr FROM submissions")).toEqual([{ status: "needs_info", followup_rounds: 1, scrambled_names: 61, scrambled_cdcr: 60 }]);
    expect(cycle(a)).toMatchObject({ n_enrolled: 61, n_completed: null, status: "draft", source_grain: "derived_from_individuals", facility_code: "SQ", sessions_planned: 16, start_date: "2026-01-12", end_date: "2026-05-11" });
    expect(a.q("SELECT count(*) AS n FROM program_cycles WHERE status = 'confirmed'")[0]!.n).toBe(0);
    expect(a.q("SELECT count(*) AS n FROM sessions WHERE cancelled = 1")[0]!.n).toBe(2);
    expect(a.q("SELECT count(*) AS n FROM enrollments WHERE sessions_attended IS NOT NULL")[0]!.n).toBe(0);

    // 2. The legend answer is applied. Counts now match the planted truth; the duplicate question is next.
    g.receive("T1", "JT means they were excused for court and L means late. Late counts as attended.");
    await run();
    expect(g.sent).toHaveLength(2);
    expect(g.sent[1]!.text).toContain(`Lines ${want.duplicate.lines[0]} and ${want.duplicate.lines[1]}`);
    expect(m.calls).toEqual(["map_columns", "classify_legend"]);
    expect(a.q("SELECT status, followup_rounds FROM submissions")).toEqual([{ status: "awaiting_confirmation", followup_rounds: 2 }]);
    expect(a.q("SELECT status FROM session_attendance WHERE raw_mark = 'JT' LIMIT 1")[0]!.status).toBe("excused");
    expect(a.q("SELECT status FROM session_attendance WHERE raw_mark = 'L' LIMIT 1")[0]!.status).toBe("late");
    const rows = a.q("SELECT sessions_attended AS attended, sessions_planned_for_person AS planned, attendance_rate AS rate, completed, completion_basis FROM enrollments ORDER BY rowid");
    expect(rows).toHaveLength(61);
    want.people.forEach((p, i) => {
      expect(rows[i], `line ${p.line}`).toMatchObject({ attended: p.attended, planned: p.planned, rate: p.rate, completed: p.completed ? "yes" : "no", completion_basis: "rule_applied" });
    });

    // 3. YES: the later line is one person with the earlier one. The receipt carries the truth and the notes.
    g.receive("T1", "YES");
    await run();
    expect(g.sent).toHaveLength(3);
    const receipt = g.sent[2]!.text;
    expect(receipt).toContain(`${want.n_enrolled} enrolled, ${want.n_completed} completed; completion means: attended at least 80% of sessions`);
    expect(receipt).toContain("61 names and 60 CDCR numbers were scrambled and stored separately.");
    expect(receipt).toContain("2 class dates had no mark for anyone");
    expect(receipt).toContain(`For ${want.conflicts.length} people, your own completed mark disagrees with the completion rule. I used the rule.`);
    expect(receipt).toContain("Reply YES to confirm");
    expect(cycle(a)).toMatchObject({ n_enrolled: want.n_enrolled, n_completed: want.n_completed });
    expect(a.q("SELECT count(*) AS n FROM enrollments")[0]!.n).toBe(want.n_enrolled);

    // 4. YES again: confirmed, and only now does the cycle count.
    g.receive("T1", "YES");
    await run();
    expect(g.sent[3]!.text).toContain("Confirmed");
    expect(cycle(a)).toMatchObject({ status: "confirmed", n_enrolled: want.n_enrolled, n_completed: want.n_completed });
    expect(a.q("SELECT completion_rule FROM programs")[0]!.completion_rule).toBe("attended at least 80% of sessions");
    expect(m.calls).toEqual(["map_columns", "classify_legend"]); // a plain YES never reaches the model
  });

  it("follows the answer on late: not counted gives the other completions", async () => {
    const { a, g, env, csv } = await world();
    const m = scripted({ map_columns: mapping, classify_legend: [legend({ late_counts_as_attended: false })] });
    g.receive("T1", "Sheet attached.", [csv]);
    await syncGmail(env, g.gmail, m.llm);
    g.receive("T1", "JT is excused, L is late and late does not count.");
    await syncGmail(env, g.gmail, m.llm);
    g.receive("T1", "YES");
    await syncGmail(env, g.gmail, m.llm);
    expect(cycle(a)).toMatchObject({ n_enrolled: want.n_enrolled, n_completed: want.n_completed_if_late_not_counted });
    expect(want.n_completed_if_late_not_counted).not.toBe(want.n_completed);
  });

  it("asks about late on its own when the marks are explained but late is not", async () => {
    const { a, g, env, csv } = await world();
    const m = scripted({ map_columns: mapping, classify_legend: [legend({ late_counts_as_attended: null })] });
    g.receive("T1", "Sheet attached.", [csv]);
    await syncGmail(env, g.gmail, m.llm);
    g.receive("T1", "JT is excused and L is late.");
    await syncGmail(env, g.gmail, m.llm);
    expect(g.sent[1]!.text).toContain("Does a late count as attended for Healing Circle?");
    g.receive("T1", "No"); // a plain NO is understood without the model
    await syncGmail(env, g.gmail, m.llm);
    expect(m.calls).toEqual(["map_columns", "classify_legend"]);
    expect(JSON.parse(cycle(a).extra as string)._late_counts).toBe(false);
    // Two rounds are used (marks, then late), so the possible duplicate goes into the receipt instead of a third question.
    expect(g.sent[2]!.text).toContain("Whether two lines are the same person for Healing Circle");
  });

  it("keeps only marks it asked about and gives up after two rounds without an answer", async () => {
    const { a, g, env, csv } = await world();
    const m = scripted({
      map_columns: mapping,
      classify_legend: [legend({ marks: [{ mark: "ZZ", meaning: "present" }], late_counts_as_attended: null }), { marks: [], late_counts_as_attended: null }],
    });
    g.receive("T1", "Sheet attached.", [csv]);
    await syncGmail(env, g.gmail, m.llm);
    g.receive("T1", "ZZ means present");
    await syncGmail(env, g.gmail, m.llm);
    expect(g.sent[1]!.text).toContain("I could not tell how it answers my question");
    g.receive("T1", "not sure, sorry");
    await syncGmail(env, g.gmail, m.llm);
    expect(g.sent[2]!.text).toContain("passed it to TPW staff");
    expect(a.q("SELECT status FROM submissions")[0]!.status).toBe("needs_staff");
    expect(a.q("SELECT count(*) AS n FROM program_cycles WHERE status = 'confirmed'")[0]!.n).toBe(0);
    expect(JSON.parse(cycle(a).extra as string)._legend).toBeUndefined();
  });

  it("keeps two lines as two people when told they are different", async () => {
    const { a, g, env, csv } = await world();
    const m = scripted({ map_columns: mapping, classify_legend: [legend()] });
    g.receive("T1", "Sheet attached.", [csv]);
    await syncGmail(env, g.gmail, m.llm);
    g.receive("T1", "JT excused, L late, late counts.");
    await syncGmail(env, g.gmail, m.llm);
    g.receive("T1", "NO");
    await syncGmail(env, g.gmail, m.llm);
    expect(cycle(a).n_enrolled).toBe(want.n_enrolled + 1);
    expect(g.sent[2]!.text).toContain(`${want.n_enrolled + 1} enrolled`);
  });

  it("names an unnamed program from a correction to the receipt", async () => {
    const { a, g, env, csv } = await world({ program: false });
    const m = scripted({
      map_columns: mapping,
      classify_legend: [legend()],
      classify_reply: [classify("correction", { field_key: "program_name", value: "Healing Circle" })],
    });
    g.receive("T1", "Sheet attached.", [csv]);
    await syncGmail(env, g.gmail, m.llm);
    expect(a.q("SELECT program_name FROM programs")).toEqual([{ program_name: "Unnamed program" }]);
    g.receive("T1", "JT excused, L late, late counts.");
    await syncGmail(env, g.gmail, m.llm);
    g.receive("T1", "YES");
    await syncGmail(env, g.gmail, m.llm);
    expect(g.sent[2]!.text).toContain("Program name for Unnamed program");
    g.receive("T1", "The program is called Healing Circle.");
    await syncGmail(env, g.gmail, m.llm);
    expect(a.q("SELECT program_name FROM programs")).toEqual([{ program_name: "Healing Circle" }]);
    expect(g.sent[3]!.text).toContain("Healing Circle at San Quentin");
    expect(g.sent[3]!.text).not.toContain("Program name for");
  });
});

describe.skipIf(!sqlite)("persona 3 sheet as XLSX", () => {
  it("reads the same sheet from an XLSX with a merged header and Excel dates", async () => {
    const a = makeD1("analytics");
    const v = makeD1("vault");
    a.raw.exec("INSERT INTO orgs (org_id, org_name, data_persona, primary_contact_email, is_synthetic) VALUES ('o1','Healing Org',3,'dana@real.test',1)");
    const vault = new Vault(v.db, await testKeys());
    const out = await ingest(
      a.db, new RecordedLlm({ map_columns: mapping }),
      { org_id: "o1", org_name: "Healing Org", primary_contact_email: "dana@real.test", is_synthetic: 1 },
      { kind: "table", filename: "attendance.xlsx", bytes: new Uint8Array(readFixture("org_c_persona3_attendance.xlsx")) },
      { channel: "manual", senderEmail: "dana@real.test" }, () => Promise.resolve(vault),
    );
    expect(out).toMatchObject({ status: "needs_info", cycles: 1 });
    expect(a.q("SELECT count(*) AS n FROM sessions")[0]!.n).toBe(want.sessions.total);
    expect(a.q("SELECT count(*) AS n FROM sessions WHERE cancelled = 1")[0]!.n).toBe(2);
    expect(a.q("SELECT min(session_date) AS d FROM sessions")[0]!.d).toBe("2026-01-12");
    expect(a.q("SELECT n_enrolled, facility_code FROM program_cycles")[0]).toEqual({ n_enrolled: 61, facility_code: "SQ" });
    expect(JSON.parse(a.q("SELECT extra FROM program_cycles")[0]!.extra as string)._marks_unknown).toEqual(["JT", "L"]);
  });
});
