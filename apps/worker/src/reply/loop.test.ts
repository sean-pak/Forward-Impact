import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Gmail } from "../gmail/client";
import { syncGmail } from "../gmail/sync";
import type { Llm, LlmRequest } from "../llm";

// The whole loop runs against a real SQLite database built from the real migrations. node:sqlite needs Node 22.13+.
const sqlite = await import("node:sqlite").catch(() => null);
const ROOT = join(__dirname, "../../../..");
const FX = join(ROOT, "fixtures/ingest");
const extract = JSON.parse(readFileSync(join(FX, "org_b_persona2_email.llm.json"), "utf8")).extract_cycles;
const PERSONA2 = readFileSync(join(FX, "org_b_persona2_email.txt"), "utf8");

class Stmt {
  constructor(private db: import("node:sqlite").DatabaseSync, readonly sql: string, readonly params: unknown[] = []) {}
  bind(...p: unknown[]) { return new Stmt(this.db, this.sql, p); }
  async first<T>() { return (this.db.prepare(this.sql).get(...(this.params as never[])) ?? null) as T | null; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...(this.params as never[])) as T[] }; }
  async run() { const r = this.db.prepare(this.sql).run(...(this.params as never[])); return { meta: { changes: Number(r.changes) } }; }
}

function makeDb() {
  const raw = new sqlite!.DatabaseSync(":memory:");
  for (const f of ["0001_init.sql", "0002_open_question.sql"]) raw.exec(readFileSync(join(ROOT, "apps/worker/migrations/analytics", f), "utf8"));
  raw.exec(`INSERT INTO orgs (org_id, org_name, data_persona, primary_contact_email, form_token, is_synthetic) VALUES ('o1','Dana Arts',2,'dana@real.test','ftok',0);
            INSERT INTO contacts (contact_id, org_id, name, email, is_primary, is_synthetic) VALUES ('k1','o1','Dana','dana@real.test',1,0);`);
  const db = {
    prepare: (sql: string) => new Stmt(raw, sql),
    batch: async (list: Stmt[]) => {
      raw.exec("BEGIN");
      try { for (const s of list) await s.run(); raw.exec("COMMIT"); } catch (e) { raw.exec("ROLLBACK"); throw e; }
      return [];
    },
  } as unknown as D1Database;
  const q = (sql: string, ...p: unknown[]) => raw.prepare(sql).all(...(p as never[])) as Record<string, unknown>[];
  return { db, q };
}

type Sent = { to: string; subject: string; text: string; threadId?: string; inReplyTo?: string; references?: string };

function makeGmail(opts: { failSends?: () => boolean } = {}) {
  const inbox: { id: string; threadId: string; raw: string }[] = [];
  const sent: Sent[] = [];
  let n = 0;
  const gmail = {
    mailbox: "hello@example.org",
    listUnprocessed: async () => inbox.map(({ id, threadId }) => ({ id, threadId })),
    getRaw: async (id: string) => {
      const m = inbox.find((x) => x.id === id)!;
      return { id, threadId: m.threadId, raw: new TextEncoder().encode(m.raw) };
    },
    label: async (id: string) => void inbox.splice(inbox.findIndex((x) => x.id === id), 1),
    send: async (i: Sent) => {
      if (opts.failSends?.()) throw new Error("Gmail send failed (500)");
      sent.push(i);
      return { id: `out${++n}`, threadId: i.threadId ?? "tnew" };
    },
  } as unknown as Gmail;
  let seq = 0;
  const last = new Map<string, string>();
  const receive = (threadId: string, text: string, subject = "Program data for Dana Arts") => {
    const id = `m${++seq}`;
    // Mail clients quote the thread so far in References; the reply must carry it on.
    const refs = last.has(threadId) ? `References: <${last.get(threadId)}@real.test>\r\n` : "";
    last.set(threadId, id);
    inbox.push({
      id, threadId,
      raw: `From: Dana <dana@real.test>\r\nTo: hello@example.org\r\nSubject: ${subject}\r\nMessage-ID: <${id}@real.test>\r\n${refs}Date: ${new Date().toUTCString()}\r\nContent-Type: text/plain\r\n\r\n${text}`,
    });
    return id;
  };
  return { gmail, sent, receive, inbox };
}

