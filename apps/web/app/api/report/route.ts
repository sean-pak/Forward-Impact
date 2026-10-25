import { renderToBuffer } from "@react-pdf/renderer";
import { buildReportContent } from "../../../lib/report";
import { ReportPdf } from "../../../lib/ReportPdf";
import { fetchDashboard } from "../../../lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One-pager PDF. Always the public view, so suppressed cells stay suppressed. */
export async function GET() {
  try {
    const dashboard = await fetchDashboard("public");
    const report = buildReportContent(dashboard, new Date().toISOString().slice(0, 10));
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
