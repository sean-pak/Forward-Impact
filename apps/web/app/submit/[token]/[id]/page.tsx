import { notFound, redirect } from "next/navigation";
import { workerFetch } from "../../../../lib/worker";

export const dynamic = "force-dynamic";

type Cycle = {
  cycle_id: string; program_name: string; facility_name: string | null; start_date: string | null; end_date: string | null;
  n_enrolled: number | null; n_completed: number | null; total_course_hours_delivered: number | null;
  n_enrolled_approx: boolean; n_completed_approx: boolean; total_course_hours_delivered_approx: boolean; completion_rule: string;
};
type View = {
  submission_id: string; status: string; org_name: string; cycles: Cycle[];
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

const val = (n: number | null, approx: boolean) => (n === null ? "not given" : `${n}${approx ? " (about)" : ""}`);

export default async function ConfirmPage({ params, searchParams }: { params: Promise<{ token: string; id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { token, id } = await params;
  const { error } = await searchParams;
  const res = await workerFetch(`/api/form/${encodeURIComponent(token)}/submissions/${encodeURIComponent(id)}`);
  if (res.status === 404) notFound();
  if (!res.ok) throw new Error(`Worker returned ${res.status}`);
  const v = (await res.json()) as View;
  const cell = { border: "1px solid #ddd", padding: "0.35rem 0.6rem", textAlign: "left" as const };

  if (v.status === "confirmed") {
    return (
      <main style={{ maxWidth: 760 }}>
        <h1>Thank you, {v.org_name}</h1>
        <p role="status">This data is confirmed and now counts. You can close this page, or <a href={`/submit/${token}`}>report another program</a>.</p>
        <p>Sam, TPW&apos;s data assistant</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 760 }}>
      <h1>Please check this for {v.org_name}</h1>
      <p>Nothing is counted until you confirm.</p>
      {error ? <p role="alert" style={{ color: "#b00020" }}>{error}</p> : null}
      {v.issues.length ? (
        <>
          <h2>{v.blocked ? "Needs fixing" : "Worth a look"}</h2>
          <ul>{v.issues.map((i) => <li key={i.issue_id}>{i.message}{i.blocking ? " (needed)" : ""}</li>)}</ul>
        </>
      ) : null}
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>{["Program", "Prison", "Start", "End", "Enrolled", "Completed", "Hours delivered", "Completion rule"].map((h) => <th key={h} style={cell}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {v.cycles.map((c) => (
            <tr key={c.cycle_id}>
              <td style={cell}>{c.program_name}</td>
              <td style={cell}>{c.facility_name ?? "not given"}</td>
              <td style={cell}>{c.start_date ?? "not given"}</td>
              <td style={cell}>{c.end_date ?? "not given"}</td>
              <td style={cell}>{val(c.n_enrolled, c.n_enrolled_approx)}</td>
              <td style={cell}>{val(c.n_completed, c.n_completed_approx)}</td>
              <td style={cell}>{val(c.total_course_hours_delivered, c.total_course_hours_delivered_approx)}</td>
              <td style={cell}>{c.completion_rule === "unstated" ? "not stated" : c.completion_rule}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {v.blocked ? (
        <p>Some required information is missing or unclear, so this can&apos;t be confirmed yet. <a href={`/submit/${token}`}>Go back to the form</a> and submit again.</p>
      ) : (
        <form action={confirm} style={{ marginTop: "1rem" }}>
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="id" value={id} />
          <button type="submit">Yes, this is right. Confirm</button>{" "}
          <a href={`/submit/${token}`}>No, change something</a>
        </form>
      )}
    </main>
  );
}
