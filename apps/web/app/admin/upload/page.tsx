import { redirect } from "next/navigation";
import { workerFetch } from "../../../lib/worker";

export const dynamic = "force-dynamic";

const back = (note: string): never => redirect(`/admin/upload?note=${encodeURIComponent(note)}`);

async function upload(formData: FormData) {
  "use server";
  const orgId = String(formData.get("org_id") ?? "");
  const file = formData.get("file");
  const text = String(formData.get("text") ?? "").trim();
  const hasFile = file instanceof File && file.size > 0;
  if (!orgId) back("Choose an organization.");
  if (!hasFile && !text) back("Choose a file or paste the text.");
  const body = new FormData();
  body.set("org_id", orgId);
  if (hasFile) body.set("file", file as File);
  else body.set("text", text);
  const res = await workerFetch("/api/ingest/upload", { method: "POST", body });
  const r = (await res.json().catch(() => ({}))) as { error?: string; submission_id?: string | null; status?: string; note?: string };
  if (!res.ok) back(`Failed (${res.status}): ${r.error ?? "unknown error"}`);
  if (r.submission_id) redirect(`/admin/submissions/${r.submission_id}`);
  back(r.note ?? "Nothing to import.");
}

export default async function UploadPage({ searchParams }: { searchParams: Promise<{ note?: string }> }) {
  const { note } = await searchParams;
  let orgs: { org_id: string; org_name: string }[] = [];
  let error: string | null = null;
  try {
    const res = await workerFetch("/api/contacts");
    if (!res.ok) throw new Error(`Worker returned ${res.status}`);
    orgs = ((await res.json()) as { orgs: typeof orgs }).orgs;
  } catch (e) {
    error = e instanceof Error ? e.message : "unknown error";
  }
  return (
    <main>
      <h1>Upload program data</h1>
      <p><a href="/admin">Dashboard</a> | <a href="/admin/submissions">Submissions</a> | <a href="/admin/email">Email</a></p>
      {note ? <p role="status">{note}</p> : null}
      {error ? <p role="alert">Could not load organizations: {error}</p> : null}
      <p style={{ color: "#555" }}>
        Runs the same steps as an emailed reply. Program-level files (.csv, .xlsx), documents (.docx, .txt) or pasted text.
        Nothing counts on the dashboard until the organization confirms.
      </p>
      <form action={upload} style={{ display: "grid", gap: "0.75rem", maxWidth: 560 }}>
        <label>Organization{" "}
          <select name="org_id" required defaultValue="">
            <option value="" disabled>Choose...</option>
            {orgs.map((o) => <option key={o.org_id} value={o.org_id}>{o.org_name}</option>)}
          </select>
        </label>
        <label>File <input type="file" name="file" accept=".csv,.xlsx,.docx,.txt" /></label>
        <label>Or paste text <textarea name="text" rows={8} style={{ width: "100%" }} /></label>
        <div><button type="submit">Read it</button></div>
      </form>
    </main>
  );
}
