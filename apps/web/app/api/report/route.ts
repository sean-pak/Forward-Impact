import { renderToBuffer } from "@react-pdf/renderer";
import { buildReportContent } from "../../../lib/report";
import { ReportPdf } from "../../../lib/ReportPdf";
import { fetchDashboard, fetchOutcomes } from "../../../lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One-pager PDF. Always the public view, so suppressed cells stay suppressed. */
export async function GET(request: Request) {
  try {
    // The outcome panel is off unless asked for (?outcomes=1).
    const withOutcomes = new URL(request.url).searchParams.get("outcomes") === "1";
    const [dashboard, outcomes] = await Promise.all([fetchDashboard("public"), withOutcomes ? fetchOutcomes("public") : null]);
    const report = buildReportContent(dashboard, new Date().toISOString().slice(0, 10), outcomes);
    const pdf = await renderToBuffer(ReportPdf({ report }));
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="tpw-one-pager-${report.generatedOn}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "report failed" }, { status: 500 });
  }
}
