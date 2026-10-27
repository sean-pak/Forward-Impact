import { redirect } from "next/navigation";
import { workerFetch } from "../../../lib/worker";
import { Badge, ErrorNote, Note, PageHead, SimTag, When } from "../../components/ui";
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
const RESULT_TONE: Record<string, "good" | "warn" | "bad" | "plain"> = {
  found_in_custody: "warn",
  not_found: "plain",
  multiple_matches: "warn",
  error: "bad",
  blocked: "bad",
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
  return (
    <main>
      <PageHead
        eyebrow="Data"
        title="Custody lookups"
        lede={
          <>
            {rows.length} {rows.length === 1 ? "person is" : "people are"} eligible: released after a program, with follow-up consent on file and nothing revoked.
            Names show only on hover, and each one is logged.
          </>
        }
        actions={
          <form action={checkCohort} className="inline-form">
            <span className="hint">Checks up to {max} people not yet checked today. Click again for more.</span>
            <button type="submit" className="btn-primary" disabled={rows.length === 0}>Check cohort</button>
          </form>
        }
      />
      <p role="note" className="simulated">
        SIMULATED. Lookups run against the mock locator (synthetic data). The real EIT locator holds real CDCR
        data: it is {realEnabled ? "switched on but not built" : "switched off"}, and it refuses synthetic people, SYN numbers and anyone without active consent.
      </p>
      <Note note={note} />
      {error ? <ErrorNote>Could not load the list: {error}</ErrorNote> : null}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th>Person</th><th>Org</th><th>Released</th><th>Last check (UTC)</th><th>Result</th><th>Return</th><th aria-label="Actions" /></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const c = r.last_check;
              return (
                <tr key={r.person_key}>
                  <td className="nowrap"><RevealName personKey={r.person_key} />{r.is_synthetic ? "" : <> <Badge tone="bad">real</Badge></>}</td>
                  <td className="dim">{r.orgs ?? ""}</td>
                  <td className="nowrap"><span className="when">{r.release_date}</span>{r.release_fiscal_year ? <span className="dim"> ({r.release_fiscal_year})</span> : ""}</td>
                  <td className="nowrap">{c ? <><When t={c.checked_at} short /> <span className="dim">({c.source_system === "mock_locator" ? "mock" : "real"})</span></> : <span className="dim">never</span>}</td>
                  <td>
                    <div className="inline-form" style={{ gap: "0.35rem" }}>
                      {c ? <Badge tone={RESULT_TONE[c.result] ?? "plain"}>{RESULT_LABEL[c.result] ?? c.result}</Badge> : null}
                      {c?.returned_facility ? <span className="dim">{c.returned_facility}</span> : null}
                      {r.needs_verification ? <Badge tone="warn">Needs verification</Badge> : null}
                      {c?.verified_by_human ? <Badge tone="good">verified</Badge> : null}
                    </div>
                  </td>
                  <td className="nowrap">
                    {r.outcome ? (
                      <>
                        <span className="when">{r.outcome.outcome_date}</span>
                        {r.outcome.precision === "interval" ? <span className="dim"> (between checks)</span> : ""}
                        {r.outcome.source === "mock_locator" ? <> <SimTag /></> : ""}
                      </>
                    ) : c ? <span className="dim">none on record</span> : ""}
                  </td>
                  <td className="num">
                    <div className="inline-form" style={{ justifyContent: "flex-end", gap: "0.35rem" }}>
                      <form action={checkOne}>
                        <input type="hidden" name="person_key" value={r.person_key} />
                        <button type="submit" className="btn-sm">Check</button>
                      </form>
                      {c && r.needs_verification && c.result === "found_in_custody" ? (
                        <form action={verify}>
                          <input type="hidden" name="check_id" value={c.check_id} />
                          <button type="submit" className="btn-sm btn-primary" title="Confirm this name-only hit is the right person">Verify match</button>
                        </form>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && !error ? <tr><td className="empty" colSpan={7}>Nobody is eligible yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <p className="hint" style={{ marginTop: "0.75rem", maxWidth: "80ch" }}>
        A name-only hit is never counted as a return until someone verifies it. Several matches cannot be verified: look the person up by CDCR number.
        &ldquo;Not in custody&rdquo; means not in custody right now according to the tool; it does not prove no return.
      </p>
    </main>
  );
}
