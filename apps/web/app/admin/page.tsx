import type { View } from "@tpw/shared";
import { hoursNote, rateNote, show } from "../../lib/format";
import { fetchDashboard, fetchOutcomes } from "../../lib/worker";
import { OutcomePanel } from "./OutcomePanel";

export const dynamic = "force-dynamic";

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div style={{ border: "1px solid #ccc", borderRadius: 6, padding: "0.75rem 1rem", minWidth: 180 }}>
      <div style={{ fontSize: "0.85rem", color: "#555" }}>{label}</div>
      <div style={{ fontSize: "1.75rem", fontWeight: 600 }}>{value}</div>
      {note ? <div style={{ fontSize: "0.8rem", color: "#555" }}>{note}</div> : null}
    </div>
  );
}

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const view: View = (await searchParams).view === "public" ? "public" : "staff";
  let summary;
  try {
    summary = await fetchDashboard(view);
  } catch (e) {
    return (
      <main>
        <h1>Dashboard</h1>
        <p role="alert">Could not load the summary: {e instanceof Error ? e.message : "unknown error"}</p>
      </main>
    );
  }
  // The outcome panel failing must not take the rest of the dashboard down.
  const outcomes = await fetchOutcomes(view).then(
    (panel) => ({ panel, error: null }),
    (e: unknown) => ({ panel: null, error: e instanceof Error ? e.message : "unknown error" }),
  );
  const cell = { border: "1px solid #ddd", padding: "0.35rem 0.6rem", textAlign: "left" as const };
  return (
    <main>
      <h1>Dashboard</h1>
      <p style={{ color: "#555" }}>
        Confirmed cycles only. {view === "public" ? "Public view: small cells are suppressed." : "Staff view, not suppressed."}{" "}
        <a href="/admin">Staff view</a> | <a href="/admin?view=public">Public view</a> | <a href="/api/report">Download one-pager (PDF)</a> | <a href="/api/report?outcomes=1">One-pager with outcomes (PDF)</a> | <a href="/admin/contacts">Contacts and asks</a> | <a href="/admin/outreach">Outreach</a> | <a href="/admin/email">Email</a> | <a href="/admin/upload">Upload</a> | <a href="/admin/submissions">Submissions</a> | <a href="/admin/lookups">Lookups</a> | <a href="/admin/fields">Fields</a> | <a href="/admin/demo">Demo</a>
      </p>
      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
        <Stat label="Participants" value={show(summary.participants, "count")} />
        <Stat label="Completion rate" value={show(summary.completion, "rate")} note={rateNote(summary.completion, summary.cyclesExcludedFromCompletion)} />
        <Stat
          label="Participant-hours"
          value={show(summary.hours, "hours")}
          note={hoursNote(summary.hoursNote)}
        />
        <Stat label="Prisons covered" value={`${summary.prisons.covered} of ${summary.prisons.total}`} />
      </div>
      <h2>By facility</h2>
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {["Facility", "Participants", "Completion", "Hours", ...(view === "staff" ? ["Orgs"] : [])].map((h) => (
              <th key={h} style={cell}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {summary.facilities.map((f) => (
            <tr key={f.facility_code}>
              <td style={cell}>{f.facility_name}</td>
              <td style={cell}>{show(f.participants, "count")}</td>
              <td style={cell}>
                {show(f.completion, "rate")}
                {!f.completion.suppressed && f.completion.denominator
                  ? ` (${f.completion.numerator} of ${f.completion.denominator})`
                  : ""}
              </td>
              <td style={cell}>{show(f.hours, "hours")}</td>
              {view === "staff" ? <td style={cell}>{f.orgs}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ color: "#555" }}>
        Program deserts (no confirmed cycle): {summary.deserts.length} of {summary.prisons.total} facilities.
      </p>
      {outcomes.panel ? <OutcomePanel panel={outcomes.panel} /> : <p role="alert">Could not load outcomes: {outcomes.error}</p>}
      {view === "staff" ? (
        <>
      <h2>Cycles</h2>
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {["Org", "Program", "Facility", "Start", "End", "Enrolled", "Completed", "Completion rule"].map((h) => (
              <th key={h} style={cell}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {summary.cycles.map((c) => (
            <tr key={c.cycle_id}>
              <td style={cell}>{c.org_name}</td>
              <td style={cell}>{c.program_name}</td>
              <td style={cell}>{c.facility_name ?? "unknown"}</td>
              <td style={cell}>{c.start_date ?? "unknown"}</td>
              <td style={cell}>{c.end_date ?? "unknown"}</td>
              <td style={cell}>{c.n_enrolled ?? "unknown"}{c.n_enrolled_approx ? " ~" : ""}</td>
              <td style={cell}>{c.n_completed ?? "unknown"}{c.n_completed_approx ? " ~" : ""}</td>
              <td style={cell}>{c.completion_rule}</td>
            </tr>
          ))}
        </tbody>
      </table>
        </>
      ) : null}
    </main>
  );
}