/** Plays back scripted model answers by call name, validating each against the real schema. */
function scripted(script: Record<string, unknown[]>) {
  const calls: string[] = [];
  const llm: Llm = {
    async json<T>(req: LlmRequest<T>) {
      calls.push(req.name);
      const next = script[req.name]?.shift();
      if (next === undefined) throw new Error(`no scripted answer for ${req.name}`);
      return req.schema.parse(next);
    },
  };
  return { llm, calls };
}

const env = { GOOGLE_CLIENT_ID: "i", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r", MAILBOX_ADDRESS: "hello@example.org" };
const classify = (intent: string, over: Record<string, unknown> = {}) => ({ intent, field_key: null, value: null, approx: false, cycle_hint: null, also: [], expected_numbers: false, ...over });

describe.skipIf(!sqlite)("clarify, answer, confirm loop (real SQLite)", () => {
  it("persona 2 text -> one question per email -> receipt -> YES -> confirmed", async () => {
    const { db, q } = makeDb();
    const g = makeGmail();
    const m = scripted({
      extract_cycles: [extract],
      classify_reply: [
        classify("answer", { field_key: "n_enrolled", value: "31" }),
        classify("answer", { field_key: "completion_rule", value: "attended at least 80% of sessions" }),
      ],
    });
    const run = () => syncGmail({ ...env, DB: db }, g.gmail, m.llm);

    // 1. Data arrives. Nothing counts yet. Exactly one question goes back, in the same thread.
    g.receive("T1", PERSONA2);
    expect(await run()).toMatchObject({ ingested: 1 });
    expect(g.sent).toHaveLength(1);
    expect(g.sent[0]).toMatchObject({ to: "dana@real.test", subject: "Re: Program data for Dana Arts", threadId: "T1", inReplyTo: "<m1@real.test>" });
    expect(g.sent[0]!.text).toContain('You gave "about 30" for people enrolled');
    expect(g.sent[0]!.text.trim().endsWith("Sam, TPW's data assistant")).toBe(true);
    expect(q("SELECT status, followup_rounds FROM submissions")).toEqual([{ status: "awaiting_confirmation", followup_rounds: 1 }]);
    expect(q("SELECT count(*) AS n FROM program_cycles WHERE status = 'confirmed'")[0]!.n).toBe(0);

    // 2. The exact number replaces "about 30"; the next question is the completion rule.
    g.receive("T1", "It was exactly 31.");
    await run();
    expect(g.sent).toHaveLength(2);
    expect(g.sent[1]!.text).toContain("What counts as completing Writing Class?");
    expect(g.sent[1]!.references).toBe("<m1@real.test> <m2@real.test>");
    expect(q("SELECT n_enrolled, n_enrolled_approx FROM program_cycles WHERE facility_code = 'CMC'")).toEqual([{ n_enrolled: 31, n_enrolled_approx: 0 }]);

    // 3. Two rounds are used. The receipt lists what was kept and what is still unknown, and asks for YES.
    g.receive("T1", "We count someone as completed if they attended at least 80% of sessions.");
    await run();
    expect(g.sent).toHaveLength(3);
    const receipt = g.sent[2]!.text;
    expect(receipt).toContain("31 enrolled, 22 completed; completion means: attended at least 80% of sessions");
    expect(receipt).toContain("People completed for Writing Class at San Quentin Rehabilitation Center, started 2025-09-08");
    expect(receipt).toContain("nothing needed scrambling");
    expect(receipt).toContain("Reply YES to confirm");
    expect(q("SELECT count(*) AS n FROM program_cycles WHERE status = 'confirmed'")[0]!.n).toBe(0);

    // 4. YES confirms without calling the model. Only now does the data count.
    const before = m.calls.length;
    g.receive("T1", "Yes");
    await run();
    expect(m.calls.length).toBe(before);
    expect(g.sent).toHaveLength(4);
    expect(g.sent[3]!.text).toContain("Confirmed. Thank you.");
    expect(q("SELECT status, n_enrolled FROM program_cycles ORDER BY start_date")).toEqual([
      { status: "confirmed", n_enrolled: 31 }, { status: "confirmed", n_enrolled: 28 },
    ]);
    expect(q("SELECT status, open_question FROM submissions")).toEqual([{ status: "confirmed", open_question: null }]);
    expect(q("SELECT completion_rule FROM programs")).toEqual([{ completion_rule: "attended at least 80% of sessions" }]);
    expect(q("SELECT kind FROM messages WHERE direction = 'outbound' ORDER BY rowid").map((r) => r.kind)).toEqual(["clarify", "clarify", "confirm_receipt", "thanks"]);
  });

  it("keeps 'about 30' when the CBO says that is the best they have, and never asks it twice", async () => {
    const { db, q } = makeDb();
    const g = makeGmail();
    const m = scripted({ extract_cycles: [extract], classify_reply: [classify("answer", { field_key: "n_enrolled", value: null, approx: true })] });
    g.receive("T1", PERSONA2);
    await syncGmail({ ...env, DB: db }, g.gmail, m.llm);
    g.receive("T1", "about 30 is fine");
    await syncGmail({ ...env, DB: db }, g.gmail, m.llm);
    expect(q("SELECT n_enrolled, n_enrolled_approx FROM program_cycles WHERE facility_code = 'CMC'")).toEqual([{ n_enrolled: 30, n_enrolled_approx: 1 }]);
    expect(g.sent[1]!.text).toContain("What counts as completing");
    expect(g.sent[1]!.text).not.toContain("about 30");
  });

  it("a number the reply does not contain is dropped and the question is asked again", async () => {
    const { db, q } = makeDb();
    const g = makeGmail();
    const m = scripted({ extract_cycles: [extract], classify_reply: [classify("answer", { field_key: "n_enrolled", value: "45" })] });
    g.receive("T1", PERSONA2);
    await syncGmail({ ...env, DB: db }, g.gmail, m.llm);
    g.receive("T1", "Not sure, I'd have to check the roster.");
    await syncGmail({ ...env, DB: db }, g.gmail, m.llm);
    expect(q("SELECT n_enrolled FROM program_cycles WHERE facility_code = 'CMC'")).toEqual([{ n_enrolled: 30 }]);
  });

  it("a correction after the receipt updates only the cycle it names and re-sends the receipt", async () => {
    const { db, q } = makeDb();
    const g = makeGmail();
    const m = scripted({
      extract_cycles: [extract],
      classify_reply: [
        classify("answer", { field_key: "n_enrolled", value: "31" }),
        classify("answer", { field_key: "completion_rule", value: "attended 80% of sessions" }),
        classify("correction", { field_key: "n_enrolled", value: "29", cycle_hint: "San Quentin" }),
      ],
    });
    const run = () => syncGmail({ ...env, DB: db }, g.gmail, m.llm);
    g.receive("T1", PERSONA2); await run();
    g.receive("T1", "exactly 31"); await run();
    g.receive("T1", "attended 80% of sessions"); await run();
    g.receive("T1", "Actually San Quentin had 29 enrolled, not 28."); await run();
    expect(g.sent).toHaveLength(4);
    expect(g.sent[3]!.text).toContain("Thanks, I updated it.");
    expect(g.sent[3]!.text).toContain("started 2025-09-08: 29 enrolled");
    expect(q("SELECT n_enrolled FROM program_cycles ORDER BY start_date").map((r) => r.n_enrolled)).toEqual([31, 29]);
    expect(q("SELECT status FROM submissions")).toEqual([{ status: "awaiting_confirmation" }]);
  });

  it("two replies that do not answer a blocking question end with staff and an escalation email", async () => {
    const { db, q } = makeDb();
    const g = makeGmail();
    const noDate = { ...extract, cycles: [{ ...extract.cycles[0], start_date: null }] };
    const m = scripted({ extract_cycles: [noDate], classify_reply: [classify("unclear"), classify("unclear")] });
    const run = () => syncGmail({ ...env, DB: db }, g.gmail, m.llm);
    g.receive("T1", PERSONA2); await run();
    expect(g.sent[0]!.text).toContain("What date did Writing Class start?");
    expect(q("SELECT status FROM submissions")).toEqual([{ status: "needs_info" }]);
    g.receive("T1", "Which one do you mean?"); await run();
    expect(g.sent[1]!.text).toContain("ask it once more");
    g.receive("T1", "No idea"); await run();
    expect(g.sent).toHaveLength(3);
    expect(g.sent[2]!.text).toContain("passed it to TPW staff");
    expect(q("SELECT status, followup_rounds, open_question FROM submissions")).toEqual([{ status: "needs_staff", followup_rounds: 2, open_question: null }]);
    expect(q("SELECT count(*) AS n FROM program_cycles WHERE status = 'confirmed'")[0]!.n).toBe(0);
  });

  it("a failed send changes nothing, and the next sync handles the same reply once", async () => {
    const { db, q } = makeDb();
    let failing = false;
    const g = makeGmail({ failSends: () => failing });
    const m = scripted({ extract_cycles: [extract], classify_reply: [classify("answer", { field_key: "n_enrolled", value: "31" }), classify("answer", { field_key: "n_enrolled", value: "31" })] });
    const run = () => syncGmail({ ...env, DB: db }, g.gmail, m.llm);
    g.receive("T1", PERSONA2); await run();
    g.receive("T1", "exactly 31");
    failing = true; await run();
    expect(g.inbox).toHaveLength(1); // still unlabeled, so it is retried
    expect(q("SELECT n_enrolled FROM program_cycles WHERE facility_code = 'CMC'")).toEqual([{ n_enrolled: 30 }]);
    expect(q("SELECT followup_rounds FROM submissions")).toEqual([{ followup_rounds: 1 }]);
    failing = false; await run();
    expect(g.inbox).toHaveLength(0);
    expect(g.sent).toHaveLength(2);
    expect(q("SELECT followup_rounds FROM submissions")).toEqual([{ followup_rounds: 2 }]);
  });

  it("the first email's failed send is retried without ingesting twice", async () => {
    const { db, q } = makeDb();
    let failing = true;
    const g = makeGmail({ failSends: () => failing });
    const m = scripted({ extract_cycles: [extract] });
    g.receive("T1", PERSONA2);
    await syncGmail({ ...env, DB: db }, g.gmail, m.llm);
    expect(g.inbox).toHaveLength(1);
    failing = false;
    await syncGmail({ ...env, DB: db }, g.gmail, m.llm);
    expect(g.sent).toHaveLength(1);
    expect(m.calls).toEqual(["extract_cycles"]);
    expect(q("SELECT count(*) AS n FROM submissions")[0]!.n).toBe(1);
  });
  it("one class in spring and fall: one program, and the missing prison is a yes/no", async () => {
    const { db, q } = makeDb();
    const g = makeGmail();
    const cyc = (over: Record<string, unknown>) => ({ ...extract.cycles[0], completion_rule_stated: null, ...over });
    const m = scripted({
      extract_cycles: [{ persona: 2, cycles: [
        cyc({ program_name: "spring meditation class", facility_raw: "San Quentin", start_date: "2025-02-03", n_enrolled: 30, n_enrolled_approx: true, n_completed: 22 }),
        cyc({ program_name: "fall group", facility_raw: null, start_date: "2025-09-08", n_enrolled: 28, n_enrolled_approx: false, n_completed: null }),
      ] }],
    });
    const run = () => syncGmail({ ...env, DB: db }, g.gmail, m.llm);
    g.receive("T1", "The spring meditation class started February 3, 2025 at San Quentin. We had about 30 guys in it and 22 finished. Our fall group started September 8, 2025 with 28 people. We haven't counted how many finished the fall group yet.");
    await run();
    expect(q("SELECT program_name FROM programs")).toEqual([{ program_name: "Meditation class" }]);
    expect(g.sent[0]!.text).toContain("Did Meditation class (started 2025-09-08) also run at San Quentin Rehabilitation Center? Reply YES");
    expect(q("SELECT facility_code FROM program_cycles WHERE start_date = '2025-09-08'")).toEqual([{ facility_code: null }]);

    // "Yes" sets the offered prison without a model call.
    g.receive("T1", "Yes");
    await run();
    expect(m.calls).toEqual(["extract_cycles"]);
    expect(q("SELECT facility_code FROM program_cycles WHERE start_date = '2025-09-08'")).toEqual([{ facility_code: "SQ" }]);
    expect(g.sent[1]!.text).not.toContain("Which prison");
  });

  it("a reply to the receipt that fills in the rule without naming the class updates it, leaves out an expected count, then YES closes", async () => {
    const { db, q } = makeDb();
    const g = makeGmail();
    const rule = "a participant needs to attend at least 80% of all sessions";
    const m = scripted({
      extract_cycles: [extract],
      classify_reply: [
        classify("answer", { field_key: "n_enrolled", value: null, approx: true }),
        classify("unclear"),
        // What the model returned for the real thread: the rule with no class named, and a projected count.
        classify("correction", { field_key: "completion_rule", value: rule, expected_numbers: true }),
      ],
    });
    const run = () => syncGmail({ ...env, DB: db }, g.gmail, m.llm);
    g.receive("T1", PERSONA2); await run();
    g.receive("T1", "about 30 is fine"); await run();
    g.receive("T1", "Not sure"); await run();
    expect(g.sent[2]!.text).toContain("What counts as completing Writing Class\n");

    g.receive("T1", `What counts as completed is ${rule}. we are expecting 25/28 to complete the writing class that started in the fall`);
    await run();
    const receipt = g.sent[3]!.text;
    expect(receipt).toContain("Thanks, I updated it.");
    expect(receipt).toContain(`22 completed; completion means: ${rule}`);
    expect(receipt).toContain(`completed not provided; completion means: ${rule}`);
    expect(receipt).not.toContain("What counts as completing");
    expect(receipt).toContain("I left out the expected numbers");
    expect(q("SELECT n_completed FROM program_cycles ORDER BY start_date").map((r) => r.n_completed)).toEqual([22, null]);

    g.receive("T1", "Yes"); await run();
    expect(g.sent[4]!.text).toContain("Confirmed. Thank you.");
    expect(q("SELECT status FROM submissions")).toEqual([{ status: "confirmed" }]);
    expect(q("SELECT completion_rule FROM programs")).toEqual([{ completion_rule: rule }]);
  });

  it("two facts in one reply both apply, and a fact for the one cycle missing it needs no class name", async () => {
    const { db, q } = makeDb();
    const g = makeGmail();
    const m = scripted({
      extract_cycles: [extract],
      classify_reply: [
        classify("answer", { field_key: "n_enrolled", value: null, approx: true }),
        classify("unclear"),
        classify("correction", { field_key: "completion_rule", value: "attended 80% of sessions", also: [{ field_key: "n_completed", value: "25", approx: false, cycle_hint: null }] }),
      ],
    });
    const run = () => syncGmail({ ...env, DB: db }, g.gmail, m.llm);
    g.receive("T1", PERSONA2); await run();
    g.receive("T1", "about 30 is fine"); await run();
    g.receive("T1", "Not sure"); await run();
    g.receive("T1", "Completing means attended 80% of sessions. 25 finished the fall group."); await run();
    expect(q("SELECT n_completed FROM program_cycles ORDER BY start_date").map((r) => r.n_completed)).toEqual([22, 25]);
    expect(g.sent[3]!.text).toContain("Thanks, I updated it.");
    expect(g.sent[3]!.text).not.toContain("Not provided yet");
  });

  it("a reply to the receipt that changes nothing says so instead of repeating the receipt", async () => {
    const { db } = makeDb();
    const g = makeGmail();
    const m = scripted({
      extract_cycles: [extract],
      classify_reply: [classify("answer", { field_key: "n_enrolled", value: null, approx: true }), classify("unclear"), classify("unclear")],
    });
    const run = () => syncGmail({ ...env, DB: db }, g.gmail, m.llm);
    g.receive("T1", PERSONA2); await run();
    g.receive("T1", "about 30 is fine"); await run();
    g.receive("T1", "Not sure"); await run();
    g.receive("T1", "Can you call me?"); await run();
    expect(g.sent[3]!.text).toContain("I could not tell what to change from it");
  });
});
