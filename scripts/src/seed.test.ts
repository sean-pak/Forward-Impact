import { mkdtempSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ContactRow, OrgRow, PersonIdentityRow, ProgramCycleRow, ProgramRow } from "@tpw/shared";
import { dropAllSql, parseTables, readMigrations } from "./migrations";
import { fixtureSeedSql, insert, lit, staticSeedSql } from "./seedSql";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = join(root, "fixtures/seed");
const analytics = parseTables(readMigrations(join(root, "apps/worker/migrations/analytics")));
const vault = parseTables(readMigrations(join(root, "apps/worker/migrations/vault")));
const cols = (t: string) => analytics.find((x) => x.name === t)?.columns ?? [];

describe("migrations", () => {
  it("parses every table", () => {
    expect(analytics.map((t) => t.name)).toContain("program_cycles");
    expect(vault.map((t) => t.name).sort()).toEqual(["locator_raw", "person_identity", "vault_access_log"]);
  });

  it("drop script covers every table plus d1_migrations", () => {
    const sql = dropAllSql(analytics);
    for (const t of analytics) expect(sql).toContain(`DROP TABLE IF EXISTS ${t.name};`);
    expect(sql).toContain("DROP TABLE IF EXISTS d1_migrations;");
  });

  it("no identifier columns exist in analytics", () => {
    const all = analytics.flatMap((t) => t.columns);
    for (const bad of ["cdcr_number", "first_name", "last_name", "date_of_birth", "cdcr_enc"]) {
      expect(all).not.toContain(bad);
    }
  });
});

describe("seed contract matches migrations", () => {
  // Seed-only helper columns that the loader fills in or transforms.
  const derived = { program_cycles: ["org_id", "cycle_key"], orgs: ["private_token", "form_token"] } as Record<string, string[]>;

  it.each([
    ["orgs", OrgRow],
    ["contacts", ContactRow],
    ["programs", ProgramRow],
    ["program_cycles", ProgramCycleRow],
  ] as const)("%s columns exist in the table", (table, schema) => {
    for (const key of Object.keys(schema.shape)) {
      expect(cols(table), `${table}.${key}`).toContain(key);
    }
    for (const d of derived[table] ?? []) expect(cols(table)).toContain(d);
  });

  it("person_identity columns never land in analytics", () => {
    for (const key of Object.keys(PersonIdentityRow.shape)) {
      if (key === "org_id") continue;
      for (const t of analytics) expect(t.columns).not.toContain(key);
    }
  });
});

describe("sql literals", () => {
  it("escapes quotes and maps types", () => {
    expect(lit("O'Brien")).toBe("'O''Brien'");
    expect(lit(null)).toBe("NULL");
    expect(lit(true)).toBe("1");
    expect(lit(false)).toBe("0");
    expect(lit(12.5)).toBe("12.5");
    expect(insert("t", { a: "x", b: null })).toBe("INSERT INTO t (a, b) VALUES ('x', NULL);");
  });
});

describe("static seed", () => {
  const sql = staticSeedSql();
  it("loads 31 facilities, 11 benchmarks, assumptions, and core fields", () => {
    expect(sql.match(/INSERT INTO facilities /g)).toHaveLength(31);
    expect(sql.match(/INSERT INTO benchmark_reference /g)).toHaveLength(11);
    expect(sql).toContain("cost_per_year_2026");
    expect(sql).toContain("todo_confirm");
    expect(sql.match(/INSERT INTO fields /g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe("fixture seed", () => {
  it("loads 4 orgs and 10 confirmed cycles, skips identities", () => {
    const fx = fixtureSeedSql(fixtures);
    expect(fx.counts).toEqual({ orgs: 4, contacts: 5, programs: 5, program_cycles: 10 });
    expect(fx.skippedIdentities).toBe(3);
    expect(fx.sql.match(/'confirmed'/g)).toHaveLength(10);
    expect(fx.sql).not.toMatch(/SYN9000/);
    expect(fx.sql).not.toMatch(/Personone/);
  });

  function withFile(name: string, content: string) {
    const dir = mkdtempSync(join(tmpdir(), "seed-"));
    cpSync(fixtures, dir, { recursive: true });
    writeFileSync(join(dir, name), content);
    return dir;
  }

  it("refuses a non-SYN CDCR number", () => {
    const dir = withFile(
      "person_identity.csv",
      "cdcr_number,first_name,last_name,date_of_birth,org_id,org_internal_id\nAB1234,A,B,1980-01-01,org_fx_d,D-1\n",
    );
    expect(() => fixtureSeedSql(dir)).toThrow(/SYN/);
  });

  it("refuses a non-example.org email", () => {
    const dir = withFile(
      "contacts.csv",
      "contact_id,org_id,name,email,title,is_primary,rank\nc1,org_fx_a,X,x@gmail.com,,true,1\n",
    );
    expect(() => fixtureSeedSql(dir)).toThrow(/example\.org/);
  });

  it("refuses an unknown facility code", () => {
    const dir = withFile(
      "program_cycle.csv",
      "cycle_id,program_id,facility_code,yard,start_date,end_date,sessions_planned,course_hours_planned_per_participant,n_enrolled,n_completed,total_course_hours_delivered,source_grain,status\nc1,prog_fx_a1,XX,,2024-01-01,,,,5,,,aggregate,confirmed\n",
    );
    expect(() => fixtureSeedSql(dir)).toThrow(/facility_code/);
  });

  it("refuses a bad date", () => {
    const dir = withFile(
      "program_cycle.csv",
      "cycle_id,program_id,facility_code,yard,start_date,end_date,sessions_planned,course_hours_planned_per_participant,n_enrolled,n_completed,total_course_hours_delivered,source_grain,status\nc1,prog_fx_a1,SQ,,01/15/2024,,,,5,,,aggregate,confirmed\n",
    );
    expect(() => fixtureSeedSql(dir)).toThrow(/YYYY-MM-DD/);
  });
});
