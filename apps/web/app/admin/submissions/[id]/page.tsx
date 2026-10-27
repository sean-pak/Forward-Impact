import { notFound } from "next/navigation";
import { workerFetch } from "../../../../lib/worker";
import { Badge, PageHead, Section, Unknown, When, statusTone } from "../../../components/ui";

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

const count = (n: number | null, approx: boolean) =>
  n === null ? <Unknown /> : <>{approx ? <span className="approx">about </span> : null}{n}</>;

export default async function SubmissionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await workerFetch(`/api/submissions/${encodeURIComponent(id)}`);
  if (res.status === 404) notFound();
  if (!res.ok) throw new Error(`Worker returned ${res.status}`);
  const d = (await res.json()) as Detail;
  const program = new Map(d.cycles.map((c) => [c.cycle_id, `${c.program_name} (${c.facility_name ?? "prison unknown"})`]));
  return (
    <main>
      <p className="hint" style={{ marginBottom: "0.75rem" }}><a href="/admin/submissions">← All submissions</a></p>
      <PageHead eyebrow="Submission" title={<>Submission from {d.org_name}</>} actions={<Badge tone={statusTone(d.status)}>{d.status}</Badge>} />

      <div className="panel">
        <dl className="meta">
          <div><dt>Status</dt><dd>{d.status}</dd></div>
          <div><dt>Channel</dt><dd>{d.channel}</dd></div>
          <div><dt>Received (UTC)</dt><dd><When t={d.received_at} /></dd></div>
          <div><dt>Persona</dt><dd>{d.detected_persona ?? <Unknown />}</dd></div>
          {d.llm_mapping_used ? <div><dt>Columns</dt><dd>Columns mapped by the model</dd></div> : null}
        </dl>
      </div>

      <div style={{ marginTop: "1rem" }}>
        {d.scrambled && (d.scrambled.names > 0 || d.scrambled.cdcr > 0) ? (
          <p className="notice notice-ok">
            {d.scrambled.names} names and {d.scrambled.cdcr} CDCR numbers were scrambled into the vault. Only person keys are stored here.
          </p>
        ) : null}
        {d.notes?.length ? <div className="notice"><ul style={{ margin: 0, paddingLeft: "1.1rem" }}>{d.notes.map((n) => <li key={n}>{n}</li>)}</ul></div> : null}
        {d.duplicates.length ? (
          <p role="status" className="notice notice-warn">
            {d.duplicates.length} earlier entr{d.duplicates.length === 1 ? "y has" : "ies have"} the same program, prison and start date; confirming would replace {d.duplicates.length === 1 ? "it" : "them"}.
          </p>
        ) : null}
      </div>

      <Section title="Cycles" aside="These cycles do not count on the dashboard until the organization confirms them.">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Program</th><th>Prison</th><th>Start</th><th>End</th>
                <th className="num">Enrolled</th><th className="num">Completed</th><th>Completion rule</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {d.cycles.map((c) => (
                <tr key={c.cycle_id}>
                  <td>{c.program_name}</td>
                  <td>{c.facility_name ?? <Unknown />}</td>
                  <td className="when">{c.start_date ?? <Unknown />}</td>
                  <td className="when">{c.end_date ?? <Unknown />}</td>
                  <td className="num">{count(c.n_enrolled, c.n_enrolled_approx)}</td>
                  <td className="num">{count(c.n_completed, c.n_completed_approx)}</td>
                  <td className="dim">{c.completion_rule}</td>
                  <td><Badge tone={statusTone(c.status)}>{c.status}</Badge></td>
                </tr>
              ))}
              {d.cycles.length === 0 ? <tr><td className="empty" colSpan={8}>No cycles were read from this submission.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Issues" aside={d.issues.length ? `${d.issues.filter((i) => i.blocking).length} must fix, ${d.issues.filter((i) => !i.blocking).length} flagged` : undefined}>
        {d.issues.length === 0 ? (
          <p className="hint">None.</p>
        ) : (
          <ul className="issues">
            {d.issues.map((i) => (
              <li key={i.issue_id}>
                <Badge tone={i.blocking ? "bad" : "warn"}>{i.blocking ? "Must fix" : "Flag"}</Badge>
                <div>
                  <div>{i.message}</div>
                  <div className="issue-meta">
                    {i.issue_type} · {i.field_name}
                    {i.row_ref && program.has(i.row_ref) ? ` · ${program.get(i.row_ref)}` : ""}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </main>
  );
}
