import { workerFetch } from "../../../lib/worker";
import { Badge, ErrorNote, PageHead, Unknown, When, statusTone } from "../../components/ui";

export const dynamic = "force-dynamic";

type Row = {
  submission_id: string; channel: string; status: string; received_at: string; detected_persona: number | null;
  org_name: string; n_cycles: number; n_issues: number;
};

export default async function SubmissionsPage() {
  let rows: Row[] = [];
  let error: string | null = null;
  try {
    const res = await workerFetch("/api/submissions");
    if (!res.ok) throw new Error(`Worker returned ${res.status}`);
    rows = ((await res.json()) as { submissions: Row[] }).submissions;
  } catch (e) {
    error = e instanceof Error ? e.message : "unknown error";
  }
  return (
    <main>
      <PageHead
        eyebrow="Data"
        title="Submissions"
        lede="Everything Sam has read, from email replies, the form and uploads. Nothing counts until the organization confirms."
        actions={<a className="btn btn-primary" href="/admin/upload">Upload</a>}
      />
      {error ? <ErrorNote>Could not load submissions: {error}</ErrorNote> : null}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Received (UTC)</th><th>Org</th><th>Channel</th><th>Persona</th><th>Status</th>
              <th className="num">Cycles</th><th className="num">Open issues</th><th aria-label="Open" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.submission_id}>
                <td><When t={r.received_at} /></td>
                <td>{r.org_name}</td>
                <td className="dim">{r.channel}</td>
                <td className="dim">{r.detected_persona ?? <Unknown />}</td>
                <td><Badge tone={statusTone(r.status)}>{r.status}</Badge></td>
                <td className="num">{r.n_cycles}</td>
                <td className="num">{r.n_issues > 0 ? <Badge tone="warn">{r.n_issues}</Badge> : <span className="dim">0</span>}</td>
                <td className="num"><a className="btn btn-sm" href={`/admin/submissions/${r.submission_id}`}>Open</a></td>
              </tr>
            ))}
            {rows.length === 0 && !error ? (
              <tr><td className="empty" colSpan={8}>No submissions yet. <a href="/admin/upload">Upload a file</a> or wait for a reply to an ask.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </main>
  );
}
