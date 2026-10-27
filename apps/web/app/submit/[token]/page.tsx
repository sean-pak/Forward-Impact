import { notFound, redirect } from "next/navigation";
import { rowsFromFormData } from "../../../lib/formData";
import { workerFetch } from "../../../lib/worker";
import { PublicFrame } from "../../components/PublicFrame";
import { ErrorNote, PageHead } from "../../components/ui";

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

/** A number box with an "about" tick next to it, for counts the CBO only knows roughly. */
function Approx({ label, name }: { label: string; name: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <span className="with-approx">
        <input name={name} inputMode={name.endsWith("hours_delivered") ? "decimal" : "numeric"} />
        <span className="check"><input type="checkbox" name={`${name}_approx`} /> about</span>
      </span>
    </label>
  );
}

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
    <PublicFrame>
      <PageHead
        eyebrow="Program data"
        title={<>Program data for {form.org_name}</>}
        lede={
          <>
            I&apos;m Sam, TPW&apos;s data assistant (an automated assistant). Fill in one box for each program run you want to report.
            Leave a box empty to skip it. Nothing is counted until you confirm it on the next screen.
          </>
        }
      />
      <p className="notice">Don&apos;t know an exact number? Type your best number and tick &quot;about&quot;. Please don&apos;t put names or CDCR numbers here.</p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}

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
          <fieldset key={r.key} className={`program-card${r.program_id ? "" : " is-new"}`}>
            <legend>{r.program_id ? r.name : `Another program ${i - form.programs.length + 1}`}</legend>
            <input type="hidden" name={`r${i}.program_id`} value={r.program_id} />
            <div className="grid-2">
              {r.program_id ? (
                <input type="hidden" name={`r${i}.program_name`} value={r.name} />
              ) : (
                <label className="field full"><span>Program name</span><input name={`r${i}.program_name`} /></label>
              )}
              <label className="field"><span>Prison <span className="field-help">(type to search, e.g. &quot;Men&apos;s Colony&quot;)</span></span><input name={`r${i}.facility_raw`} list="facilities" defaultValue={r.facility_name} /></label>
              <label className="field"><span>Yard <span className="field-help">(optional)</span></span><input name={`r${i}.yard`} defaultValue={r.yard} /></label>
              <label className="field"><span>Start date</span><input type="date" name={`r${i}.start_date`} /></label>
              <label className="field"><span>End date</span><input type="date" name={`r${i}.end_date`} /></label>
              <label className="field"><span>Sessions planned</span><input name={`r${i}.sessions_planned`} inputMode="numeric" defaultValue={r.sessions_planned} /></label>
              <label className="field"><span>Course hours per participant</span><input name={`r${i}.course_hours_planned_per_participant`} inputMode="decimal" defaultValue={r.course_hours_planned_per_participant} /></label>
              <Approx label="People enrolled" name={`r${i}.n_enrolled`} />
              <Approx label="People who completed" name={`r${i}.n_completed`} />
              <div className="full"><Approx label="Total course hours delivered, across everyone" name={`r${i}.total_course_hours_delivered`} /></div>
              <label className="field full">
                <span>What counts as completing? <span className="field-help">(for example, attended 80% of sessions)</span></span>
                <input name={`r${i}.completion_rule`} defaultValue={r.rule} />
              </label>
              {form.fields.map((f) => (
                <label key={f.field_key} className="field">
                  <span>{f.label}{f.required ? " *" : ""}</span>
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
            </div>
          </fieldset>
        ))}
        <div className="sticky-submit">
          <button type="submit" className="btn-primary">Review</button>
          <span className="hint">You&apos;ll check everything before it counts.</span>
        </div>
      </form>
    </PublicFrame>
  );
}
