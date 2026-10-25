import type { Gmail } from "../gmail/client";
import type { Llm, LlmRequest } from "../llm";

export type Sent = { to: string; subject: string; text: string; threadId?: string; inReplyTo?: string; references?: string };
export type Attachment = { filename: string; type: string; bytes: Uint8Array };

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64").replace(/(.{76})/g, "$1\r\n");

/** A fake mailbox: `receive` queues a message from the CBO, `sent` collects what Sam sends. */
export function makeGmail(from = "dana@real.test") {
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
      sent.push(i);
      return { id: `out${++n}`, threadId: i.threadId ?? "tnew" };
    },
  } as unknown as Gmail;
  let seq = 0;
  const last = new Map<string, string>();
  const receive = (threadId: string, text: string, attachments: Attachment[] = [], subject = "Attendance for Healing Circle") => {
    const id = `m${++seq}`;
    const refs = last.has(threadId) ? `References: <${last.get(threadId)}@real.test>\r\n` : "";
    last.set(threadId, id);
    const head = `From: Dana <${from}>\r\nTo: hello@example.org\r\nSubject: ${subject}\r\nMessage-ID: <${id}@real.test>\r\n${refs}Date: ${new Date().toUTCString()}\r\n`;
    const raw = attachments.length
      ? `${head}MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="BND"\r\n\r\n--BND\r\nContent-Type: text/plain\r\n\r\n${text}\r\n` +
        attachments.map((a) => `--BND\r\nContent-Type: ${a.type}; name="${a.filename}"\r\nContent-Disposition: attachment; filename="${a.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(a.bytes)}\r\n`).join("") +
        "--BND--\r\n"
      : `${head}Content-Type: text/plain\r\n\r\n${text}`;
    inbox.push({ id, threadId, raw });
    return id;
  };
  return { gmail, sent, receive, inbox };
}

/** Plays back scripted model answers by call name, validating each against the real schema. Keeps every prompt it was shown. */
export function scripted(script: Record<string, unknown[]>) {
  const calls: string[] = [];
  const prompts: string[] = [];
  const llm: Llm = {
    async json<T>(req: LlmRequest<T>) {
      calls.push(req.name);
      prompts.push(req.system + "\n" + req.user);
      const list = script[req.name];
      // A recorded answer that is a single object (not a list) is reused for every call.
      const next = Array.isArray(list) ? list.shift() : list;
      if (next === undefined) throw new Error(`no scripted answer for ${req.name}`);
      return req.schema.parse(next);
    },
  };
  return { llm, calls, prompts };
}

export const classify = (intent: string, over: Record<string, unknown> = {}) => ({ intent, field_key: null, value: null, approx: false, cycle_hint: null, also: [], expected_numbers: false, ...over });
