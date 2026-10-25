import { DashboardSchema, type Dashboard, type View } from "@tpw/shared";

/** Server-side only: the web app reaches the Worker with the bearer secret, never from the browser. */
export async function fetchDashboard(view: View): Promise<Dashboard> {
  const base = process.env.WORKER_URL;
  const secret = process.env.API_SECRET;
  if (!base || !secret) throw new Error("WORKER_URL and API_SECRET must be set");
  const res = await fetch(`${base}/api/admin/summary?view=${view}`, {
    headers: { Authorization: `Bearer ${secret}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Worker returned ${res.status}`);
  return DashboardSchema.parse(await res.json());
}

/** Authenticated call to any other Worker `/api/*` route. Server-side only. */
export async function workerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = process.env.WORKER_URL;
  const secret = process.env.API_SECRET;
  if (!base || !secret) throw new Error("WORKER_URL and API_SECRET must be set");
  return fetch(`${base}${path}`, {
    ...init,
    // A FormData body sets its own multipart Content-Type.
    headers: {
      ...init.headers,
      Authorization: `Bearer ${secret}`,
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
    },
    cache: "no-store",
  });
}
