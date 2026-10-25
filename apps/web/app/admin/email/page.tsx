import { redirect } from "next/navigation";
import { workerFetch } from "../../../lib/worker";

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
  const cell = { border: "1px solid #ddd", padding: "0.35rem 0.6rem", textAlign: "left" as const };
  return (
    <main>
      <h1>Email</h1>
      <p><a href="/admin">Dashboard</a></p>
      {note ? <p role="status">{note}</p> : null}
      <form action={sendTest}>
        <label>
          Send test email to <input type="email" name="to" required />
        </label>{" "}
        <button type="submit">Send test email</button>
      </form>
      <form action={syncNow} style={{ marginTop: "1rem" }}>
        <button type="submit">Sync now</button>{" "}
        <span style={{ color: "#555" }}>The Worker also syncs every minute.</span>
      </form>
      <h2>Messages</h2>
      <p style={{ color: "#555" }}>
        Only mail from known contacts or known threads is logged, as metadata. Everything else is labeled sam/ignored in Gmail and not stored.
      </p>
      {error ? <p role="alert">Could not load messages: {error}</p> : null}
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {["When (UTC)", "Direction", "Kind", "From", "To", "Subject"].map((h) => (
              <th key={h} style={cell}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {messages.map((m) => (
            <tr key={m.message_id}>
              <td style={cell}>{m.occurred_at.replace("T", " ").slice(0, 19)}</td>
              <td style={cell}>{m.direction}</td>
              <td style={cell}>{m.kind}</td>
              <td style={cell}>{m.from_email ?? ""}</td>
              <td style={cell}>{m.to_email ?? ""}</td>
              <td style={cell}>{m.subject ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
