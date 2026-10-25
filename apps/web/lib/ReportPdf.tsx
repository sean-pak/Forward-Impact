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
  foot: { marginTop: 18, fontSize: 8, color: "#444" },
  footItem: { marginBottom: 3 },
});

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
        <View style={s.box}>
          <Text style={s.boxText}>{report.recidivismContext}</Text>
        </View>
        <View style={s.foot}>
          {report.footnotes.map((f, i) => (
            <Text key={i} style={s.footItem}>
              {i + 1}. {f}
            </Text>
          ))}
        </View>
      </Page>
    </Document>
  );
}
