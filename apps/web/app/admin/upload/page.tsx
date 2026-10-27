import { redirect } from "next/navigation";
import { workerFetch } from "../../../lib/worker";
import { ErrorNote, Note, PageHead } from "../../components/ui";

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
      <PageHead
        eyebrow="Data"
        title="Upload program data"
        lede="Runs the same steps as an emailed reply. Nothing counts on the dashboard until the organization confirms."
      />
      <Note note={note} />
      {error ? <ErrorNote>Could not load organizations: {error}</ErrorNote> : null}
      <div className="panel" style={{ maxWidth: 680 }}>
        <form action={upload} className="form">
          <label className="field">
            <span>Organization</span>
            <select name="org_id" required defaultValue="">
              <option value="" disabled>Choose...</option>
              {orgs.map((o) => <option key={o.org_id} value={o.org_id}>{o.org_name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>File</span>
            <input type="file" name="file" accept=".csv,.xlsx,.docx,.txt" />
            <span className="field-help">Program-level files (.csv, .xlsx) or documents (.docx, .txt).</span>
          </label>
          <div className="divider">or</div>
          <label className="field">
            <span>Or paste text</span>
            <textarea name="text" rows={8} />
          </label>
          <div><button type="submit" className="btn-primary">Read it</button></div>
        </form>
      </div>
    </main>
  );
}
