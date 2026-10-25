import { workerFetch } from "../../../lib/worker";

export const dynamic = "force-dynamic";

type Row = {
  outreach_id: string; org_name: string; to_email: string | null;
  sent_at: string; opened_at: string | null; open_count: number; replied_at: string | null;
};
type Stats = {
  sent: number; opened: number; replied: number;
  responseRate: { numerator: number; denominator: number } | null;
  medianHoursToReply: number | null;
};

const utc = (t: string | null) => (t ? t.replace("T", " ").slice(0, 19) : "");

function hours(row: Row): string {
  if (!row.replied_at) return "";
  const h = Math.max(0, (Date.parse(row.replied_at) - Date.parse(row.sent_at)) / 3_600_000);
  return `${h.toFixed(1)} h`;
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div style={{ border: "1px solid #ccc", borderRadius: 6, padding: "0.75rem 1rem", minWidth: 160 }}>
      <div style={{ fontSize: "0.85rem", color: "#555" }}>{label}</div>
      <div style={{ fontSize: "1.75rem", fontWeight: 600 }}>{value}</div>
      {note ? <div style={{ fontSize: "0.8rem", color: "#555" }}>{note}</div> : null}
    </div>
  );
}

export default async function OutreachPage() {
  let data: { stats: Stats; rows: Row[] } | null = null;
  let error: string | null = null;
  try {
    const res = await workerFetch("/api/outreach");
    if (!res.ok) throw new Error(`Worker returned ${res.status}`);
    data = (await res.json()) as { stats: Stats; rows: Row[] };
  } catch (e) {
    error = e instanceof Error ? e.message : "unknown error";
  }
  const cell = { border: "1px solid #ddd", padding: "0.35rem 0.6rem", textAlign: "left" as const };
  const s = data?.stats;
  return (
    <main>
      <h1>Outreach</h1>
      <p><a href="/admin">Dashboard</a> | <a href="/admin/contacts">Contacts and asks</a> | <a href="/admin/email">Email</a></p>
      {error ? <p role="alert">Could not load outreach: {error}</p> : null}
      {s ? (
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
          <Stat label="Asks sent" value={String(s.sent)} />
          <Stat label="Opened (approx)" value={`${s.opened} of ${s.sent}`} note="Image-pixel based; blocked or prefetched images skew it." />
          <Stat label="Replied" value={`${s.replied} of ${s.sent}`} />
          <Stat
            label="Response rate"
            value={s.responseRate ? `${Math.round((100 * s.responseRate.numerator) / s.responseRate.denominator)}%` : "n/a"}
            note={s.responseRate ? `${s.responseRate.numerator} of ${s.responseRate.denominator}` : "no asks sent"}
          />
          <Stat label="Median time to reply" value={s.medianHoursToReply === null ? "n/a" : `${s.medianHoursToReply.toFixed(1)} h`} />
        </div>
      ) : null}
      <table style={{ borderCollapse: "collapse", marginTop: "1rem" }}>
        <thead>
          <tr>{["Org", "To", "Sent (UTC)", "Opened (approx)", "Replied (UTC)", "Time to reply"].map((h) => <th key={h} style={cell}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {(data?.rows ?? []).map((r) => (
            <tr key={r.outreach_id}>
              <td style={cell}>{r.org_name}</td>
              <td style={cell}>{r.to_email ?? ""}</td>
              <td style={cell}>{utc(r.sent_at)}</td>
              <td style={cell}>{r.opened_at ? `${utc(r.opened_at)} (${r.open_count}x)` : "not seen"}</td>
              <td style={cell}>{utc(r.replied_at) || "no reply"}</td>
              <td style={cell}>{hours(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
