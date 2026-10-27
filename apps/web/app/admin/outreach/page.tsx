import { workerFetch } from "../../../lib/worker";
import { Badge, ErrorNote, PageHead, Stat, When } from "../../components/ui";

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

function hours(row: Row): string {
  if (!row.replied_at) return "";
  const h = Math.max(0, (Date.parse(row.replied_at) - Date.parse(row.sent_at)) / 3_600_000);
  return `${h.toFixed(1)} h`;
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
  const s = data?.stats;
  const rr = s?.responseRate ?? null;
  return (
    <main>
      <PageHead
        eyebrow="Outreach"
        title="Outreach"
        lede="Who was asked for data, who opened it and who replied."
        actions={<a className="btn" href="/admin/contacts">Contacts and asks</a>}
      />
      {error ? <ErrorNote>Could not load outreach: {error}</ErrorNote> : null}
      {s ? (
        <div className="stats">
          <Stat label="Asks sent" value={String(s.sent)} />
          <Stat label="Opened (approx)" value={`${s.opened} of ${s.sent}`} note="Image-pixel based; blocked or prefetched images skew it." />
          <Stat label="Replied" value={`${s.replied} of ${s.sent}`} />
          <Stat
            label="Response rate"
            value={rr ? `${Math.round((100 * rr.numerator) / rr.denominator)}%` : "n/a"}
            metric={rr ? { value: rr.numerator / rr.denominator, numerator: rr.numerator, denominator: rr.denominator, suppressed: false, isEstimate: false } : undefined}
            note={rr ? `${rr.numerator} of ${rr.denominator}` : "no asks sent"}
          />
          <Stat label="Median time to reply" value={s.medianHoursToReply === null ? "n/a" : `${s.medianHoursToReply.toFixed(1)} h`} />
        </div>
      ) : null}
      <div className="table-wrap" style={{ marginTop: "1.5rem" }}>
        <table className="data">
          <thead>
            <tr><th>Org</th><th>To</th><th>Sent (UTC)</th><th>Opened (approx)</th><th>Replied (UTC)</th><th className="num">Time to reply</th></tr>
          </thead>
          <tbody>
            {(data?.rows ?? []).map((r) => (
              <tr key={r.outreach_id}>
                <td>{r.org_name}</td>
                <td className="dim">{r.to_email ?? ""}</td>
                <td><When t={r.sent_at} /></td>
                <td>{r.opened_at ? <><When t={r.opened_at} /> <span className="dim">({r.open_count}x)</span></> : <span className="dim">not seen</span>}</td>
                <td>{r.replied_at ? <When t={r.replied_at} /> : <Badge>no reply</Badge>}</td>
                <td className="num">{hours(r)}</td>
              </tr>
            ))}
            {data && data.rows.length === 0 ? (
              <tr><td className="empty" colSpan={6}>No asks sent yet. Send them from <a href="/admin/contacts">Contacts and asks</a>.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </main>
  );
}
