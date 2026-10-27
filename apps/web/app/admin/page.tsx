import type { View } from "@tpw/shared";
import { hoursNote, rateNote, show } from "../../lib/format";
import { fetchDashboard, fetchOutcomes } from "../../lib/worker";
import { ErrorNote, PageHead, Ratio, Section, Stat, Unknown } from "../components/ui";
import { OutcomePanel } from "./OutcomePanel";

export const dynamic = "force-dynamic";

const orUnknown = (v: string | number | null) => (v === null ? <Unknown /> : v);

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const view: View = (await searchParams).view === "public" ? "public" : "staff";
  let summary;
  try {
    summary = await fetchDashboard(view);
  } catch (e) {
    return (
      <main>
        <PageHead eyebrow="Data" title="Dashboard" />
        <ErrorNote>Could not load the summary: {e instanceof Error ? e.message : "unknown error"}</ErrorNote>
      </main>
    );
  }
  // The outcome panel failing must not take the rest of the dashboard down.
  const outcomes = await fetchOutcomes(view).then(
    (panel) => ({ panel, error: null }),
    (e: unknown) => ({ panel: null, error: e instanceof Error ? e.message : "unknown error" }),
  );
  const staff = view === "staff";
  return (
    <main>
      <PageHead
        eyebrow="Data"
        title="Dashboard"
        lede={<>Confirmed cycles only. {staff ? "Staff view, not suppressed." : "Public view: small cells are suppressed."}</>}
        actions={
          <>
            <div className="segmented" role="group" aria-label="View">
              <a href="/admin" aria-current={staff ? "page" : undefined}>Staff view</a>
              <a href="/admin?view=public" aria-current={staff ? undefined : "page"}>Public view</a>
            </div>
            <a className="btn" href="/api/report">Download one-pager (PDF)</a>
            <a className="btn btn-primary" href="/api/report?outcomes=1">One-pager with outcomes (PDF)</a>
          </>
        }
      />

      <div className="stats">
        <Stat label="Participants" value={show(summary.participants, "count")} />
        <Stat
          label="Completion rate"
          value={show(summary.completion, "rate")}
          metric={summary.completion}
          note={rateNote(summary.completion, summary.cyclesExcludedFromCompletion)}
        />
        <Stat label="Participant-hours" value={show(summary.hours, "hours")} note={hoursNote(summary.hoursNote)} />
        <Stat
          label="Prisons covered"
          value={`${summary.prisons.covered} of ${summary.prisons.total}`}
          metric={{ value: summary.prisons.total ? summary.prisons.covered / summary.prisons.total : null, numerator: summary.prisons.covered, denominator: summary.prisons.total, suppressed: false, isEstimate: false }}
          note={`Program deserts (no confirmed cycle): ${summary.deserts.length} of ${summary.prisons.total} facilities.`}
        />
      </div>

      <Section title="By facility">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Facility</th>
                <th className="num">Participants</th>
                <th>Completion</th>
                <th className="num">Hours</th>
                {staff ? <th className="num">Orgs</th> : null}
              </tr>
            </thead>
            <tbody>
              {summary.facilities.map((f) => (
                <tr key={f.facility_code}>
                  <td>{f.facility_name}</td>
                  <td className="num">{show(f.participants, "count")}</td>
                  <td className="nowrap">
                    <span className="ratio-inline">
                      <Ratio m={f.completion} inline />
                      <span>
                        {show(f.completion, "rate")}
                        {!f.completion.suppressed && f.completion.denominator ? (
                          <span className="dim"> ({f.completion.numerator} of {f.completion.denominator})</span>
                        ) : null}
                      </span>
                    </span>
                  </td>
                  <td className="num">{show(f.hours, "hours")}</td>
                  {staff ? <td className="num">{f.orgs}</td> : null}
                </tr>
              ))}
              {summary.facilities.length === 0 ? <tr><td className="empty" colSpan={staff ? 5 : 4}>No confirmed cycles yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </Section>

      {outcomes.panel ? <OutcomePanel panel={outcomes.panel} /> : <Section title="Return to prison"><ErrorNote>Could not load outcomes: {outcomes.error}</ErrorNote></Section>}

      {staff ? (
        <Section title="Cycles" aside={<><span className="approx">~</span> marks an approximate count.</>}>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Org</th><th>Program</th><th>Facility</th><th>Start</th><th>End</th>
                  <th className="num">Enrolled</th><th className="num">Completed</th><th>Completion rule</th>
                </tr>
              </thead>
              <tbody>
                {summary.cycles.map((c) => (
                  <tr key={c.cycle_id}>
                    <td>{c.org_name}</td>
                    <td>{c.program_name}</td>
                    <td>{orUnknown(c.facility_name)}</td>
                    <td className="when">{orUnknown(c.start_date)}</td>
                    <td className="when">{orUnknown(c.end_date)}</td>
                    <td className="num">{orUnknown(c.n_enrolled)}{c.n_enrolled_approx ? <span className="approx"> ~</span> : ""}</td>
                    <td className="num">{orUnknown(c.n_completed)}{c.n_completed_approx ? <span className="approx"> ~</span> : ""}</td>
                    <td className="dim">{c.completion_rule}</td>
                  </tr>
                ))}
                {summary.cycles.length === 0 ? <tr><td className="empty" colSpan={8}>No confirmed cycles yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}
    </main>
  );
}
