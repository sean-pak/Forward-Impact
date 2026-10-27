import type { Metric } from "@tpw/shared";
import { SUPPRESSED } from "../../lib/format";

/** The "S" mark plus name. Used in the admin sidebar, the login card and the CBO pages. */
export function Brand({ href }: { href?: string }) {
  const inner = (
    <>
      <span className="brand-mark" aria-hidden>S</span>
      <span className="brand-name">
        Sam<span className="brand-sub">TPW&apos;s data assistant</span>
      </span>
    </>
  );
  return href ? <a className="brand" href={href}>{inner}</a> : <div className="brand">{inner}</div>;
}

export function PageHead({ eyebrow, title, lede, actions }: { eyebrow?: string; title: React.ReactNode; lede?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <header className="page-head">
      <div>
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h1>{title}</h1>
        {lede ? <p className="lede">{lede}</p> : null}
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </header>
  );
}

export function Section({ title, aside, children }: { title: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>{title}</h2>
        {aside ? <div className="hint">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Numerator over denominator as a small bar. Only drawn when both counts exist and the cell is not suppressed. */
export function Ratio({ m, inline = false }: { m: Metric; inline?: boolean }) {
  if (m.suppressed || m.value === null || !m.denominator) return null;
  const pct = Math.max(0, Math.min(100, (100 * (m.numerator ?? 0)) / m.denominator));
  return (
    <span className={inline ? "ratio-inline" : "ratio"} aria-hidden>
      <span className="ratio-track"><span className="ratio-fill" style={{ display: "block", width: `${pct}%` }} /></span>
    </span>
  );
}

export function Stat({ label, value, note, metric }: { label: string; value: string; note?: React.ReactNode; metric?: Metric }) {
  const quiet = value === SUPPRESSED || value === "n/a";
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${value === SUPPRESSED ? " is-suppressed" : quiet ? " is-empty" : ""}`}>{value}</div>
      {metric ? <Ratio m={metric} /> : null}
      {note ? <div className="stat-note">{note}</div> : null}
    </div>
  );
}

/** Flash message from a `?note=` redirect. A message starting with "Failed" is shown as an error. */
export function Note({ note }: { note?: string }) {
  if (!note) return null;
  const tone = /^(Failed|Could not)/.test(note) ? "notice-error" : /^(Tick|Choose|Select)/.test(note) ? "notice-warn" : "notice-ok";
  return (
    <p role="status" className={`notice ${tone}`}>
      {note}
    </p>
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return <p role="alert" className="notice notice-error">{children}</p>;
}

type Tone = "good" | "warn" | "bad" | "plain";
export function Badge({ tone = "plain", children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>;
}

/** Status words from the Worker mapped to a tone. Unknown words stay neutral. */
export function statusTone(status: string): Tone {
  if (/confirm|active|done|sent|replied/.test(status)) return "good";
  if (/needs|pending|review|clarif|await/.test(status)) return "warn";
  if (/fail|error|reject|block|retired/.test(status)) return "bad";
  return "plain";
}

/** Hazard-tape tag for simulated data. Text defaults to SIMULATED; callers may pass a fuller source label. */
export function SimTag({ children = "SIMULATED" }: { children?: React.ReactNode }) {
  return <span className="sim-tag">{children}</span>;
}

/** ISO timestamp to "YYYY-MM-DD HH:MM:SS" (UTC), set in mono. */
export function When({ t, short = false }: { t: string | null | undefined; short?: boolean }) {
  if (!t) return null;
  return <span className="when">{t.replace("T", " ").slice(0, short ? 16 : 19)}</span>;
}

export function Unknown({ children = "unknown" }: { children?: React.ReactNode }) {
  return <span className="unknown">{children}</span>;
}
