import type { OutcomePanel as Panel } from "@tpw/shared";
import { benchmarkText, outcomeNotes, outcomeTable, simulatedBanner } from "../../lib/outcomes";
import { SimTag } from "../components/ui";

/** Return-to-prison rates per release fiscal year. Every row names its source; simulated data carries a big label. */
export function OutcomePanel({ panel }: { panel: Panel }) {
  const banner = simulatedBanner(panel);
  const rows = outcomeTable(panel);
  return (
    <section className="section">
      <div className="section-head">
        <h2>Return to prison, by release fiscal year</h2>
      </div>
      {banner ? <p role="note" className="simulated">{banner}</p> : null}
      {rows.length === 0 ? (
        <p className="hint">No post-program releases yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Released</th><th className="num">People</th><th>1 year</th><th>2 years</th><th>3 years</th>
                <th>Projected 3 years</th><th>Follow-up</th><th>Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.fiscalYear}>
                  <td className="when">{r.fiscalYear}</td>
                  <td className="num">{r.released}</td>
                  <td className="nowrap">{r.y1}</td>
                  <td className="nowrap">{r.y2}</td>
                  <td className="nowrap">{r.y3}</td>
                  <td>{r.projected}</td>
                  <td className="dim">{r.followUp}</td>
                  <td>{r.simulated ? <SimTag>{r.source}</SimTag> : r.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="hint" style={{ marginTop: "0.75rem" }}>
        <p>{benchmarkText(panel)}</p>
        {outcomeNotes(panel).map((n) => <p key={n}>{n}</p>)}
      </div>
    </section>
  );
}
