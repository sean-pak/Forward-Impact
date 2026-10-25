import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";
import { Gmail, buildRaw } from "../gmail";
import { base64UrlToBytes } from "../gmail/client";
import { importContacts } from "./contacts";
import { sendAsks } from "./send";
import { PIXEL_GIF, markReplied, recordOpen } from "./track";

type Call = { sql: string; params: unknown[] };

/** Records every statement (including batched ones); `answer` serves SELECTs. */
function fakeD1(answer: (sql: string, params: unknown[]) => unknown = () => null) {
  const calls: Call[] = [];
  const bound = (sql: string, params: unknown[]) => ({
    sql, params,
    run: async () => (calls.push({ sql, params }), { meta: { changes: 1 } }),
    first: async () => answer(sql, params),
    all: async () => ({ results: (answer(sql, params) as unknown[]) ?? [] }),
  });
  const stmt = (sql: string) => ({ ...bound(sql, []), bind: (...params: unknown[]) => bound(sql, params) });
  const db = {
    prepare: stmt,
    batch: async (list: { sql: string; params: unknown[] }[]) => {
      for (const s of list) calls.push({ sql: s.sql, params: s.params });
      return [];
    },
  } as unknown as D1Database;
  return { db, calls };
}

function fakeGmail() {
  const sent: { to: string; subject: string; text: string; html?: string }[] = [];
  const gmail = {
    mailbox: "hello@example.org",
    send: async (m: { to: string; subject: string; text: string; html?: string }) => (sent.push(m), { id: `g${sent.length}`, threadId: `t${sent.length}` }),
  } as unknown as Gmail;
  return { gmail, sent };
}

const env = (db: D1Database) => ({
  DB: db, WORKER_PUBLIC_URL: "https://w.test/", WEB_URL: "https://web.test",
  GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", GOOGLE_REFRESH_TOKEN: "", MAILBOX_ADDRESS: "hello@example.org",
});

const orgRows = [
  { org_id: "o_real", org_name: "Real Org", form_token: "tok1", contact_id: "c1", name: "Dana Reyes", email: "dana@real.test" },
  { org_id: "o_syn", org_name: "Syn Org", form_token: "tok2", contact_id: "c2", name: "Pat", email: "pat@example.org" },
  { org_id: "o_asked", org_name: "Asked Org", form_token: "tok3", contact_id: "c3", name: "Lee", email: "lee@real.test" },
  { org_id: "o_nocontact", org_name: "No Contact", form_token: "tok4", contact_id: null, name: null, email: null },
];

describe("sendAsks", () => {
  const answer = (sql: string, p: unknown[]) => {
    if (sql.includes("FROM orgs o LEFT JOIN contacts")) return orgRows;
    if (sql.includes("FROM outreach WHERE org_id")) return p[0] === "o_asked" ? { x: 1 } : null;
    return null;
  };

  it("sends one individual email to the primary contact and records message + outreach", async () => {
    const { db, calls } = fakeD1(answer);
    const { gmail, sent } = fakeGmail();
    const r = await sendAsks(env(db), null, gmail);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("dana@real.test");
    expect(sent[0]!.text).toContain("https://web.test/submit/tok1");
    const outreachId = calls.find((c) => c.sql.includes("INSERT INTO outreach"))!.params[0] as string;
    expect(sent[0]!.html).toContain(`https://w.test/p/${outreachId}.gif`);
    expect(r.sent).toEqual([{ org_id: "o_real", to: "dana@real.test" }]);
    expect(Object.fromEntries(r.skipped.map((s) => [s.org_id, s.reason]))).toMatchObject({
      o_syn: expect.stringContaining("synthetic"),
      o_asked: "already asked",
      o_nocontact: "no primary contact",
    });
    const msg = calls.find((c) => c.sql.includes("INSERT OR IGNORE INTO messages"))!;
    expect(msg.params.slice(0, 3)).toEqual(["g1", "t1", "o_real"]);
    expect(msg.sql).toContain("'ask'");
  });

  it("only sends to the selected orgs and reports unknown ones", async () => {
    const { db } = fakeD1(answer);
    const { gmail, sent } = fakeGmail();
    const r = await sendAsks(env(db), ["o_syn", "nope"], gmail);
    expect(sent).toHaveLength(0);
    expect(r.skipped.map((s) => s.reason)).toEqual([expect.stringContaining("synthetic"), "unknown org"]);
  });

  it("writes nothing when Gmail fails, so the org can be retried", async () => {
    const { db, calls } = fakeD1(answer);
    const gmail = { mailbox: "hello@example.org", send: async () => { throw new Error("Gmail send failed (500)"); } } as unknown as Gmail;
    const r = await sendAsks(env(db), ["o_real"], gmail);
    expect(r.sent).toEqual([]);
    expect(r.skipped[0]!.reason).toContain("Gmail send failed");
    expect(calls.some((c) => c.sql.includes("INSERT"))).toBe(false);
  });

  it("builds a message postal-mime can read, with the html pixel", async () => {
    const raw = buildRaw("hello@example.org", { to: "a@b.test", subject: "s", text: "t", html: '<img src="https://w/p/x.gif">' });
    const p = await PostalMime.parse(base64UrlToBytes(raw));
    expect(p.html).toContain("/p/x.gif");
  });
});

