import { workerFetch } from "../../../lib/worker";

export const dynamic = "force-dynamic";

type Row = {
  submission_id: string; channel: string; status: string; received_at: string; detected_persona: number | null;
  org_name: string; n_cycles: number; n_issues: number;
};

const utc = (t: string) => t.replace("T", " ").slice(0, 19);

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
  const cell = { border: "1px solid #ddd", padding: "0.35rem 0.6rem", textAlign: "left" as const };
  return (
    <main>
      <h1>Submissions</h1>
      <p><a href="/admin">Dashboard</a> | <a href="/admin/upload">Upload</a> | <a href="/admin/email">Email</a></p>
      {error ? <p role="alert">Could not load submissions: {error}</p> : null}
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>{["Received (UTC)", "Org", "Channel", "Persona", "Status", "Cycles", "Open issues", ""].map((h) => <th key={h} style={cell}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.submission_id}>
              <td style={cell}>{utc(r.received_at)}</td>
              <td style={cell}>{r.org_name}</td>
              <td style={cell}>{r.channel}</td>
              <td style={cell}>{r.detected_persona ?? "unknown"}</td>
              <td style={cell}>{r.status}</td>
              <td style={cell}>{r.n_cycles}</td>
              <td style={cell}>{r.n_issues}</td>
              <td style={cell}><a href={`/admin/submissions/${r.submission_id}`}>Open</a></td>
            </tr>
          ))}
          {rows.length === 0 && !error ? <tr><td style={cell} colSpan={8}>No submissions yet.</td></tr> : null}
        </tbody>
      </table>
    </main>
  );
}
