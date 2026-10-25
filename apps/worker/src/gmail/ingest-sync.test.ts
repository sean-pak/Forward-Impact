import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Gmail } from "./client";
import { syncGmail } from "./sync";
import { RecordedLlm } from "../ingest/recorded";
import type { Llm } from "../llm";
import { ConfigError } from "../config";

const env = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r", MAILBOX_ADDRESS: "hello@example.org" };
const FX = join(__dirname, "../../../../fixtures/ingest");
const recorded = (f: string) => JSON.parse(readFileSync(join(FX, f), "utf8"));

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_");

function mail(opts: { date: string; text: string; csv?: string }): string {
  const head = `From: cbo@real.test\r\nTo: hello@example.org\r\nSubject: data\r\nDate: ${opts.date}\r\n`;
  if (!opts.csv) return head + `Content-Type: text/plain\r\n\r\n${opts.text}`;
  return head + `Content-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\n${opts.text}\r\n--B\r\n` +
    `Content-Type: text/csv; name="a.csv"\r\nContent-Disposition: attachment; filename="a.csv"\r\n\r\n${opts.csv}\r\n--B--\r\n`;
}

function mailWithFile(name: string, type: string, disposition = "attachment"): string {
  return `From: cbo@real.test\r\nTo: hello@example.org\r\nSubject: data\r\nDate: ${new Date().toUTCString()}\r\n` +
    `Content-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nHere you go.\r\n--B\r\n` +
    `Content-Type: ${type}; name="${name}"\r\nContent-Disposition: ${disposition}; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8=\r\n--B--\r\n`;
}

function setup(raw: string, opts: { failSend?: boolean } = {}) {
  const modify: string[] = [];
  const sends: string[] = [];
  const doFetch = (async (url: string, init?: RequestInit) => {
    const json = (o: unknown) => new Response(JSON.stringify(o));
    if (url.includes("oauth2")) return json({ access_token: "t", expires_in: 3600 });
    if (url.endsWith("/labels") && !init?.method) return json({ labels: [{ id: "L1", name: "sam/processed" }, { id: "L2", name: "sam/ignored" }] });
    if (url.includes("/messages?")) return json({ messages: [{ id: "m1", threadId: "t1" }] });
    if (url.includes("/modify")) return (modify.push(String(init?.body)), json({}));
    if (url.endsWith("/messages/send")) {
      if (opts.failSend) return new Response("nope", { status: 500 });
      return (sends.push(String(init?.body)), json({ id: "out1", threadId: "t1" }));
    }
    return json({ id: "m1", threadId: "t1", raw: b64url(raw) });
  }) as unknown as typeof fetch;
  const writes: { sql: string; params: unknown[] }[] = [];
  const mk = (sql: string, params: unknown[]) => ({
    sql, params,
    run: async () => (writes.push({ sql, params }), { meta: { changes: 1 } }),
    first: async () => {
      if (sql.includes("FROM contacts")) return { org_id: "o1" };
      if (sql.includes("FROM orgs")) return { org_id: "o1", org_name: "Org", primary_contact_email: "cbo@real.test", is_synthetic: 0 };
      if (sql.includes("SELECT submission_id FROM messages")) return null;
      return null;
    },
    all: async () => ({ results: [] }),
  });
  const db = {
    prepare: (sql: string) => ({ ...mk(sql, []), bind: (...p: unknown[]) => mk(sql, p) }),
    batch: async (l: { sql: string; params: unknown[] }[]) => (writes.push(...l.map((s) => ({ sql: s.sql, params: s.params }))), []),
  } as unknown as D1Database;
  return { gmail: new Gmail(env, doFetch), db, writes, modify, sends };
}

