import { HealthSchema } from "@tpw/shared";
import { Brand } from "./components/ui";

export const dynamic = "force-dynamic";

async function getHealth() {
  const base = process.env.WORKER_URL;
  if (!base) return { error: "WORKER_URL is not set" };
  try {
    const res = await fetch(`${base}/health`, { cache: "no-store" });
    return HealthSchema.parse(await res.json());
  } catch (e) {
    return { error: e instanceof Error ? e.message : "health check failed" };
  }
}

export default async function Home() {
  const health = await getHealth();
  const ok = !("error" in health);
  return (
    <main className="login">
      <div className="login-card" style={{ maxWidth: 520 }}>
        <Brand />
        <div className="panel" style={{ padding: "1.5rem" }}>
          <h1 style={{ fontSize: "1.4rem", marginBottom: "0.5rem" }}>Sam, TPW&apos;s data assistant</h1>
          <p className="hint">Staff dashboard for Transformative Programming Works.</p>
          <p><a className="btn btn-primary" href="/admin">Open the dashboard</a></p>
          <h2 style={{ fontSize: "0.95rem", margin: "1.5rem 0 0.5rem" }}>
            Worker health <span className={`badge ${ok ? "badge-good" : "badge-bad"}`}>{ok ? "reachable" : "error"}</span>
          </h2>
          <pre className="mono" style={{ margin: 0, padding: "0.75rem", background: "var(--sunken)", borderRadius: "var(--radius)", overflowX: "auto", fontSize: "0.8rem" }}>
            {JSON.stringify(health, null, 2)}
          </pre>
        </div>
      </div>
    </main>
  );
}
