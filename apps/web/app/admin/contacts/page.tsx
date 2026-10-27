import { redirect } from "next/navigation";
import { workerFetch } from "../../../lib/worker";
import { Badge, ErrorNote, Note, PageHead, Section } from "../../components/ui";

export const dynamic = "force-dynamic";

type Org = {
  org_id: string;
  org_name: string;
  asks_sent: number;
  private_token: string | null;
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
  const asked = orgs.filter((o) => o.asks_sent > 0).length;
  return (
    <main>
      <PageHead
        eyebrow="Outreach"
        title="Contacts and asks"
        lede={orgs.length ? `${orgs.length} orgs, ${asked} asked so far.` : undefined}
      />
      <Note note={note} />

      <div className="panel">
        <h2 style={{ marginBottom: "0.75rem" }}>Import mailing list</h2>
        <form action={importCsv} className="inline-form">
          <label className="field" style={{ flex: 1, minWidth: 260 }}>
            <span>CSV with columns org, name, email, title</span>
            <input type="file" name="csv" accept=".csv,text/csv" required />
          </label>
          <button type="submit" style={{ alignSelf: "end" }}>Import</button>
        </form>
        <p className="hint" style={{ margin: "0.75rem 0 0" }}>
          New orgs are created. The first contact listed for an org becomes its primary (highest rank) unless it already has one.
          Re-importing is safe.
        </p>
      </div>

      <Section title="Orgs" aside="One email per org, to its primary contact, sent individually. Orgs already asked are skipped. @example.org addresses are never emailed.">
        {error ? <ErrorNote>Could not load contacts: {error}</ErrorNote> : null}
        <form id="send" action={sendAsks} className="inline-form" style={{ marginBottom: "0.75rem" }}>
          <button type="submit" name="intent" value="selected" className="btn-primary">Send asks to selected</button>
          <button type="submit" name="intent" value="all">Send to all not yet asked</button>
        </form>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Send</th><th>Org</th><th>Contact</th><th>Email</th><th>Title</th><th>Primary</th><th>Asked</th></tr>
            </thead>
            <tbody>
              {orgs.flatMap((o) =>
                (o.contacts.length ? o.contacts : [null]).map((c, i) => (
                  <tr key={`${o.org_id}-${c?.contact_id ?? "none"}`} className={i === 0 ? "group-start" : undefined}>
                    <td>
                      {i === 0 ? <input type="checkbox" name="org_ids" value={o.org_id} form="send" aria-label={`Select ${o.org_name}`} disabled={o.asks_sent > 0} /> : null}
                    </td>
                    <td>
                      {i === 0 ? <strong style={{ fontWeight: 600 }}>{o.org_name}</strong> : ""}
                      {i === 0 && o.private_token ? <> <a href={`/o/${o.private_token}`} className="hint">(report)</a></> : null}
                    </td>
                    <td>{c?.name ?? ""}</td>
                    <td className={c ? undefined : "dim"}>{c?.email ?? "no contacts"}</td>
                    <td className="dim">{c?.title ?? ""}</td>
                    <td>
                      {c?.is_primary ? (
                        <Badge tone="good">Primary</Badge>
                      ) : c ? (
                        <form action={makePrimary}>
                          <input type="hidden" name="org_id" value={o.org_id} />
                          <input type="hidden" name="contact_id" value={c.contact_id} />
                          <button type="submit" className="btn-sm">Make primary</button>
                        </form>
                      ) : null}
                    </td>
                    <td>{i === 0 ? (o.asks_sent > 0 ? <Badge tone="good">Yes</Badge> : <Badge>No</Badge>) : ""}</td>
                  </tr>
                )),
              )}
              {orgs.length === 0 && !error ? <tr><td className="empty" colSpan={7}>No orgs yet. Import a mailing list above.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </Section>
    </main>
  );
}
