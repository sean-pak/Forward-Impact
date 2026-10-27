import { redirect } from "next/navigation";
import { workerFetch } from "../../../lib/worker";
import { Badge, ErrorNote, Note, PageHead, Section, When } from "../../components/ui";

export const dynamic = "force-dynamic";

type Message = {
  message_id: string;
  direction: "inbound" | "outbound";
  kind: string;
  org_id: string | null;
  from_email: string | null;
  to_email: string | null;
  subject: string | null;
  occurred_at: string;
};

async function describe(res: Response, ok: string): Promise<string> {
  if (res.ok) return ok;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return `Failed (${res.status}): ${body.error ?? "unknown error"}`;
}

async function sendTest(formData: FormData) {
  "use server";
  const to = String(formData.get("to") ?? "").trim();
  const res = await workerFetch("/api/gmail/test", { method: "POST", body: JSON.stringify({ to }) });
  redirect(`/admin/email?note=${encodeURIComponent(await describe(res, `Test email sent to ${to}.`))}`);
}

async function syncNow() {
  "use server";
  const res = await workerFetch("/api/gmail/sync", { method: "POST" });
  let note = await describe(res, "");
  if (res.ok) {
    const r = (await res.json()) as { logged: number; ignored: number; skipped: number };
    note = `Synced: ${r.logged} logged, ${r.ignored} ignored, ${r.skipped} skipped (own mail).`;
  }
  redirect(`/admin/email?note=${encodeURIComponent(note)}`);
}

export default async function EmailPage({ searchParams }: { searchParams: Promise<{ note?: string }> }) {
  const { note } = await searchParams;
  let messages: Message[] = [];
  let error: string | null = null;
  try {
    const res = await workerFetch("/api/gmail/messages");
    if (!res.ok) throw new Error(`Worker returned ${res.status}`);
    messages = ((await res.json()) as { messages: Message[] }).messages;
  } catch (e) {
    error = e instanceof Error ? e.message : "unknown error";
  }
  return (
    <main>
      <PageHead
        eyebrow="Outreach"
        title="Email"
        actions={
          <form action={syncNow}>
            <button type="submit" className="btn-primary">Sync now</button>
          </form>
        }
      />
      <Note note={note} />
      <div className="panel">
        <div className="split" style={{ alignItems: "end" }}>
          <form action={sendTest} className="inline-form">
            <label className="field" style={{ flex: 1, minWidth: 220 }}>
              <span>Send test email to</span>
              <input type="email" name="to" required />
            </label>
            <button type="submit" style={{ alignSelf: "end" }}>Send test email</button>
          </form>
          <p className="hint" style={{ margin: 0 }}>The Worker also syncs every minute.</p>
        </div>
      </div>

      <Section title="Messages" aside="Only mail from known contacts or known threads is logged, as metadata. Everything else is labeled sam/ignored in Gmail and not stored.">
        {error ? <ErrorNote>Could not load messages: {error}</ErrorNote> : null}
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>When (UTC)</th><th>Direction</th><th>Kind</th><th>From</th><th>To</th><th>Subject</th></tr>
            </thead>
            <tbody>
              {messages.map((m) => (
                <tr key={m.message_id}>
                  <td><When t={m.occurred_at} /></td>
                  <td><Badge tone={m.direction === "inbound" ? "good" : "plain"}>{m.direction}</Badge></td>
                  <td className="dim">{m.kind}</td>
                  <td>{m.from_email ?? ""}</td>
                  <td>{m.to_email ?? ""}</td>
                  <td>{m.subject ?? ""}</td>
                </tr>
              ))}
              {messages.length === 0 && !error ? <tr><td className="empty" colSpan={6}>No mail logged yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </Section>
    </main>
  );
}
