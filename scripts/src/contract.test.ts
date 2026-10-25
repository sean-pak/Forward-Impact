import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTables, readMigrations } from "./migrations";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const md = readFileSync(join(root, "docs/SEED_CONTRACT.md"), "utf8");
const tables = parseTables(readMigrations(join(root, "apps/worker/migrations/analytics")));

type Section = { file: string; table: string; columns: string[] };

function sections(): Section[] {
  const out: Section[] = [];
  for (const block of md.split(/^### /m).slice(1)) {
    const file = block.match(/^(\S+\.csv)/)?.[1];
    const table = block.match(/Loads into: `(\w+)`/)?.[1];
    if (!file || !table) continue;
    const columns = [...block.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1] as string);
    out.push({ file, table, columns });
  }
  return out;
}

// Columns the loader fills in or computes, so the CSV does not carry them.
const LOADER_FILLED = new Set([
  "is_synthetic", "created_at", "submission_id", "private_token", "form_token",
  "org_id", "cycle_key", "credit_id", "n_enrolled_approx", "n_completed_approx",
  "total_course_hours_delivered_approx", "extra",
]);

describe("SEED_CONTRACT.md", () => {
  const found = sections();

  it("documents every seedable file", () => {
    expect(found.map((s) => s.file).sort()).toEqual([
      "consent.csv", "contacts.csv", "credit_award.csv", "custody_status.csv", "enrollment.csv",
      "follow_up_status.csv", "org.csv", "outcome_event.csv", "person_attributes.csv",
      "program.csv", "program_cycle.csv", "release_event.csv", "session.csv", "session_attendance.csv",
    ]);
  });

  it.each(found.map((s) => [s.file, s] as const))("%s matches its table", (_file, s) => {
    const table = tables.find((t) => t.name === s.table);
    expect(table, `table ${s.table}`).toBeDefined();
    const cols = new Set(table!.columns);
    // person_ref stands in for person_key in CSVs
    const asDb = s.columns.map((c) => (c === "person_ref" ? "person_key" : c));
    for (const c of asDb) expect(cols.has(c), `${s.file}: ${c} is not a column of ${s.table}`).toBe(true);
    for (const c of cols) {
      if (LOADER_FILLED.has(c) && !asDb.includes(c)) continue;
      expect(asDb, `${s.table}.${c} is missing from ${s.file}`).toContain(c);
    }
  });

  it("never lets person_key or plaintext identifiers appear in analytics-bound files", () => {
    for (const s of found) {
      expect(s.columns).not.toContain("person_key");
      for (const bad of ["first_name", "last_name", "date_of_birth", "cdcr_number"]) {
        expect(s.columns).not.toContain(bad);
      }
    }
  });
});
