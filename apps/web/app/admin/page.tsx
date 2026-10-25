import type { Count, Hours, Rate } from "@tpw/shared";
import { fetchAdminSummary } from "../../lib/worker";

export const dynamic = "force-dynamic";

const fmt = new Intl.NumberFormat("en-US");
const approx = (isEstimate: boolean) => (isEstimate ? " (approx.)" : "");

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div style={{ border: "1px solid #ccc", borderRadius: 6, padding: "0.75rem 1rem", minWidth: 180 }}>
      <div style={{ fontSize: "0.85rem", color: "#555" }}>{label}</div>
      <div style={{ fontSize: "1.75rem", fontWeight: 600 }}>{value}</div>
      {note ? <div style={{ fontSize: "0.8rem", color: "#555" }}>{note}</div> : null}
    </div>
  );
}

function completionText(r: Rate): { value: string; note: string } {
  if (r.value === null) return { value: "n/a", note: "No cycle has a stated completion rule and both counts." };
  const excluded = r.cyclesExcluded ? `; ${r.cyclesExcluded} cycle(s) left out (rule unstated or count missing)` : "";
  return {
    value: `${Math.round(r.value * 100)}%${approx(r.isEstimate)}`,
    note: `${fmt.format(r.numerator)} of ${fmt.format(r.denominator)} completed${excluded}`,
  };
}

function hoursNote(h: Hours): string {
  const parts = [];
  if (h.cyclesDelivered) parts.push(`${h.cyclesDelivered} delivered`);
  if (h.cyclesPlanned) parts.push(`${h.cyclesPlanned} planned (hours per participant × enrolled)`);
  if (h.cyclesUnknown) parts.push(`${h.cyclesUnknown} unknown`);
  return parts.join(", ");
}

export default async function AdminPage() {
  let summary;
  try {
    summary = await fetchAdminSummary();
  } catch (e) {
    return (
      <main>
        <h1>Dashboard</h1>
        <p role="alert">Could not load the summary: {e instanceof Error ? e.message : "unknown error"}</p>
      </main>
    );
  }
  const completion = completionText(summary.completion);
  const p: Count = summary.participants;
  const cell = { border: "1px solid #ddd", padding: "0.35rem 0.6rem", textAlign: "left" as const };
  return (
    <main>
      <h1>Dashboard</h1>
      <p style={{ color: "#555" }}>Confirmed cycles only. Staff view, not suppressed.</p>
      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
        <Stat label="Participants" value={`${fmt.format(p.value)}${approx(p.isEstimate)}`} />
        <Stat label="Completion rate" value={completion.value} note={completion.note} />
        <Stat
          label="Participant-hours"
          value={`${fmt.format(Math.round(summary.hours.value))}${approx(summary.hours.isEstimate)}`}
          note={hoursNote(summary.hours)}
        />
        <Stat label="Prisons covered" value={`${summary.prisons.covered} of ${summary.prisons.total}`} />
      </div>
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
    </main>
  );
}
