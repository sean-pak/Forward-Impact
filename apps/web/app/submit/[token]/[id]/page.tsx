import { notFound, redirect } from "next/navigation";
import { timeAgo } from "@tpw/shared";
import { workerFetch } from "../../../../lib/worker";
import { PublicFrame } from "../../../components/PublicFrame";
import { ErrorNote, PageHead, Section } from "../../../components/ui";

export const dynamic = "force-dynamic";

type Cycle = {
  cycle_id: string; program_name: string; facility_name: string | null; start_date: string | null; end_date: string | null;
  n_enrolled: number | null; n_completed: number | null; total_course_hours_delivered: number | null;
  n_enrolled_approx: boolean; n_completed_approx: boolean; total_course_hours_delivered_approx: boolean; completion_rule: string;
};
type View = {
  submission_id: string; status: string; org_name: string; cycles: Cycle[];
  duplicates: { cycle_id: string; program_name: string; facility_name: string | null; start_date: string | null; n_enrolled: number | null; n_completed: number | null; submitted_at: string }[];
  issues: { issue_id: number; row_ref: string | null; message: string; blocking: boolean }[]; blocked: boolean;
};

async function confirm(formData: FormData) {
  "use server";
  const token = String(formData.get("token"));
  const id = String(formData.get("id"));
  const res = await workerFetch(`/api/form/${encodeURIComponent(token)}/submissions/${encodeURIComponent(id)}/confirm`, { method: "POST" });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  redirect(`/submit/${encodeURIComponent(token)}/${encodeURIComponent(id)}${res.ok ? "" : `?error=${encodeURIComponent(body.error ?? "Could not confirm.")}`}`);
}

const val = (n: number | null, approx: boolean) =>
  n === null ? <span className="unknown">not given</span> : <>{n}{approx ? <span className="approx"> (about)</span> : ""}</>;

export default async function ConfirmPage({ params, searchParams }: { params: Promise<{ token: string; id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { token, id } = await params;
  const { error } = await searchParams;
  const res = await workerFetch(`/api/form/${encodeURIComponent(token)}/submissions/${encodeURIComponent(id)}`);
  if (res.status === 404) notFound();
  if (!res.ok) throw new Error(`Worker returned ${res.status}`);
  const v = (await res.json()) as View;

  if (v.status === "confirmed") {
    return (
      <PublicFrame>
        <div className="panel" style={{ borderTop: "4px solid var(--yard)", padding: "1.75rem" }}>
          <h1 style={{ marginBottom: "0.75rem" }}>Thank you, {v.org_name}</h1>
          <p role="status">This data is confirmed and now counts. You can close this page, or <a href={`/submit/${token}`}>report another program</a>.</p>
          <p className="hint" style={{ margin: 0 }}>Sam, TPW&apos;s data assistant</p>
        </div>
      </PublicFrame>
    );
  }

  return (
    <PublicFrame wide>
      <PageHead eyebrow="Review" title={<>Please check this for {v.org_name}</>} lede="Nothing is counted until you confirm." />
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {v.duplicates.map((d) => (
        <p key={d.cycle_id} role="note" className="notice notice-warn">
          <strong>It looks like you submitted the same program twice!</strong>{" "}
          {timeAgo(d.submitted_at, new Date())} ({d.submitted_at.replace("T", " ").replace("Z", " UTC")}) you submitted the exact same details for{" "}
          {d.program_name} at {d.facility_name ?? "the same prison"}, starting {d.start_date ?? "an unknown date"}
          {d.n_enrolled !== null ? `, with ${d.n_enrolled} enrolled` : ""}. Is this another, separate program at the same prison?
          If so, <a href={`/submit/${token}`}>go back</a> and change the program name or start date so they stay separate.
          If it&apos;s the same program, confirming will replace your earlier entry, not add to it.
        </p>
      ))}
      {v.issues.length ? (
        <Section title={v.blocked ? "Needs fixing" : "Worth a look"}>
          <ul className="issues">
            {v.issues.map((i) => (
              <li key={i.issue_id}>
                <span className={`badge ${i.blocking ? "badge-bad" : "badge-warn"}`}>{i.blocking ? "needed" : "check"}</span>
                <div>{i.message}</div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title="What you sent">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Program</th><th>Prison</th><th>Start</th><th>End</th><th className="num">Enrolled</th><th className="num">Completed</th><th className="num">Hours delivered</th><th>Completion rule</th></tr>
            </thead>
            <tbody>
              {v.cycles.map((c) => (
                <tr key={c.cycle_id}>
                  <td>{c.program_name}</td>
                  <td>{c.facility_name ?? <span className="unknown">not given</span>}</td>
                  <td className="when">{c.start_date ?? <span className="unknown">not given</span>}</td>
                  <td className="when">{c.end_date ?? <span className="unknown">not given</span>}</td>
                  <td className="num">{val(c.n_enrolled, c.n_enrolled_approx)}</td>
                  <td className="num">{val(c.n_completed, c.n_completed_approx)}</td>
                  <td className="num">{val(c.total_course_hours_delivered, c.total_course_hours_delivered_approx)}</td>
                  <td className="dim">{c.completion_rule === "unstated" ? "not stated" : c.completion_rule}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      {v.blocked ? (
        <p className="notice notice-error" style={{ marginTop: "1.5rem" }}>
          Some required information is missing or unclear, so this can&apos;t be confirmed yet. <a href={`/submit/${token}`}>Go back to the form</a> and submit again.
        </p>
      ) : (
        <form action={confirm} className="inline-form" style={{ marginTop: "1.5rem" }}>
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="id" value={id} />
          <button type="submit" className="btn-primary">Yes, this is right. Confirm</button>
          <a className="btn btn-ghost" href={`/submit/${token}`}>No, change something</a>
        </form>
      )}
    </PublicFrame>
  );
}
