import { redirect } from "next/navigation";
import { workerFetch } from "../../../lib/worker";

export const dynamic = "force-dynamic";

async function resetDemo(formData: FormData) {
  "use server";
  // The checkbox is a second click on purpose: reset deletes everything, including the vault's audit log.
  if (formData.get("sure") !== "on") redirect("/admin/demo?note=" + encodeURIComponent("Tick the box to confirm the reset."));
  const res = await workerFetch("/api/demo/reset", { method: "POST", body: JSON.stringify({ confirm: "reset" }) });
  const body = (await res.json().catch(() => ({}))) as { error?: string; cbo?: { org_name: string; email: string } | null; counts?: Record<string, number> };
  const note = res.ok
    ? `Reset done. ${body.counts?.orgs ?? 0} seed orgs, ${body.counts?.program_cycles ?? 0} cycles, ${body.counts?.identities ?? 0} scrambled people.` +
      (body.cbo ? ` ${body.cbo.org_name} is ready for ${body.cbo.email}.` : " No CBO test inbox is set (DEMO_CBO_EMAIL).")
    : `Failed (${res.status}): ${body.error ?? "unknown error"}`;
  redirect(`/admin/demo?note=${encodeURIComponent(note)}`);
}

export default async function DemoPage({ searchParams }: { searchParams: Promise<{ note?: string }> }) {
  const { note } = await searchParams;
  return (
    <main>
      <h1>Demo</h1>
      <p><a href="/admin">Dashboard</a></p>
      {note ? <p role="status">{note}</p> : null}
      <p>
        Puts the data back to the demo&apos;s starting state: the seed organizations and programs, no emails or submissions, and the CBO test
        organization with its inbox as the contact. It also clears the vault, so its access log restarts. The script is in <code>docs/DEMO.md</code>.
      </p>
      <p style={{ color: "#555" }}>Works only while the Worker has <code>DEMO_MODE = &quot;true&quot;</code>. Turn it off after the demo.</p>
      <form action={resetDemo}>
        <label>
          <input type="checkbox" name="sure" /> Delete everything and reset
        </label>{" "}
        <button type="submit">Reset demo</button>
      </form>
    </main>
  );
}
