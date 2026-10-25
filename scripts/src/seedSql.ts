import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import type { z } from "zod";
import { ASSUMPTIONS, BENCHMARKS, CORE_FIELDS, FACILITIES } from "@tpw/shared";

type Cell = string | number | boolean | null;

/** Render a JS value as a SQLite literal. Strings are single-quoted with '' escaping. */
export function lit(v: Cell): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`cannot write non-finite number ${v}`);
    return String(v);
  }
  return `'${v.replace(/'/g, "''")}'`;
}

export function insert(table: string, row: Record<string, Cell>): string {
  const cols = Object.keys(row);
  return `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => lit(row[c] as Cell)).join(", ")});`;
}

/** Fill the `?` placeholders of a statement with SQL literals (the scripts write .sql files, not bound queries). */
export function bindLiterals(sql: string, params: Cell[]): string {
  let i = 0;
  const out = sql.replace(/\?/g, () => {
    if (i >= params.length) throw new Error("more placeholders than params");
    return lit(params[i++] as Cell);
  });
  if (i !== params.length) throw new Error("more params than placeholders");
  return out;
}

export function csvExists(dir: string, file: string): boolean {
  return existsSync(join(dir, file));
}

/** Parse a CSV and validate every row; one bad row refuses the whole file. */
export function readCsv<S extends z.ZodTypeAny>(dir: string, file: string, schema: S): z.infer<S>[] {
  const text = readFileSync(join(dir, file), "utf8");
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  if (parsed.errors.length) {
    throw new Error(`${file}: ${parsed.errors[0]?.message} (row ${parsed.errors[0]?.row})`);
  }
  return parsed.data.map((raw, i) => {
    const r = schema.safeParse(raw);
    if (!r.success) {
      const issue = r.error.issues[0];
      throw new Error(`${file} row ${i + 2}: ${issue?.path.join(".")} ${issue?.message}`);
    }
    return r.data as z.infer<S>;
  });
}

/** Static reference data: facilities, assumptions, benchmarks, core registry fields. */
export function staticSeedSql(): string {
  const out: string[] = [];
  for (const f of FACILITIES) {
    out.push(insert("facilities", { facility_code: f.facility_code, facility_name: f.facility_name, aliases: JSON.stringify(f.aliases) }));
  }
  for (const a of ASSUMPTIONS) out.push(insert("assumptions", { ...a }));
  for (const r of BENCHMARKS) out.push(insert("benchmark_reference", { ...r }));
  for (const f of CORE_FIELDS) {
    out.push(insert("fields", { ...f, required: f.required, is_core: true, status: "active" }));
  }
  return out.join("\n") + "\n";
}
