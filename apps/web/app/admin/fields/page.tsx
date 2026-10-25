import { redirect } from "next/navigation";
import { workerFetch } from "../../../lib/worker";

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
  const cell = { border: "1px solid #ddd", padding: "0.35rem 0.6rem", textAlign: "left" as const };
  const pending = fields.filter((f) => f.status === "pending");
  const others = fields.filter((f) => f.status !== "pending");
  const typeName = (t: string) => TYPES.find(([v]) => v === t)?.[1] ?? t;
  return (
    <main>
      <h1>Fields</h1>
      <p><a href="/admin">Dashboard</a> | <a href="/admin/contacts">Contacts and asks</a> | <a href="/admin/submissions">Submissions</a></p>
      <p style={{ maxWidth: 760 }}>
        An active field is asked about in the next email (one question at a time, after the required ones) and shown on the submission form.
        Retiring stops both; answers already stored stay.
      </p>
      {note ? <p role="status">{note}</p> : null}
      {error ? <p role="alert">Could not load the fields: {error}</p> : null}

      <h2>Add a field</h2>
      <form action={add} style={{ display: "grid", gap: "0.5rem", maxWidth: 560 }}>
        <label>Label (what the CBO sees) <input name="label" required maxLength={80} placeholder="RAC eligible?" style={{ width: "100%" }} /></label>
        <label>Type{" "}
          <select name="type" defaultValue="boolean">{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label>Choices, separated by commas (Choice type only) <input name="options" style={{ width: "100%" }} /></label>
        <label><input type="checkbox" name="required" /> Required on the form</label>
        <label>Question for email <input name="ask_template" maxLength={240} placeholder="For {program}: RAC eligible?" style={{ width: "100%" }} /></label>
        <span style={{ color: "#555" }}>
          Leave the question blank to use the example. {"{program}"} and {"{facility}"} are filled in. The key is made from the label unless you set one:{" "}
          <input name="field_key" maxLength={40} placeholder="rac_eligible" />
        </span>
        <div><button type="submit">Add field</button></div>
      </form>

      <h2>Suggested fields</h2>
      {pending.length === 0 ? (
        <p style={{ color: "#555" }}>None. A column header that no field uses and that shows up in two uploads appears here.</p>
      ) : (
        <table style={{ borderCollapse: "collapse" }}>
          <thead><tr>{["Header", "Seen in", "Type", ""].map((h) => <th key={h} style={cell}>{h}</th>)}</tr></thead>
          <tbody>
            {pending.map((f) => (
              <tr key={f.field_key}>
                <td style={cell}>{f.label}</td>
                <td style={cell}>{f.seen_count ?? 0} uploads</td>
                <td style={cell} colSpan={2}>
                  <form action={act} style={{ display: "inline" }}>
                    <input type="hidden" name="field_key" value={f.field_key} />
                    <select name="type" defaultValue="text" aria-label={`Type for ${f.label}`}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>{" "}
                    <input name="options" placeholder="choices, if Choice" aria-label={`Choices for ${f.label}`} />{" "}
                    <button type="submit" name="action" value="approve">Approve</button>{" "}
                    <button type="submit" name="action" value="dismiss">Dismiss</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>All fields</h2>
      <table style={{ borderCollapse: "collapse" }}>
        <thead><tr>{["Key", "Label", "Type", "Required", "Status", "Question", ""].map((h) => <th key={h} style={cell}>{h}</th>)}</tr></thead>
        <tbody>
          {others.map((f) => (
            <tr key={f.field_key} style={f.status === "retired" ? { color: "#777" } : undefined}>
              <td style={cell}><code>{f.field_key}</code></td>
              <td style={cell}>{f.label}</td>
              <td style={cell}>{typeName(f.type)}{f.options ? ` (${f.options.join(", ")})` : ""}</td>
              <td style={cell}>{f.required ? "yes" : "no"}</td>
              <td style={cell}>{f.is_core ? "built in" : f.status}</td>
              <td style={cell}>{f.ask_template}</td>
              <td style={cell}>
                {f.is_core ? null : (
                  <form action={act} style={{ display: "inline" }}>
                    <input type="hidden" name="field_key" value={f.field_key} />
                    {f.status === "active" ? <button type="submit" name="action" value="retire">Retire</button> : null}
                    {f.status === "retired" ? <button type="submit" name="action" value="reactivate">Reactivate</button> : null}
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
