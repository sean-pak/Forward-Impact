import { notFound, redirect } from "next/navigation";
import { rowsFromFormData } from "../../../lib/formData";
import { workerFetch } from "../../../lib/worker";

export const dynamic = "force-dynamic";

type Field = { field_key: string; label: string; type: string; options: string[] | null; required: boolean };
type Form = {
  org_name: string;
  programs: {
    program_id: string; program_name: string; completion_rule: string;
    prefill: { facility_name: string; yard: string; sessions_planned: string; course_hours_planned_per_participant: string; extra: Record<string, string> };
  }[];
  facilities: { facility_code: string; facility_name: string; aliases: string[] }[];
  fields: Field[];
};

const NEW_ROWS = 3;

async function submit(formData: FormData) {
  "use server";
  const token = String(formData.get("token"));
  const rowCount = Number(formData.get("row_count"));
  const fieldKeys = formData.getAll("field_key").map(String);
  const rows = rowsFromFormData(formData, rowCount, fieldKeys);
  const res = await workerFetch(`/api/form/${encodeURIComponent(token)}/submit`, { method: "POST", body: JSON.stringify({ rows }) });
  const body = (await res.json().catch(() => ({}))) as { submission_id?: string; error?: string };
  if (!res.ok || !body.submission_id) {
    redirect(`/submit/${encodeURIComponent(token)}?error=${encodeURIComponent(body.error ?? "Something went wrong. Please try again.")}`);
  }
  redirect(`/submit/${encodeURIComponent(token)}/${body.submission_id}`);
}

const box = { border: "1px solid #ccc", borderRadius: 6, padding: "1rem", marginBottom: "1rem" } as const;
const label = { display: "block", marginBottom: "0.5rem" } as const;

export default async function SubmitPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string }> }) {
  const { token } = await params;
  const { error } = await searchParams;
  const res = await workerFetch(`/api/form/${encodeURIComponent(token)}`);
  if (res.status === 404) notFound();
  if (!res.ok) throw new Error(`Worker returned ${res.status}`);
  const form = (await res.json()) as Form;

  const rows = [
    ...form.programs.map((p) => ({ key: p.program_id, program_id: p.program_id, name: p.program_name, rule: p.completion_rule === "unstated" ? "" : p.completion_rule, ...p.prefill })),
    ...Array.from({ length: NEW_ROWS }, (_, i) => ({
      key: `new${i}`, program_id: "", name: "", rule: "", facility_name: "", yard: "", sessions_planned: "",
      course_hours_planned_per_participant: "", extra: {} as Record<string, string>,
    })),
  ];

  return (
    <main style={{ maxWidth: 760 }}>
      <h1>Program data for {form.org_name}</h1>
      <p>
        I&apos;m Sam, TPW&apos;s data assistant (an automated assistant). Fill in one box for each program run you want to report.
        Leave a box empty to skip it. Nothing is counted until you confirm it on the next screen.
      </p>
      <p>Don&apos;t know an exact number? Type your best number and tick &quot;about&quot;. Please don&apos;t put names or CDCR numbers here.</p>
      {error ? <p role="alert" style={{ color: "#b00020" }}>{error}</p> : null}

      <datalist id="facilities">
        {form.facilities.flatMap((f) => [
          <option key={f.facility_code} value={f.facility_name} />,
          ...f.aliases.map((a) => <option key={`${f.facility_code}-${a}`} value={a} label={f.facility_name} />),
        ])}
      </datalist>

      <form action={submit}>
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="row_count" value={rows.length} />
        {form.fields.map((f) => <input key={f.field_key} type="hidden" name="field_key" value={f.field_key} />)}

        {rows.map((r, i) => (
          <fieldset key={r.key} style={box}>
            <legend>{r.program_id ? r.name : `Another program ${i - form.programs.length + 1}`}</legend>
            <input type="hidden" name={`r${i}.program_id`} value={r.program_id} />
            {r.program_id ? (
              <input type="hidden" name={`r${i}.program_name`} value={r.name} />
            ) : (
              <label style={label}>Program name <input name={`r${i}.program_name`} /></label>
            )}
            <label style={label}>Prison (type to search, e.g. &quot;Men&apos;s Colony&quot;) <input name={`r${i}.facility_raw`} list="facilities" defaultValue={r.facility_name} /></label>
            <label style={label}>Yard (optional) <input name={`r${i}.yard`} defaultValue={r.yard} /></label>
            <label style={label}>Start date <input type="date" name={`r${i}.start_date`} /></label>
            <label style={label}>End date <input type="date" name={`r${i}.end_date`} /></label>
            <label style={label}>Sessions planned <input name={`r${i}.sessions_planned`} inputMode="numeric" defaultValue={r.sessions_planned} /></label>
            <label style={label}>Course hours per participant <input name={`r${i}.course_hours_planned_per_participant`} inputMode="decimal" defaultValue={r.course_hours_planned_per_participant} /></label>
            <label style={label}>
              People enrolled <input name={`r${i}.n_enrolled`} inputMode="numeric" />{" "}
              <input type="checkbox" name={`r${i}.n_enrolled_approx`} /> about
            </label>
            <label style={label}>
              People who completed <input name={`r${i}.n_completed`} inputMode="numeric" />{" "}
              <input type="checkbox" name={`r${i}.n_completed_approx`} /> about
            </label>
            <label style={label}>
              Total course hours delivered, across everyone <input name={`r${i}.total_course_hours_delivered`} inputMode="decimal" />{" "}
              <input type="checkbox" name={`r${i}.total_course_hours_delivered_approx`} /> about
            </label>
            <label style={label}>
              What counts as completing? (for example, attended 80% of sessions) <input name={`r${i}.completion_rule`} defaultValue={r.rule} style={{ width: "100%" }} />
            </label>
            {form.fields.map((f) => (
              <label key={f.field_key} style={label}>
                {f.label}{f.required ? " *" : ""}{" "}
                {f.type === "enum" ? (
                  <select name={`r${i}.extra.${f.field_key}`} defaultValue={r.extra[f.field_key] ?? ""}>
                    <option value="">(not answered)</option>
                    {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : f.type === "boolean" ? (
                  <select name={`r${i}.extra.${f.field_key}`} defaultValue={r.extra[f.field_key] ?? ""}>
                    <option value="">(not answered)</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                ) : (
                  <input
                    name={`r${i}.extra.${f.field_key}`}
                    type={f.type === "date" ? "date" : "text"}
                    inputMode={f.type === "integer" ? "numeric" : f.type === "number" ? "decimal" : undefined}
                    defaultValue={r.extra[f.field_key] ?? ""}
                  />
                )}
              </label>
            ))}
          </fieldset>
        ))}
        <button type="submit">Review</button>
      </form>
    </main>
  );
}
