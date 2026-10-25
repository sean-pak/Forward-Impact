import { mkdtempSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ConsentRow, ContactRow, CreditAwardRow, CustodyStatusRow, EnrollmentRow, FollowUpStatusRow, OrgRow, OutcomeEventRow,
  PersonAttributesRow, PersonIdentityRow, ProgramCycleRow, ProgramRow, ReleaseEventRow, SessionAttendanceRow, SessionRow,
} from "@tpw/shared";
import { dropAllSql, parseTables, readMigrations } from "./migrations";
import { loadDataset } from "./dataset";
import { bindLiterals, insert, lit, staticSeedSql } from "./seedSql";
import { importVaultKeys, toBase64 } from "../../apps/worker/src/vault/crypto";

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
    ["sessions", SessionRow],
    ["session_attendance", SessionAttendanceRow],
    ["consents", ConsentRow],
    ["person_attributes", PersonAttributesRow],
    ["enrollments", EnrollmentRow],
    ["credit_awards", CreditAwardRow],
    ["custody_status", CustodyStatusRow],
    ["release_events", ReleaseEventRow],
    ["outcome_events", OutcomeEventRow],
    ["follow_up_status", FollowUpStatusRow],
  ] as const)("%s columns exist in the table", (table, schema) => {
    for (const key of Object.keys(schema.shape)) {
      expect(cols(table), `${table}.${key}`).toContain(key === "person_ref" ? "person_key" : key);
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

const keys = () => importVaultKeys(toBase64(new Uint8Array(32).fill(1)), toBase64(new Uint8Array(32).fill(2)));

function copyOf(base: string) {
  const dir = mkdtempSync(join(tmpdir(), "seed-"));
  cpSync(base, dir, { recursive: true });
  return dir;
}
function withFile(name: string, content: string, base = fixtures) {
  const dir = copyOf(base);
  writeFileSync(join(dir, name), content);
  return dir;
}

describe("bindLiterals", () => {
  it("fills placeholders in order and checks the count", () => {
    expect(bindLiterals("VALUES (?, ?, ?)", ["a'b", null, 3])).toBe("VALUES ('a''b', NULL, 3)");
    expect(() => bindLiterals("?", [])).toThrow();
    expect(() => bindLiterals("?", [1, 2])).toThrow();
  });
});

describe("fixture seed", () => {
  it("loads 4 orgs and 10 confirmed cycles, and sends the 3 identities to the vault as ciphertext", async () => {
    const fx = await loadDataset(fixtures, await keys());
    expect(fx.counts).toMatchObject({ orgs: 4, contacts: 5, programs: 5, program_cycles: 10, identities: 3 });
    expect(fx.analyticsSql.match(/'confirmed'/g)).toHaveLength(10);
    expect(fx.vaultSql.match(/INSERT INTO person_identity/g)).toHaveLength(3);
  });

  it("keeps every identifier out of both SQL files", async () => {
    const fx = await loadDataset(fixtures, await keys());
    for (const secret of ["SYN90001", "SYN90002", "Fixture,Personone", "Personone", "Persontwo", "Personthree", "1985-03-14", "1990-07-02", "1978-11-30"]) {
      expect(fx.analyticsSql, secret).not.toContain(secret);
      expect(fx.vaultSql, secret).not.toContain(secret);
    }
    expect(fx.vaultSql).not.toMatch(/'Fixture'/);
  });

  it("is deterministic in person_key but not in ciphertext", async () => {
    const a = await loadDataset(fixtures, await keys());
    const b = await loadDataset(fixtures, await keys());
    const pk = (sql: string) => [...sql.matchAll(/VALUES \('(pk_[0-9a-f]{16})'/g)].map((m) => m[1]);
    expect(pk(a.vaultSql)).toEqual(pk(b.vaultSql));
    expect(pk(a.vaultSql)).toHaveLength(3);
    expect(a.vaultSql).not.toBe(b.vaultSql);
  });

  it("refuses a non-SYN CDCR number", async () => {
    const dir = withFile(
      "person_identity.csv",
      "cdcr_number,first_name,last_name,date_of_birth,org_id,org_internal_id\nAB1234,A,B,1980-01-01,org_fx_d,D-1\n",
    );
    await expect(loadDataset(dir, await keys())).rejects.toThrow(/SYN/);
  });

  it("refuses an identity with neither a CDCR number nor an org internal id", async () => {
    const dir = withFile(
      "person_identity.csv",
      "cdcr_number,first_name,last_name,date_of_birth,org_id,org_internal_id\n,A,B,1980-01-01,org_fx_d,\n",
    );
    await expect(loadDataset(dir, await keys())).rejects.toThrow(/org_internal_id is required/);
  });

  it("refuses a non-example.org email", async () => {
    const dir = withFile(
      "contacts.csv",
      "contact_id,org_id,name,email,title,is_primary,rank\nc1,org_fx_a,X,x@gmail.com,,true,1\n",
    );
    await expect(loadDataset(dir, await keys())).rejects.toThrow(/example\.org/);
  });

  it("refuses an unknown facility code", async () => {
    const dir = withFile(
      "program_cycle.csv",
      "cycle_id,program_id,facility_code,yard,start_date,end_date,sessions_planned,course_hours_planned_per_participant,n_enrolled,n_completed,total_course_hours_delivered,source_grain,status\nc1,prog_fx_a1,XX,,2024-01-01,,,,5,,,aggregate,confirmed\n",
    );
    await expect(loadDataset(dir, await keys())).rejects.toThrow(/facility_code/);
  });

  it("refuses a bad date", async () => {
    const dir = withFile(
      "program_cycle.csv",
      "cycle_id,program_id,facility_code,yard,start_date,end_date,sessions_planned,course_hours_planned_per_participant,n_enrolled,n_completed,total_course_hours_delivered,source_grain,status\nc1,prog_fx_a1,SQ,,01/15/2024,,,,5,,,aggregate,confirmed\n",
    );
    await expect(loadDataset(dir, await keys())).rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe("Muse-style person-linked files", () => {
  const ENROLL = "enrollment_id,cycle_id,person_ref,enrollment_date,sessions_attended,sessions_planned_for_person,attendance_rate,hours_attended,completed,completion_basis,completion_date\n";
  const museDir = (extra: Record<string, string>) => {
    const dir = copyOf(fixtures);
    for (const [name, body] of Object.entries(extra)) writeFileSync(join(dir, name), body);
    return dir;
  };

  it("maps SYN refs and org:internal refs to the same person_key the vault stored", async () => {
    const dir = museDir({
      "enrollment.csv":
        ENROLL +
        "enr1,cy_fx_a1_2024a,SYN90001,,10,12,0.83,20,yes,rule_applied,\n" +
        "enr2,cy_fx_a1_2024a,org_fx_d:D-0003,,3,12,0.25,6,no,rule_applied,\n" +
        "enr3,cy_fx_a1_2024b,org_fx_d:D-0001,,9,12,0.75,18,no,,\n", // same person as SYN90001, by org id
      "session.csv": "session_id,cycle_id,session_date,cancelled,cancel_reason\nsess1,cy_fx_a1_2024a,2024-01-15,false,\n",
      "session_attendance.csv": "session_id,person_ref,status\nsess1,SYN90002,present\n",
    });
    const d = await loadDataset(dir, await keys());
    const vaultKeys = [...d.vaultSql.matchAll(/VALUES \('(pk_[0-9a-f]{16})'/g)].map((m) => m[1] as string);
    const enrolled = [...d.analyticsSql.matchAll(/INSERT INTO enrollments \(person_key, enrollment_id.*? VALUES \('(pk_[0-9a-f]{16})', '(enr\d)'/g)];
    expect(enrolled).toHaveLength(3);
    for (const m of enrolled) expect(vaultKeys).toContain(m[1]);
    expect(enrolled[0]![1]).toBe(enrolled[2]![1]); // SYN90001 and org_fx_d:D-0001 are one person
    expect(d.analyticsSql).not.toMatch(/SYN9000|D-000/);
    expect(d.counts).toMatchObject({ enrollments: 3, sessions: 1, session_attendance: 1 });
  });

  it("refuses the whole load when a person_ref has no identity row", async () => {
    const dir = museDir({ "enrollment.csv": ENROLL + "enr1,cy_fx_a1_2024a,SYN99999,,10,12,0.8,20,yes,rule_applied,\n" });
    await expect(loadDataset(dir, await keys())).rejects.toThrow(/no row in person_identity/);
  });

  it("refuses a non-SYN person_ref", async () => {
    const dir = museDir({ "enrollment.csv": ENROLL + "enr1,cy_fx_a1_2024a,AB12345,,10,12,0.8,20,yes,rule_applied,\n" });
    await expect(loadDataset(dir, await keys())).rejects.toThrow(/SYN \+ 5 digits/);
  });

  it("refuses duplicate enrollments and unknown cycles", async () => {
    const dup = museDir({ "enrollment.csv": ENROLL + "e1,cy_fx_a1_2024a,SYN90001,,1,1,1,1,yes,,\ne2,cy_fx_a1_2024a,SYN90001,,1,1,1,1,yes,,\n" });
    await expect(loadDataset(dup, await keys())).rejects.toThrow(/duplicate/);
    const bad = museDir({ "enrollment.csv": ENROLL + "e1,cy_nope,SYN90001,,1,1,1,1,yes,,\n" });
    await expect(loadDataset(bad, await keys())).rejects.toThrow(/unknown cycle_id/);
  });

  it("reads Muse's canonical/ subfolder and fills blank credit_days_applied with NULL", async () => {
    const root2 = mkdtempSync(join(tmpdir(), "muse-"));
    cpSync(fixtures, join(root2, "canonical"), { recursive: true });
    writeFileSync(
      join(root2, "canonical/credit_award.csv"),
      "person_ref,cycle_id,credit_type,credit_days_earned,credit_days_applied,award_date\nSYN90001,cy_fx_a1_2024a,rac,10,,2024-05-01\n",
    );
    const d = await loadDataset(root2, await keys());
    expect(d.analyticsSql).toMatch(/INSERT INTO credit_awards \(person_key, cycle_id, credit_type, credit_days_earned, credit_days_applied, award_date, is_synthetic\) VALUES \('pk_[0-9a-f]{16}', 'cy_fx_a1_2024a', 'rac', 10, NULL, '2024-05-01', 1\)/);
  });
});
