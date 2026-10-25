import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import type { z } from "zod";
import {
  ASSUMPTIONS,
  BENCHMARKS,
  CORE_FIELDS,
  ContactRow,
  FACILITIES,
  OrgRow,
  PersonIdentityRow,
  ProgramCycleRow,
  ProgramRow,
} from "@tpw/shared";

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

const token = () => randomBytes(16).toString("hex");

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

export type FixtureSeed = { sql: string; counts: Record<string, number>; skippedIdentities: number };

/**
 * Fixture orgs, contacts, programs, and cycles from a directory laid out per
 * docs/SEED_CONTRACT.md. Identities are validated (SYN only) but not loaded:
 * the vault arrives in phase 2.
 */
export function fixtureSeedSql(dir: string): FixtureSeed {
  const orgs = readCsv(dir, "org.csv", OrgRow);
  const contacts = readCsv(dir, "contacts.csv", ContactRow);
  const programs = readCsv(dir, "program.csv", ProgramRow);
  const cycles = readCsv(dir, "program_cycle.csv", ProgramCycleRow);
  const identities = readCsv(dir, "person_identity.csv", PersonIdentityRow);

  const orgIds = new Set(orgs.map((o) => o.org_id));
  const programOrg = new Map(programs.map((p) => [p.program_id, p.org_id]));
  for (const c of contacts) if (!orgIds.has(c.org_id)) throw new Error(`contacts.csv: unknown org_id ${c.org_id}`);
  for (const p of programs) if (!orgIds.has(p.org_id)) throw new Error(`program.csv: unknown org_id ${p.org_id}`);
  for (const c of cycles) if (!programOrg.has(c.program_id)) throw new Error(`program_cycle.csv: unknown program_id ${c.program_id}`);

  const out: string[] = [];
  for (const o of orgs) {
    out.push(insert("orgs", { ...o, private_token: token(), form_token: token(), is_synthetic: true }));
  }
  for (const c of contacts) out.push(insert("contacts", { ...c, is_synthetic: true }));
  for (const p of programs) {
    const credits = p.credit_types_offered ? p.credit_types_offered.split("|") : [];
    out.push(insert("programs", { ...p, credit_types_offered: JSON.stringify(credits), is_synthetic: true }));
  }
  const facilityCodes = new Set(FACILITIES.map((f) => f.facility_code));
  for (const c of cycles) {
    if (c.facility_code && !facilityCodes.has(c.facility_code)) {
      throw new Error(`program_cycle.csv: unknown facility_code ${c.facility_code}`);
    }
    const org_id = programOrg.get(c.program_id) as string;
    const cycle_key = [org_id, c.program_id, c.facility_code ?? "unknown", c.start_date ?? "unknown"].join("|");
    out.push(insert("program_cycles", { ...c, org_id, cycle_key, is_synthetic: true }));
  }
  return {
    sql: out.join("\n") + "\n",
    counts: { orgs: orgs.length, contacts: contacts.length, programs: programs.length, program_cycles: cycles.length },
    skippedIdentities: identities.length,
  };
}
