import { notFound } from "next/navigation";
import { workerFetch } from "../../../../lib/worker";

export const dynamic = "force-dynamic";

type Detail = {
  submission_id: string; status: string; org_name: string; channel: string; received_at: string;
  detected_persona: number | null; llm_mapping_used: boolean;
  scrambled?: { names: number; cdcr: number }; notes?: string[];
  cycles: {
    cycle_id: string; program_name: string; facility_name: string | null; start_date: string | null; end_date: string | null;
    n_enrolled: number | null; n_completed: number | null; n_enrolled_approx: boolean; n_completed_approx: boolean;
    completion_rule: string; status: string;
  }[];
  issues: { issue_id: number; row_ref: string | null; field_name: string; issue_type: string; message: string; blocking: boolean }[];
  duplicates: { cycle_id: string }[];
};

const count = (n: number | null, approx: boolean) => (n === null ? "unknown" : `${approx ? "about " : ""}${n}`);

export default async function SubmissionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await workerFetch(`/api/submissions/${encodeURIComponent(id)}`);
  if (res.status === 404) notFound();
  if (!res.ok) throw new Error(`Worker returned ${res.status}`);
  const d = (await res.json()) as Detail;
  const cell = { border: "1px solid #ddd", padding: "0.35rem 0.6rem", textAlign: "left" as const };
  const program = new Map(d.cycles.map((c) => [c.cycle_id, `${c.program_name} (${c.facility_name ?? "prison unknown"})`]));
  return (
    <main>
      <h1>Submission from {d.org_name}</h1>
      <p><a href="/admin/submissions">All submissions</a> | <a href="/admin/upload">Upload</a></p>
      <p>
        Status: <strong>{d.status}</strong> | Channel: {d.channel} | Received: {d.received_at.replace("T", " ").slice(0, 19)} UTC |
        Persona: {d.detected_persona ?? "unknown"}{d.llm_mapping_used ? " | Columns mapped by the model" : ""}
      </p>
      {d.scrambled && (d.scrambled.names > 0 || d.scrambled.cdcr > 0) ? (
        <p>{d.scrambled.names} names and {d.scrambled.cdcr} CDCR numbers were scrambled into the vault. Only person keys are stored here.</p>
      ) : null}
      {d.notes?.length ? <ul>{d.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
      <p style={{ color: "#555" }}>These cycles do not count on the dashboard until the organization confirms them.</p>
      {d.duplicates.length ? <p role="status">{d.duplicates.length} earlier entr{d.duplicates.length === 1 ? "y has" : "ies have"} the same program, prison and start date; confirming would replace {d.duplicates.length === 1 ? "it" : "them"}.</p> : null}

      <h2>Cycles</h2>
      <table style={{ borderCollapse: "collapse" }}>
        <thead><tr>{["Program", "Prison", "Start", "End", "Enrolled", "Completed", "Completion rule", "Status"].map((h) => <th key={h} style={cell}>{h}</th>)}</tr></thead>
        <tbody>
          {d.cycles.map((c) => (
            <tr key={c.cycle_id}>
              <td style={cell}>{c.program_name}</td>
              <td style={cell}>{c.facility_name ?? "unknown"}</td>
              <td style={cell}>{c.start_date ?? "unknown"}</td>
              <td style={cell}>{c.end_date ?? "unknown"}</td>
              <td style={cell}>{count(c.n_enrolled, c.n_enrolled_approx)}</td>
              <td style={cell}>{count(c.n_completed, c.n_completed_approx)}</td>
              <td style={cell}>{c.completion_rule}</td>
              <td style={cell}>{c.status}</td>
            </tr>
          ))}
          {d.cycles.length === 0 ? <tr><td style={cell} colSpan={8}>No cycles were read from this submission.</td></tr> : null}
        </tbody>
      </table>

      <h2>Issues</h2>
      {d.issues.length === 0 ? <p>None.</p> : (
        <ul>
          {d.issues.map((i) => (
            <li key={i.issue_id}>
              <strong>{i.blocking ? "Must fix" : "Flag"}</strong> ({i.issue_type}, {i.field_name}
              {i.row_ref && program.has(i.row_ref) ? `, ${program.get(i.row_ref)}` : ""}): {i.message}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
