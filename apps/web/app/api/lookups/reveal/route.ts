import { workerFetch } from "../../../../lib/worker";

// Session-protected by proxy.ts. The browser asks for one name at a time; the Worker re-identifies it and writes the audit row.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { person_key?: unknown } | null;
  if (!body || typeof body.person_key !== "string" || !body.person_key) return Response.json({ error: "person_key is required" }, { status: 400 });
  const res = await workerFetch("/api/lookups/reveal", { method: "POST", body: JSON.stringify({ person_key: body.person_key }) });
  return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
