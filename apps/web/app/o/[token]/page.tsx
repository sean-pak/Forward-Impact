import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OrgReportSchema, type ParticipantRow } from "@tpw/shared";
import { hoursNote, rateNote, show } from "../../../lib/format";
import { workerFetch } from "../../../lib/worker";
import { PublicFrame } from "../../components/PublicFrame";
import { Badge, ErrorNote, PageHead, Section, Stat, Unknown } from "../../components/ui";

export const dynamic = "force-dynamic";

// The token is the only key to this page: keep it out of search engines and out of Referer headers.
export const metadata: Metadata = { title: "Your program report", robots: { index: false, follow: false }, referrer: "no-referrer" };

const COMPLETED: Record<ParticipantRow["completed"], string> = { yes: "Yes", no: "No", in_progress: "In progress", unknown: "Unknown" };
const COMPLETED_TONE: Record<ParticipantRow["completed"], "good" | "warn" | "plain"> = { yes: "good", no: "plain", in_progress: "warn", unknown: "plain" };

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
    <PublicFrame wide>
      <PageHead
        eyebrow="Private program report"
        title={<>{r.org_name}: your program report</>}
        lede={
          <>
            Private to {r.org_name}. Anyone with this link can see the names below, so please don&apos;t forward it. It shows only
            what you have confirmed with Sam, TPW&apos;s data assistant.
          </>
        }
      />

      {d.cycles.length === 0 ? (
        <div className="panel"><p style={{ margin: 0 }}>Nothing confirmed yet. When you reply YES to Sam&apos;s summary email, your numbers appear here.</p></div>
      ) : (
        <>
          <div className="stats">
            <Stat label="Participants" value={show(d.participants, "count")} />
            <Stat label="Completion rate" value={show(d.completion, "rate")} metric={d.completion} note={rateNote(d.completion, d.cyclesExcludedFromCompletion)} />
            <Stat label="Participant-hours" value={show(d.hours, "hours")} note={hoursNote(d.hoursNote)} />
            <Stat label="Prisons" value={String(d.prisons.covered)} />
          </div>

          {r.grant_text ? (
            <Section title="Use this in your grant" aside="Copy and paste. Every number comes from the counts you confirmed.">
              <textarea readOnly value={r.grant_text} rows={5} style={{ width: "100%", padding: "0.75rem", background: "var(--surface)" }} />
            </Section>
          ) : null}

          <Section title="Classes">
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Program</th><th>Prison</th><th>Start</th><th>End</th><th className="num">Enrolled</th><th className="num">Completed</th><th>Completion means</th></tr>
                </thead>
                <tbody>
                  {d.cycles.map((c) => (
                    <tr key={c.cycle_id}>
                      <td>{c.program_name}</td>
                      <td>{c.facility_name ?? <Unknown />}</td>
                      <td className="when">{c.start_date ?? <Unknown />}</td>
                      <td className="when">{c.end_date ?? <Unknown />}</td>
                      <td className="num">{c.n_enrolled ?? <Unknown />}{c.n_enrolled_approx ? <span className="approx"> (about)</span> : ""}</td>
                      <td className="num">{c.n_completed ?? <Unknown />}{c.n_completed_approx ? <span className="approx"> (about)</span> : ""}</td>
                      <td className="dim">{c.completion_rule === "unstated" ? "not stated" : c.completion_rule}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Participants">
            {r.participants === null ? (
              <ErrorNote>Names can&apos;t be shown right now. The counts above are still correct. TPW staff have been notified.</ErrorNote>
            ) : r.participants.length === 0 ? (
              <p className="hint">Your confirmed data has counts only, with no list of people.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>Name</th><th>CDCR #</th><th>Program</th><th>Prison</th><th>Start</th><th>Sessions attended</th><th>Completed</th></tr>
                  </thead>
                  <tbody>
                    {r.participants.map((p, i) => (
                      <tr key={i}>
                        <td>{name(p)}</td>
                        <td className="when">{p.cdcr_number ?? ""}</td>
                        <td>{p.program_name}</td>
                        <td>{p.facility_name ?? <Unknown />}</td>
                        <td className="when">{p.start_date ?? <Unknown />}</td>
                        <td>{attended(p)}</td>
                        <td><Badge tone={COMPLETED_TONE[p.completed]}>{COMPLETED[p.completed]}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
      <p className="public-foot">Sam, TPW&apos;s data assistant (an automated assistant). Questions? Reply to any of Sam&apos;s emails.</p>
    </PublicFrame>
  );
}
