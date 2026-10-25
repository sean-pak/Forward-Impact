import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ReportContent } from "./report";

const s = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: "Helvetica", color: "#111" },
  title: { fontSize: 20, fontFamily: "Helvetica-Bold" },
  sub: { color: "#555", marginTop: 4, marginBottom: 18 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  card: { width: "48%", border: "1 solid #ccc", borderRadius: 4, padding: 10 },
  label: { color: "#555", fontSize: 9 },
  value: { fontSize: 22, fontFamily: "Helvetica-Bold", marginVertical: 2 },
  note: { color: "#555", fontSize: 8 },
  para: { marginTop: 14 },
  box: { marginTop: 14, padding: 10, border: "1 dashed #999" },
  boxText: { color: "#555" },
  banner: { marginTop: 14, padding: 6, backgroundColor: "#b00020", color: "#fff", fontFamily: "Helvetica-Bold", fontSize: 10 },
  h2: { marginTop: 14, fontFamily: "Helvetica-Bold", fontSize: 11 },
  tRow: { flexDirection: "row", borderBottom: "0.5 solid #ccc", paddingVertical: 2 },
  tHead: { fontFamily: "Helvetica-Bold", fontSize: 7 },
  tCell: { fontSize: 7, paddingRight: 3 },
  foot: { marginTop: 18, fontSize: 8, color: "#444" },
  footItem: { marginBottom: 3 },
});

const COLS = [
  { key: "fiscalYear", label: "Released", w: "9%" },
  { key: "released", label: "People", w: "8%" },
  { key: "y1", label: "1 year", w: "14%" },
  { key: "y2", label: "2 years", w: "14%" },
  { key: "y3", label: "3 years", w: "14%" },
  { key: "projected", label: "Projected 3 years", w: "20%" },
  { key: "followUp", label: "Follow-up", w: "9%" },
  { key: "source", label: "Source", w: "12%" },
] as const;

export function ReportPdf({ report }: { report: ReportContent }) {
  return (
    <Document title={report.title}>
      <Page size="LETTER" style={s.page}>
        <Text style={s.title}>{report.title}</Text>
        <Text style={s.sub}>Confirmed program data from partner organizations. Generated {report.generatedOn}.</Text>
        <View style={s.grid}>
          {report.stats.map((st) => (
            <View key={st.label} style={s.card} wrap={false}>
              <Text style={s.label}>{st.label}</Text>
              <Text style={s.value}>{st.value}</Text>
              {st.note ? <Text style={s.note}>{st.note}</Text> : null}
            </View>
          ))}
        </View>
        <Text style={s.para}>{report.deserts}</Text>
        {report.outcomes ? (
          <View>
            {report.outcomes.banner ? <Text style={s.banner}>{report.outcomes.banner}</Text> : null}
            <Text style={s.h2}>Return to prison, by release fiscal year</Text>
            <View style={s.tRow}>
              {COLS.map((c) => (
                <Text key={c.key} style={[s.tCell, s.tHead, { width: c.w }]}>{c.label}</Text>
              ))}
            </View>
            {report.outcomes.rows.map((r) => (
              <View key={r.fiscalYear} style={s.tRow} wrap={false}>
                {COLS.map((c) => (
                  <Text key={c.key} style={[s.tCell, { width: c.w }]}>{r[c.key]}</Text>
                ))}
              </View>
            ))}
            <Text style={[s.note, { marginTop: 6 }]}>{report.outcomes.benchmark}</Text>
          </View>
        ) : (
          <View style={s.box}>
            <Text style={s.boxText}>{report.recidivismContext}</Text>
          </View>
        )}
        <View style={s.foot}>
          {[...report.footnotes, ...(report.outcomes?.notes ?? [])].map((f, i) => (
            <Text key={i} style={s.footItem}>
              {i + 1}. {f}
            </Text>
          ))}
        </View>
      </Page>
    </Document>
  );
}