describe("sync routes new data into ingest", () => {
  it("a body with numbers becomes a submission (email_body) and the message is labeled processed", async () => {
    const text = readFileSync(join(FX, "org_b_persona2_email.txt"), "utf8");
    const s = setup(mail({ date: new Date().toUTCString(), text }));
    const r = await syncGmail({ ...env, DB: s.db }, s.gmail, new RecordedLlm(recorded("org_b_persona2_email.llm.json")));
    expect(r).toMatchObject({ logged: 1, ingested: 1 });
    expect(s.writes.find((w) => w.sql.includes("INSERT INTO submissions"))!.params).toContain("email_body");
    expect(s.writes.some((w) => w.sql.includes("UPDATE messages SET submission_id"))).toBe(true);
    expect(s.modify).toHaveLength(1);
  });

  it("a CSV attachment is ingested as email_attachment and the cover note is not read", async () => {
    const csv = readFileSync(join(FX, "org_a_persona1_programs.csv"), "utf8").replace(/\n/g, "\r\n");
    const llm = new RecordedLlm(recorded("org_a_persona1_programs.llm.json"));
    const s = setup(mail({ date: new Date().toUTCString(), text: "Report attached, we ran 3 programs this quarter, thanks!", csv }));
    await syncGmail({ ...env, DB: s.db }, s.gmail, llm);
    expect(s.writes.find((w) => w.sql.includes("INSERT INTO submissions"))!.params).toContain("email_attachment");
    expect(llm.prompts).toHaveLength(1);
  });

  it("a chatty reply with no numbers is logged but never sent to the model", async () => {
    const llm = new RecordedLlm({});
    const s = setup(mail({ date: new Date().toUTCString(), text: "Thanks so much for reaching out, we will get back to you soon with details." }));
    const r = await syncGmail({ ...env, DB: s.db }, s.gmail, llm);
    expect(r.ingested).toBe(0);
    expect(llm.prompts).toHaveLength(0);
  });

  const failing: Llm = { json: async () => { throw new Error("model down"); } };

  it("a model failure leaves a recent message unlabeled so the next sync retries", async () => {
    const s = setup(mail({ date: new Date().toUTCString(), text: "We had 30 people in the class that started 2025-02-03 at CMC." }));
    const r = await syncGmail({ ...env, DB: s.db }, s.gmail, failing);
    expect(r.ingested).toBe(0);
    expect(s.modify).toHaveLength(0);
  });

  it("after a few minutes of failures it sends a holding reply, hands the message to staff and labels it", async () => {
    const old = new Date(Date.now() - 10 * 60_000).toUTCString();
    const s = setup(mail({ date: old, text: "We had 30 people in the class that started 2025-02-03 at CMC." }));
    const r = await syncGmail({ ...env, DB: s.db }, s.gmail, failing);
    expect(r.ingested).toBe(1);
    expect(s.writes.some((w) => w.sql.includes("INSERT INTO submissions") && w.sql.includes("'needs_staff'"))).toBe(true);
    expect(s.writes.some((w) => w.sql.includes("UPDATE messages SET submission_id"))).toBe(true);
    expect(s.sends).toHaveLength(1);
    expect(s.modify).toHaveLength(1);
  });

  it("a configuration error goes to staff at once, without waiting out the retry window", async () => {
    const s = setup(mail({ date: new Date().toUTCString(), text: "We had 30 people in the class that started 2025-02-03 at CMC." }));
    const broken: Llm = { json: async () => { throw new ConfigError("OPENROUTER_API_KEY and LLM_MODEL must be set"); } };
    const r = await syncGmail({ ...env, DB: s.db }, s.gmail, broken);
    expect(r.ingested).toBe(1);
    expect(s.writes.some((w) => w.sql.includes("'needs_staff'"))).toBe(true);
    expect(s.sends).toHaveLength(1);
    expect(s.modify).toHaveLength(1);
  });

  it("a failed holding reply leaves nothing half-written and the message unlabeled", async () => {
    const s = setup(mail({ date: new Date(Date.now() - 10 * 60_000).toUTCString(), text: "We had 30 people in the class that started 2025-02-03 at CMC." }), { failSend: true });
    const r = await syncGmail({ ...env, DB: s.db }, s.gmail, failing);
    expect(r.ingested).toBe(0);
    expect(s.writes.some((w) => w.sql.includes("INSERT INTO submissions"))).toBe(false);
    expect(s.modify).toHaveLength(0);
  });

  it("an attachment Sam cannot read gets a reply asking for CSV or XLSX, once, and no model call", async () => {
    const llm = new RecordedLlm({});
    const s = setup(mailWithFile("attendance.pdf", "application/pdf"));
    const r = await syncGmail({ ...env, DB: s.db }, s.gmail, llm);
    expect(r.ingested).toBe(0);
    expect(llm.prompts).toHaveLength(0);
    expect(s.sends).toHaveLength(1);
    const raw = Buffer.from(JSON.parse(s.sends[0]!).raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(raw).toContain("attendance.pdf");
    expect(raw).toMatch(/CSV or Excel/);
    expect(s.writes.some((w) => w.sql.includes("INSERT INTO submissions"))).toBe(false);
    expect(s.modify).toHaveLength(1);
  });

  it("an inline signature image is not an unsupported file", async () => {
    const s = setup(mailWithFile("logo.png", "image/png", "inline"));
    await syncGmail({ ...env, DB: s.db }, s.gmail, new RecordedLlm({}));
    expect(s.sends).toHaveLength(0);
  });
});
