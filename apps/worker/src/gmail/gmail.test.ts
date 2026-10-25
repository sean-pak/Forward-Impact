import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";
import { Gmail, buildRaw, base64UrlToBytes } from "./client";
import { syncGmail } from "./sync";

const env = {
  GOOGLE_CLIENT_ID: "id",
  GOOGLE_CLIENT_SECRET: "secret",
  GOOGLE_REFRESH_TOKEN: "refresh",
  MAILBOX_ADDRESS: "hello@example.org",
};

function rawMail(from: string): string {
  const mime = `From: ${from}\r\nTo: hello@example.org\r\nSubject: hi\r\nDate: Mon, 26 Oct 2026 10:00:00 +0000\r\n\r\nbody`;
  return btoa(mime).replace(/\+/g, "-").replace(/\//g, "_");
}

/** Fake Gmail: one inbox message per entry, records label modifications and token calls. */
function fakeGmail(inbox: Record<string, { threadId: string; from: string }>) {
  const calls = { tokens: 0, modify: [] as { id: string; body: { addLabelIds: string[]; removeLabelIds: string[] } }[] };
  const doFetch = (async (url: string, init?: RequestInit) => {
    const json = (o: unknown) => new Response(JSON.stringify(o));
    if (url.includes("oauth2.googleapis.com")) {
      calls.tokens++;
      return json({ access_token: "t", expires_in: 3600 });
    }
    if (url.endsWith("/labels") && !init?.method) return json({ labels: [{ id: "L1", name: "sam/processed" }] });
    if (url.endsWith("/labels")) return json({ id: "L2", name: JSON.parse(String(init?.body)).name });
    if (url.includes("/messages?")) return json({ messages: Object.entries(inbox).map(([id, m]) => ({ id, threadId: m.threadId })) });
    if (url.includes("/modify")) {
      calls.modify.push({ id: decodeURIComponent(url.split("/messages/")[1]!.split("/")[0]!), body: JSON.parse(String(init?.body)) });
      return json({});
    }
    const id = decodeURIComponent(url.split("/messages/")[1]!.split("?")[0]!);
    const m = inbox[id]!;
    return json({ id, threadId: m.threadId, raw: rawMail(m.from) });
  }) as unknown as typeof fetch;
  return { gmail: new Gmail(env, doFetch), calls };
}

function fakeDb(contacts: string[], threads: string[]) {
  const inserted: unknown[][] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (sql.includes("FROM contacts")) return contacts.includes(args[0] as string) ? { org_id: "o1" } : null;
          return threads.includes(args[0] as string) ? { org_id: null } : null;
        },
        run: async () => {
          inserted.push(args);
          return { meta: { changes: 1 } };
        },
      }),
    }),
  } as unknown as D1Database;
  return { db, inserted };
}

describe("gmail", () => {
  it("builds a message postal-mime can read back, with reply headers", async () => {
    const raw = buildRaw("hello@example.org", {
      to: "cbo@example.org", subject: "Re: hi", text: "plain", inReplyTo: "<a@x>", references: "<a@x>",
    });
    const p = await PostalMime.parse(base64UrlToBytes(raw));
    expect(p.to?.[0]?.address).toBe("cbo@example.org");
    expect(p.text?.trim()).toBe("plain");
    expect(p.inReplyTo).toBe("<a@x>");
    expect(p.from?.name).toBe("Sam, TPW's data assistant");
  });

  it("logs known senders and known threads, ignores everyone else", async () => {
    const { gmail, calls } = fakeGmail({
      m1: { threadId: "t1", from: "Known@Example.org" },
      m2: { threadId: "t-known", from: "stranger@example.org" },
      m3: { threadId: "t3", from: "spam@example.org" },
      m4: { threadId: "t4", from: "hello@example.org" },
    });
    const { db, inserted } = fakeDb(["known@example.org"], ["t-known"]);
    const r = await syncGmail({ ...env, DB: db }, gmail);
    expect(r).toEqual({ logged: 2, ignored: 1, skipped: 1 });
    expect(inserted.map((a) => a[0])).toEqual(["m1", "m2"]);
    // m3 got sam/ignored only; no row was written for it.
    const m3 = calls.modify.find((c) => c.id === "m3")!;
    expect(m3.body.addLabelIds).toEqual(["L2"]);
    expect(calls.modify.find((c) => c.id === "m1")!.body.removeLabelIds).toEqual(["INBOX"]);
    expect(calls.modify.some((c) => c.id === "m4")).toBe(false);
  });

  it("caches the access token", async () => {
    const { gmail, calls } = fakeGmail({});
    await gmail.listUnprocessed();
    await gmail.listUnprocessed();
    expect(calls.tokens).toBe(1);
  });
});
