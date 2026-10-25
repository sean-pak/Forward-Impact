import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OrgReportSchema, type ParticipantRow } from "@tpw/shared";
import { hoursNote, rateNote, show } from "../../../lib/format";
import { workerFetch } from "../../../lib/worker";

export const dynamic = "force-dynamic";

// The token is the only key to this page: keep it out of search engines and out of Referer headers.
export const metadata: Metadata = { title: "Your program report", robots: { index: false, follow: false }, referrer: "no-referrer" };

const cell = { border: "1px solid #ddd", padding: "0.35rem 0.6rem", textAlign: "left" as const };
const COMPLETED: Record<ParticipantRow["completed"], string> = { yes: "Yes", no: "No", in_progress: "In progress", unknown: "Unknown" };

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div style={{ border: "1px solid #ccc", borderRadius: 6, padding: "0.75rem 1rem", minWidth: 180 }}>
      <div style={{ fontSize: "0.85rem", color: "#555" }}>{label}</div>
      <div style={{ fontSize: "1.75rem", fontWeight: 600 }}>{value}</div>
      {note ? <div style={{ fontSize: "0.8rem", color: "#555" }}>{note}</div> : null}
    </div>
  );
}

const name = (p: ParticipantRow) => [p.first_name, p.last_name].filter(Boolean).join(" ") || "Not on file";
const attended = (p: ParticipantRow) =>
  p.sessions_attended === null ? "unknown" : `${p.sessions_attended}${p.sessions_planned === null ? "" : ` of ${p.sessions_planned}`}`;

export default async function OrgReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const res = await workerFetch(`/api/org/${encodeURIComponent(token)}/report`);
  if (res.status === 404) notFound();
  if (!res.ok) throw new Error(`Worker returned ${res.status}`);
  const r = OrgReportSchema.parse(await res.json());
  const d = r.dashboard;

  return (
    <main style={{ maxWidth: 960 }}>
      <h1>{r.org_name}: your program report</h1>
      <p style={{ color: "#555" }}>
        Private to {r.org_name}. Anyone with this link can see the names below, so please don&apos;t forward it. It shows only
        what you have confirmed with Sam, TPW&apos;s data assistant.
      </p>

      {d.cycles.length === 0 ? (
        <p>Nothing confirmed yet. When you reply YES to Sam&apos;s summary email, your numbers appear here.</p>
      ) : (
        <>
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
            <Stat label="Participants" value={show(d.participants, "count")} />
            <Stat label="Completion rate" value={show(d.completion, "rate")} note={rateNote(d.completion, d.cyclesExcludedFromCompletion)} />
            <Stat label="Participant-hours" value={show(d.hours, "hours")} note={hoursNote(d.hoursNote)} />
            <Stat label="Prisons" value={String(d.prisons.covered)} />
          </div>

          {r.grant_text ? (
            <section>
              <h2>Use this in your grant</h2>
              <p style={{ color: "#555" }}>Copy and paste. Every number comes from the counts you confirmed.</p>
              <textarea readOnly value={r.grant_text} rows={5} style={{ width: "100%", font: "inherit", padding: "0.5rem" }} />
            </section>
          ) : null}

          <h2>Classes</h2>
          <table style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["Program", "Prison", "Start", "End", "Enrolled", "Completed", "Completion means"].map((h) => (
                  <th key={h} style={cell}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.cycles.map((c) => (
                <tr key={c.cycle_id}>
                  <td style={cell}>{c.program_name}</td>
                  <td style={cell}>{c.facility_name ?? "unknown"}</td>
                  <td style={cell}>{c.start_date ?? "unknown"}</td>
                  <td style={cell}>{c.end_date ?? "unknown"}</td>
                  <td style={cell}>{c.n_enrolled ?? "unknown"}{c.n_enrolled_approx ? " (about)" : ""}</td>
                  <td style={cell}>{c.n_completed ?? "unknown"}{c.n_completed_approx ? " (about)" : ""}</td>
                  <td style={cell}>{c.completion_rule === "unstated" ? "not stated" : c.completion_rule}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>Participants</h2>
          {r.participants === null ? (
            <p role="alert">Names can&apos;t be shown right now. The counts above are still correct. TPW staff have been notified.</p>
          ) : r.participants.length === 0 ? (
            <p>Your confirmed data has counts only, with no list of people.</p>
          ) : (
            <table style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["Name", "CDCR #", "Program", "Prison", "Start", "Sessions attended", "Completed"].map((h) => (
                    <th key={h} style={cell}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.participants.map((p, i) => (
                  <tr key={i}>
                    <td style={cell}>{name(p)}</td>
                    <td style={cell}>{p.cdcr_number ?? ""}</td>
                    <td style={cell}>{p.program_name}</td>
                    <td style={cell}>{p.facility_name ?? "unknown"}</td>
                    <td style={cell}>{p.start_date ?? "unknown"}</td>
                    <td style={cell}>{attended(p)}</td>
                    <td style={cell}>{COMPLETED[p.completed]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      <p style={{ color: "#555", marginTop: "2rem" }}>Sam, TPW&apos;s data assistant (an automated assistant). Questions? Reply to any of Sam&apos;s emails.</p>
    </main>
  );
}
