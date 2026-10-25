import { HealthSchema } from "@tpw/shared";

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
  return (
    <main>
      <h1>Sam, TPW&apos;s data assistant</h1>
      <h2>Worker health</h2>
      <pre>{JSON.stringify(health, null, 2)}</pre>
    </main>
  );
}
