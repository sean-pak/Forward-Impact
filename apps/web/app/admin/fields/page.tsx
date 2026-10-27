import { redirect } from "next/navigation";
import { workerFetch } from "../../../lib/worker";
import { Badge, ErrorNote, Note, PageHead, Section } from "../../components/ui";

export const dynamic = "force-dynamic";

type Field = {
  field_key: string; label: string; type: string; options: string[] | null; required: boolean; ask_template: string;
  status: "active" | "retired" | "pending"; is_core: boolean; seen_count: number | null;
};

const back = (note: string): never => redirect(`/admin/fields?note=${encodeURIComponent(note)}`);

async function failure(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return `Failed (${res.status}): ${body.error ?? "unknown error"}`;
}

const list = (v: FormDataEntryValue | null) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

async function add(formData: FormData) {
  "use server";
  const key = String(formData.get("field_key") ?? "").trim();
  const ask = String(formData.get("ask_template") ?? "").trim();
  const res = await workerFetch("/api/fields", {
    method: "POST",
    body: JSON.stringify({
      label: String(formData.get("label") ?? ""), type: String(formData.get("type")), options: list(formData.get("options")),
      required: formData.get("required") === "on", ...(key ? { field_key: key } : {}), ...(ask ? { ask_template: ask } : {}),
    }),
  });
  back(res.ok ? "Field added. The next email and the form will ask it." : await failure(res));
}

async function act(formData: FormData) {
  "use server";
  const action = String(formData.get("action"));
  const key = String(formData.get("field_key"));
  const type = String(formData.get("type") ?? "");
  const res = await workerFetch(`/api/fields/${encodeURIComponent(key)}/${action}`, {
    method: "POST", body: JSON.stringify(type ? { type, options: list(formData.get("options")) } : {}),
  });
  const done: Record<string, string> = {
    retire: "Retired. It is no longer asked or shown; answers already stored are kept.",
    reactivate: "Active again.", approve: "Approved. It is asked and shown now.", dismiss: "Dismissed. It will not be suggested again.",
  };
  back(res.ok ? (done[action] ?? "Done.") : await failure(res));
}

const TYPES: [string, string][] = [["text", "Text"], ["integer", "Whole number"], ["number", "Number"], ["boolean", "Yes / no"], ["date", "Date"], ["enum", "Choice"]];

export default async function FieldsPage({ searchParams }: { searchParams: Promise<{ note?: string }> }) {
  const { note } = await searchParams;
  let fields: Field[] = [];
  let error: string | null = null;
  try {
    const res = await workerFetch("/api/fields");
    if (!res.ok) throw new Error(`Worker returned ${res.status}`);
    fields = ((await res.json()) as { fields: Field[] }).fields;
  } catch (e) {
    error = e instanceof Error ? e.message : "unknown error";
  }
  const pending = fields.filter((f) => f.status === "pending");
  const others = fields.filter((f) => f.status !== "pending");
  const typeName = (t: string) => TYPES.find(([v]) => v === t)?.[1] ?? t;
  return (
    <main>
      <PageHead
        eyebrow="Setup"
        title="Fields"
        lede="An active field is asked about in the next email (one question at a time, after the required ones) and shown on the submission form. Retiring stops both; answers already stored stay."
      />
      <Note note={note} />
      {error ? <ErrorNote>Could not load the fields: {error}</ErrorNote> : null}

      <div className="split" style={{ alignItems: "start" }}>
        <div className="panel">
          <h2 style={{ marginBottom: "1rem" }}>Add a field</h2>
          <form action={add} className="form">
            <label className="field"><span>Label (what the CBO sees)</span><input name="label" required maxLength={80} placeholder="RAC eligible?" /></label>
            <div className="grid-2">
              <label className="field"><span>Type</span>
                <select name="type" defaultValue="boolean">{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              </label>
              <label className="field"><span>Key <span className="field-help">(optional)</span></span><input name="field_key" maxLength={40} placeholder="rac_eligible" /></label>
            </div>
            <label className="field"><span>Choices, separated by commas <span className="field-help">(Choice type only)</span></span><input name="options" /></label>
            <label className="field">
              <span>Question for email</span>
              <input name="ask_template" maxLength={240} placeholder="For {program}: RAC eligible?" />
              <span className="field-help">
                Leave the question blank to use the example. {"{program}"} and {"{facility}"} are filled in. The key is made from the label unless you set one.
              </span>
            </label>
            <label className="check"><input type="checkbox" name="required" /> Required on the form</label>
            <div><button type="submit" className="btn-primary">Add field</button></div>
          </form>
        </div>

        <div className="panel">
          <h2 style={{ marginBottom: "0.5rem" }}>Suggested fields {pending.length ? <Badge tone="warn">{pending.length}</Badge> : null}</h2>
          {pending.length === 0 ? (
            <p className="hint" style={{ margin: 0 }}>None. A column header that no field uses and that shows up in two uploads appears here.</p>
          ) : (
            <div className="stack" style={{ marginTop: "0.75rem" }}>
              {pending.map((f) => (
                <form key={f.field_key} action={act} className="stack" style={{ gap: "0.5rem", paddingBottom: "0.75rem", borderBottom: "1px solid var(--rule)" }}>
                  <div><strong>{f.label}</strong> <span className="hint">seen in {f.seen_count ?? 0} uploads</span></div>
                  <input type="hidden" name="field_key" value={f.field_key} />
                  <div className="inline-form">
                    <select name="type" defaultValue="text" aria-label={`Type for ${f.label}`}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                    <input name="options" placeholder="choices, if Choice" aria-label={`Choices for ${f.label}`} style={{ flex: 1 }} />
                  </div>
                  <div className="inline-form">
                    <button type="submit" name="action" value="approve" className="btn-primary btn-sm">Approve</button>
                    <button type="submit" name="action" value="dismiss" className="btn-sm">Dismiss</button>
                  </div>
                </form>
              ))}
            </div>
          )}
        </div>
      </div>

      <Section title="All fields">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Key</th><th>Label</th><th>Type</th><th>Required</th><th>Status</th><th>Question</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {others.map((f) => (
                <tr key={f.field_key} className={f.status === "retired" ? "is-retired" : undefined}>
                  <td><code>{f.field_key}</code></td>
                  <td>{f.label}</td>
                  <td>{typeName(f.type)}{f.options ? <span className="dim"> ({f.options.join(", ")})</span> : ""}</td>
                  <td>{f.required ? "yes" : <span className="dim">no</span>}</td>
                  <td>{f.is_core ? <Badge>built in</Badge> : <Badge tone={f.status === "active" ? "good" : "plain"}>{f.status}</Badge>}</td>
                  <td className="dim">{f.ask_template}</td>
                  <td className="num">
                    {f.is_core ? null : (
                      <form action={act}>
                        <input type="hidden" name="field_key" value={f.field_key} />
                        {f.status === "active" ? <button type="submit" name="action" value="retire" className="btn-sm">Retire</button> : null}
                        {f.status === "retired" ? <button type="submit" name="action" value="reactivate" className="btn-sm">Reactivate</button> : null}
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </main>
  );
}
