import { createMimeMessage } from "mimetext/browser";
import { z } from "zod";

export type GmailEnv = {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
  MAILBOX_ADDRESS: string;
};

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const TokenSchema = z.object({ access_token: z.string(), expires_in: z.number() });
const ListSchema = z.object({
  messages: z.array(z.object({ id: z.string(), threadId: z.string() })).optional(),
});
const RawSchema = z.object({ id: z.string(), threadId: z.string(), raw: z.string() });
const LabelsSchema = z.object({ labels: z.array(z.object({ id: z.string(), name: z.string() })).optional() });
const LabelSchema = z.object({ id: z.string(), name: z.string() });
const SentSchema = z.object({ id: z.string(), threadId: z.string() });

export const LABEL_PROCESSED = "sam/processed";
export const LABEL_IGNORED = "sam/ignored";

export type SendInput = {
  to: string;
  cc?: string;
  subject: string;
  text: string;
  html?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
};

/** Gmail errors never echo message content, but keep them short anyway. */
async function fail(what: string, res: Response): Promise<never> {
  throw new Error(`Gmail ${what} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

export function base64UrlToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Builds the RFC 2822 message Gmail's `send` wants, base64url encoded. */
export function buildRaw(from: string, input: SendInput): string {
  const msg = createMimeMessage();
  msg.setSender({ addr: from, name: "Sam, TPW's data assistant" });
  msg.setRecipient(input.to);
  if (input.cc) msg.setCc(input.cc);
  msg.setSubject(input.subject);
  if (input.inReplyTo) msg.setHeader("In-Reply-To", input.inReplyTo);
  if (input.references) msg.setHeader("References", input.references);
  msg.addMessage({ contentType: "text/plain", data: input.text });
  if (input.html) msg.addMessage({ contentType: "text/html", data: input.html });
  return bytesToBase64Url(new TextEncoder().encode(msg.asRaw()));
}

export class Gmail {
  private token: { value: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;
  private labelIds = new Map<string, string>();

  constructor(
    private env: GmailEnv,
    private doFetch: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  get mailbox(): string {
    return this.env.MAILBOX_ADDRESS.toLowerCase();
  }

  /** Access token cached in memory until a minute before it expires. */
  private accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return Promise.resolve(this.token.value);
    // Concurrent callers share one refresh.
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const res = await this.doFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.env.GOOGLE_CLIENT_ID,
        client_secret: this.env.GOOGLE_CLIENT_SECRET,
        refresh_token: this.env.GOOGLE_REFRESH_TOKEN,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) await fail("token refresh", res);
    const t = TokenSchema.parse(await res.json());
    this.token = { value: t.access_token, expiresAt: this.now() + (t.expires_in - 60) * 1000 };
    return t.access_token;
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" };
    return this.doFetch(`${API}${path}`, { ...init, headers });
  }

  /** Finds a label by name, creating it if missing. */
  async ensureLabel(name: string): Promise<string> {
    const cached = this.labelIds.get(name);
    if (cached) return cached;
    const list = await this.call("/labels");
    if (!list.ok) await fail("list labels", list);
    const found = LabelsSchema.parse(await list.json()).labels?.find((l) => l.name === name);
    if (found) {
      this.labelIds.set(name, found.id);
      return found.id;
    }
    const made = await this.call("/labels", {
      method: "POST",
      body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
    });
    if (!made.ok) await fail("create label", made);
    const id = LabelSchema.parse(await made.json()).id;
    this.labelIds.set(name, id);
    return id;
  }

  /** Inbox mail Sam has not looked at yet. */
  async listUnprocessed(max = 25): Promise<{ id: string; threadId: string }[]> {
    await Promise.all([this.ensureLabel(LABEL_PROCESSED), this.ensureLabel(LABEL_IGNORED)]);
    const q = `in:inbox -label:${LABEL_PROCESSED} -label:${LABEL_IGNORED}`;
    const res = await this.call(`/messages?maxResults=${max}&q=${encodeURIComponent(q)}`);
    if (!res.ok) await fail("list messages", res);
    return ListSchema.parse(await res.json()).messages ?? [];
  }

  async getRaw(id: string): Promise<{ id: string; threadId: string; raw: Uint8Array }> {
    const res = await this.call(`/messages/${encodeURIComponent(id)}?format=raw`);
    if (!res.ok) await fail("get message", res);
    const m = RawSchema.parse(await res.json());
    return { id: m.id, threadId: m.threadId, raw: base64UrlToBytes(m.raw) };
  }

  async send(input: SendInput): Promise<{ id: string; threadId: string }> {
    const body: { raw: string; threadId?: string } = { raw: buildRaw(this.env.MAILBOX_ADDRESS, input) };
    if (input.threadId) body.threadId = input.threadId;
    const res = await this.call("/messages/send", { method: "POST", body: JSON.stringify(body) });
    if (!res.ok) await fail("send", res);
    return SentSchema.parse(await res.json());
  }

  async label(id: string, add: string[], remove: string[] = []): Promise<void> {
    const addLabelIds = await Promise.all(add.map((n) => this.ensureLabel(n)));
    const res = await this.call(`/messages/${encodeURIComponent(id)}/modify`, {
      method: "POST",
      body: JSON.stringify({ addLabelIds, removeLabelIds: remove }),
    });
    if (!res.ok) await fail("label", res);
  }

  /** Takes the message out of the inbox. */
  async archive(id: string): Promise<void> {
    await this.label(id, [], ["INBOX"]);
  }
}
