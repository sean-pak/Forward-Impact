import * as XLSX from "xlsx";
import Papa from "papaparse";
import type { Grid } from "@tpw/shared";

/** CSV or XLSX bytes -> a grid of trimmed strings (first sheet only; dates as ISO text). */
export function readGrid(filename: string, bytes: Uint8Array): Grid {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    const wb = XLSX.read(bytes, { type: "array", cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]!];
    if (!sheet) return [];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, blankrows: false, defval: "" });
    return rows.map((r) => r.map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").trim())));
  }
  const text = new TextDecoder().decode(bytes).replace(/^﻿/, "");
  return Papa.parse<string[]>(text, { skipEmptyLines: "greedy" }).data.map((r) => r.map((c) => (c ?? "").trim()));
}
