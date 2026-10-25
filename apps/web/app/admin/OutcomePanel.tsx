import type { OutcomePanel as Panel } from "@tpw/shared";
import { benchmarkText, outcomeNotes, outcomeTable, simulatedBanner } from "../../lib/outcomes";

const cell = { border: "1px solid #ddd", padding: "0.35rem 0.6rem", textAlign: "left" as const };

/** Return-to-prison rates per release fiscal year. Every row names its source; simulated data carries a big label. */
export function OutcomePanel({ panel }: { panel: Panel }) {
  const banner = simulatedBanner(panel);
  const rows = outcomeTable(panel);
  return (
    <section>
      <h2>Return to prison, by release fiscal year</h2>
      {banner ? (
        <p role="note" style={{ background: "#b00020", color: "#fff", fontWeight: 700, padding: "0.5rem 0.75rem", borderRadius: 4 }}>
          {banner}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p style={{ color: "#555" }}>No post-program releases yet.</p>
      ) : (
        <table style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["Released", "People", "1 year", "2 years", "3 years", "Projected 3 years", "Follow-up", "Source"].map((h) => (
                <th key={h} style={cell}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.fiscalYear}>
                <td style={cell}>{r.fiscalYear}</td>
                <td style={cell}>{r.released}</td>
                <td style={cell}>{r.y1}</td>
                <td style={cell}>{r.y2}</td>
                <td style={cell}>{r.y3}</td>
                <td style={cell}>{r.projected}</td>
                <td style={cell}>{r.followUp}</td>
                <td style={{ ...cell, fontWeight: r.simulated ? 700 : 400, color: r.simulated ? "#b00020" : undefined }}>{r.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p style={{ color: "#555" }}>{benchmarkText(panel)}</p>
      {outcomeNotes(panel).map((n) => (
        <p key={n} style={{ color: "#555", fontSize: "0.85rem", margin: "0.25rem 0" }}>{n}</p>
      ))}
    </section>
  );
}