describe("tracking", () => {
  it("serves a GIF", () => {
    expect(String.fromCharCode(...PIXEL_GIF.slice(0, 3))).toBe("GIF");
  });
  it("records an open only for a well-formed outreach id", async () => {
    const { db, calls } = fakeD1();
    await recordOpen(db, "garbage'; DROP TABLE outreach;--");
    expect(calls).toHaveLength(0);
    await recordOpen(db, `out_${crypto.randomUUID()}`);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("COALESCE(opened_at");
  });
  it("marks replied by thread or by contact, only once", async () => {
    const { db, calls } = fakeD1();
    await markReplied(db, { threadId: "t1", from: "Dana@Real.test", at: "2026-10-26T10:00:00.000Z" });
    expect(calls[0]!.sql).toContain("replied_at IS NULL");
    expect(calls[0]!.params).toEqual(["2026-10-26T10:00:00.000Z", "2026-10-26T10:00:00.000Z", "t1", "dana@real.test"]);
  });
});

describe("importContacts", () => {
  const csv = [
    "org,name,email,title",
    "Alpha,A One,a1@real.test,ED",
    "Alpha,A Two,a2@real.test,PC",
    "Beta,B One,b1@real.test,",
    "Beta,Bad,not-an-email,",
    "Gamma,Taken,taken@real.test,",
  ].join("\n");

  it("creates orgs, makes the first contact primary, rejects bad rows and cross-org emails", async () => {
    const { db, calls } = fakeD1((sql, p) => {
      if (sql.includes("FROM contacts c JOIN orgs")) return p[0] === "taken@real.test" ? { org_name: "Other Org" } : null;
      return null; // no existing org, no existing contacts
    });
    const r = await importContacts(db, csv);
    expect(r).toMatchObject({ orgsCreated: 3, orgsMatched: 0, contactsAdded: 3, contactsUpdated: 0 });
    expect(r.rejected.map((x) => x.reason)).toEqual([expect.stringContaining("not a valid email"), "taken@real.test already belongs to Other Org"]);
    const contacts = calls.filter((c) => c.sql.includes("INSERT INTO contacts")).map((c) => [c.params[3], c.params[5], c.params[6]]);
    expect(contacts).toEqual([["a1@real.test", 1, 1], ["a2@real.test", 0, 2], ["b1@real.test", 1, 1]]);
    const orgs = calls.filter((c) => c.sql.includes("INSERT INTO orgs"));
    expect(orgs.map((o) => o.params[1])).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(orgs[0]!.params[2]).toBe("a1@real.test");
    expect(orgs[0]!.params[3]).not.toBe(orgs[0]!.params[4]); // distinct private and form tokens
    expect(orgs[0]!.params[5]).toBe(0); // real address -> not synthetic
  });
});
