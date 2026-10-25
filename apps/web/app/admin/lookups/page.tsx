import { redirect } from "next/navigation";
import { workerFetch } from "../../../lib/worker";
import { RevealName } from "./RevealName";

export const dynamic = "force-dynamic";

type Row = {
  person_key: string;
  release_date: string;
  release_fiscal_year: string | null;
  is_synthetic: boolean;
  orgs: string | null;
  last_check: null | {
    check_id: string; checked_at: string; source_system: string; result: string; match_confidence: string;
    verified_by_human: boolean; returned_facility: string | null; returned_admission_date: string | null;
  };
  needs_verification: boolean;
  outcome: null | { outcome_date: string; precision: "exact" | "interval"; source: string };
};
type CheckResult = { person_key: string; status: string; result?: string; needs_verification?: boolean; outcome?: string | null; reason?: string };

const back = (note: string): never => redirect(`/admin/lookups?note=${encodeURIComponent(note)}`);

async function failure(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return `Failed (${res.status}): ${body.error ?? "unknown error"}`;
}

function summarize(results: CheckResult[]): string {
  if (results.length === 0) return "Nothing to check: everyone eligible was checked today, has a return on record, or is waiting for verification.";
  const checked = results.filter((r) => r.status === "checked");
  const count = (f: (r: CheckResult) => boolean) => checked.filter(f).length;
  const parts = [
    `${checked.length} checked`,
    `${count((r) => r.outcome === "exact" || r.outcome === "interval")} return${count((r) => Boolean(r.outcome)) === 1 ? "" : "s"} recorded`,
    `${count((r) => r.needs_verification === true)} need${count((r) => r.needs_verification === true) === 1 ? "s" : ""} verification`,
    `${count((r) => r.result === "error")} error${count((r) => r.result === "error") === 1 ? "" : "s"}`,
    `${count((r) => r.result === "blocked")} blocked`,
  ];
  const skipped = results.filter((r) => r.status === "skipped");
  return `${parts.join(", ")}.${skipped.length ? ` ${skipped.length} skipped: ${[...new Set(skipped.map((s) => s.reason))].join(" ")}` : ""}`;
}

async function checkOne(formData: FormData) {
  "use server";
  const res = await workerFetch("/api/lookups/check", { method: "POST", body: JSON.stringify({ person_keys: [String(formData.get("person_key"))] }) });
  if (!res.ok) back(await failure(res));
  back(summarize(((await res.json()) as { results: CheckResult[] }).results));
}

async function checkCohort() {
  "use server";
  const res = await workerFetch("/api/lookups/check-cohort", { method: "POST", body: "{}" });
  if (!res.ok) back(await failure(res));
  back(summarize(((await res.json()) as { results: CheckResult[] }).results));
}

async function verify(formData: FormData) {
  "use server";
  const res = await workerFetch(`/api/lookups/checks/${encodeURIComponent(String(formData.get("check_id")))}/verify`, { method: "POST", body: "{}" });
  if (!res.ok) back(await failure(res));
  const r = (await res.json()) as { outcome: string | null };
  back(r.outcome ? `Verified. Return recorded (${r.outcome} date).` : "Verified. No return to record.");
}

const RESULT_LABEL: Record<string, string> = {
  found_in_custody: "In custody",
  not_found: "Not in custody",
  multiple_matches: "Several matches",
  error: "Error",
  blocked: "Blocked by a guard",
};

export default async function LookupsPage({ searchParams }: { searchParams: Promise<{ note?: string }> }) {
  const { note } = await searchParams;
  let rows: Row[] = [];
  let max = 20;
  let realEnabled = false;
  let error: string | null = null;
  try {
    const res = await workerFetch("/api/lookups");
    if (!res.ok) throw new Error(`Worker returned ${res.status}`);
    const body = (await res.json()) as { rows: Row[]; max_per_click: number; real_locator_enabled: boolean };
    rows = body.rows;
    max = body.max_per_click;
    realEnabled = body.real_locator_enabled;
  } catch (e) {
    error = e instanceof Error ? e.message : "unknown error";
  }
  const cell = { border: "1px solid #ddd", padding: "0.35rem 0.6rem", textAlign: "left" as const };
  const utc = (t: string) => t.replace("T", " ").slice(0, 16);
  return (
    <main>
      <h1>Custody lookups</h1>
      <p><a href="/admin">Dashboard</a> | <a href="/admin/contacts">Contacts and asks</a> | <a href="/admin/submissions">Submissions</a></p>
      <p role="note" style={{ border: "1px solid #b45309", padding: "0.5rem 0.75rem", maxWidth: 760 }}>
        <strong>SIMULATED.</strong> Lookups run against the mock locator (synthetic data). The real EIT locator holds real CDCR
        data: it is {realEnabled ? "switched on but not built" : "switched off"}, and it refuses synthetic people, SYN numbers and anyone without active consent.
      </p>
      {note ? <p role="status">{note}</p> : null}
      {error ? <p role="alert">Could not load the list: {error}</p> : null}
      <p>
        {rows.length} {rows.length === 1 ? "person is" : "people are"} eligible: released after a program, with follow-up consent on file and nothing revoked.
        Names show only on hover, and each one is logged.
      </p>
      <form action={checkCohort}>
        <button type="submit" disabled={rows.length === 0}>Check cohort</button>{" "}
        <span style={{ color: "#555" }}>Checks up to {max} people not yet checked today. Click again for more.</span>
      </form>
      <table style={{ borderCollapse: "collapse", marginTop: "1rem" }}>
        <thead>
          <tr>{["Person", "Org", "Released", "Last check (UTC)", "Result", "Return", ""].map((h) => <th key={h} style={cell}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const c = r.last_check;
            return (
              <tr key={r.person_key}>
                <td style={cell}><RevealName personKey={r.person_key} />{r.is_synthetic ? "" : " (real)"}</td>
                <td style={cell}>{r.orgs ?? ""}</td>
                <td style={cell}>{r.release_date}{r.release_fiscal_year ? ` (${r.release_fiscal_year})` : ""}</td>
                <td style={cell}>{c ? `${utc(c.checked_at)} (${c.source_system === "mock_locator" ? "mock" : "real"})` : "never"}</td>
                <td style={cell}>
                  {c ? (RESULT_LABEL[c.result] ?? c.result) : ""}
                  {c?.returned_facility ? `, ${c.returned_facility}` : ""}
                  {r.needs_verification ? <strong> Needs verification</strong> : null}
                  {c?.verified_by_human ? " (verified)" : ""}
                </td>
                <td style={cell}>
                  {r.outcome ? `${r.outcome.outcome_date}${r.outcome.precision === "interval" ? " (between checks)" : ""}${r.outcome.source === "mock_locator" ? " SIMULATED" : ""}` : c ? "none on record" : ""}
                </td>
                <td style={cell}>
                  <form action={checkOne} style={{ display: "inline" }}>
                    <input type="hidden" name="person_key" value={r.person_key} />
                    <button type="submit">Check</button>
                  </form>
                  {c && r.needs_verification && c.result === "found_in_custody" ? (
                    <form action={verify} style={{ display: "inline", marginLeft: 6 }}>
                      <input type="hidden" name="check_id" value={c.check_id} />
                      <button type="submit" title="Confirm this name-only hit is the right person">Verify match</button>
                    </form>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p style={{ color: "#555" }}>
        A name-only hit is never counted as a return until someone verifies it. Several matches cannot be verified: look the person up by CDCR number.
        &ldquo;Not in custody&rdquo; means not in custody right now according to the tool; it does not prove no return.
      </p>
    </main>
  );
}
