import { redirect } from "next/navigation";
import { workerFetch } from "../../../lib/worker";

export const dynamic = "force-dynamic";

type Org = {
  org_id: string;
  org_name: string;
  asks_sent: number;
  contacts: { contact_id: string; name: string | null; email: string; title: string | null; is_primary: boolean; rank: number }[];
};

async function failure(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return `Failed (${res.status}): ${body.error ?? "unknown error"}`;
}

const back = (note: string): never => redirect(`/admin/contacts?note=${encodeURIComponent(note)}`);

async function importCsv(formData: FormData) {
  "use server";
  const file = formData.get("csv");
  if (!(file instanceof File) || file.size === 0) back("Choose a CSV file first.");
  const csv = await (file as File).text();
  const res = await workerFetch("/api/contacts/import", { method: "POST", body: JSON.stringify({ csv }) });
  if (!res.ok) back(await failure(res));
  const r = (await res.json()) as {
    orgsCreated: number; orgsMatched: number; contactsAdded: number; contactsUpdated: number;
    rejected: { line: number; reason: string }[];
  };
  const rejected = r.rejected.length
    ? ` Rejected ${r.rejected.length}: ${r.rejected.map((x) => (x.line ? `line ${x.line}: ${x.reason}` : x.reason)).join(" | ")}`
    : "";
  back(`Imported: ${r.orgsCreated} orgs created, ${r.orgsMatched} matched, ${r.contactsAdded} contacts added, ${r.contactsUpdated} updated.${rejected}`);
}

async function makePrimary(formData: FormData) {
  "use server";
  const body = { org_id: String(formData.get("org_id")), contact_id: String(formData.get("contact_id")) };
  const res = await workerFetch("/api/contacts/primary", { method: "POST", body: JSON.stringify(body) });
  back(res.ok ? "Primary contact updated." : await failure(res));
}

async function sendAsks(formData: FormData) {
  "use server";
  const all = formData.get("intent") === "all";
  const org_ids = formData.getAll("org_ids").map(String);
  if (!all && org_ids.length === 0) back("Select at least one org, or use Send to all.");
  const res = await workerFetch("/api/outreach/send", { method: "POST", body: JSON.stringify(all ? {} : { org_ids }) });
  if (!res.ok) back(await failure(res));
  const r = (await res.json()) as { sent: { org_id: string }[]; skipped: { org_id: string; reason: string }[] };
  const skipped = r.skipped.length ? ` Skipped: ${r.skipped.map((s) => `${s.org_id} (${s.reason})`).join("; ")}.` : "";
  back(`Sent ${r.sent.length} ask${r.sent.length === 1 ? "" : "s"}.${skipped}`);
}

export default async function ContactsPage({ searchParams }: { searchParams: Promise<{ note?: string }> }) {
  const { note } = await searchParams;
  let orgs: Org[] = [];
  let error: string | null = null;
  try {
    const res = await workerFetch("/api/contacts");
    if (!res.ok) throw new Error(`Worker returned ${res.status}`);
    orgs = ((await res.json()) as { orgs: Org[] }).orgs;
  } catch (e) {
    error = e instanceof Error ? e.message : "unknown error";
  }
  const cell = { border: "1px solid #ddd", padding: "0.35rem 0.6rem", textAlign: "left" as const };
  return (
    <main>
      <h1>Contacts and asks</h1>
      <p><a href="/admin">Dashboard</a> | <a href="/admin/outreach">Outreach</a> | <a href="/admin/email">Email</a></p>
      {note ? <p role="status">{note}</p> : null}

      <h2>Import mailing list</h2>
      <form action={importCsv}>
        <label>CSV with columns org, name, email, title <input type="file" name="csv" accept=".csv,text/csv" required /></label>{" "}
        <button type="submit">Import</button>
      </form>
      <p style={{ color: "#555" }}>
        New orgs are created. The first contact listed for an org becomes its primary (highest rank) unless it already has one.
        Re-importing is safe.
      </p>

      <h2>Orgs</h2>
      {error ? <p role="alert">Could not load contacts: {error}</p> : null}
      <form id="send" action={sendAsks}>
        <button type="submit" name="intent" value="selected">Send asks to selected</button>{" "}
        <button type="submit" name="intent" value="all">Send to all not yet asked</button>{" "}
        <span style={{ color: "#555" }}>One email per org, to its primary contact, sent individually. Orgs already asked are skipped. @example.org addresses are never emailed.</span>
      </form>
      <table style={{ borderCollapse: "collapse", marginTop: "0.75rem" }}>
        <thead>
          <tr>{["Send", "Org", "Contact", "Email", "Title", "Primary", "Asked"].map((h) => <th key={h} style={cell}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {orgs.flatMap((o) =>
            (o.contacts.length ? o.contacts : [null]).map((c, i) => (
              <tr key={`${o.org_id}-${c?.contact_id ?? "none"}`}>
                <td style={cell}>
                  {i === 0 ? <input type="checkbox" name="org_ids" value={o.org_id} form="send" aria-label={`Select ${o.org_name}`} disabled={o.asks_sent > 0} /> : null}
                </td>
                <td style={cell}>{i === 0 ? o.org_name : ""}</td>
                <td style={cell}>{c?.name ?? ""}</td>
                <td style={cell}>{c?.email ?? "no contacts"}</td>
                <td style={cell}>{c?.title ?? ""}</td>
                <td style={cell}>
                  {c?.is_primary ? (
                    "Primary"
                  ) : c ? (
                    <form action={makePrimary}>
                      <input type="hidden" name="org_id" value={o.org_id} />
                      <input type="hidden" name="contact_id" value={c.contact_id} />
                      <button type="submit">Make primary</button>
                    </form>
                  ) : null}
                </td>
                <td style={cell}>{i === 0 ? (o.asks_sent > 0 ? "Yes" : "No") : ""}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </main>
  );
}
