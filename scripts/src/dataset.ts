// Loads a directory laid out per docs/SEED_CONTRACT.md (Muse output or fixtures/seed).
// Builds all SQL in memory first, so one bad row refuses the whole load before anything is written.
// Plaintext identifiers go through the vault code and come out as ciphertext in vaultSql;
// every other file references people by person_ref and gets a person_key.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ConsentRow,
  ContactRow,
  CreditAwardRow,
  CustodyStatusRow,
  EnrollmentRow,
  FACILITIES,
  FollowUpStatusRow,
  OrgRow,
  OutcomeEventRow,
  PersonAttributesRow,
  PersonIdentityRow,
  ProgramCycleRow,
  ProgramRow,
  ReleaseEventRow,
  SessionAttendanceRow,
  SessionRow,
  SynCdcr,
} from "@tpw/shared";
import type { VaultKeys } from "../../apps/worker/src/vault/crypto";
import { buildIdentityRow, identityParams, UPSERT_IDENTITY_SQL } from "../../apps/worker/src/vault/identity";
import { normalizeCdcr, normalizeInternalId } from "../../apps/worker/src/vault/normalize";
import { bindLiterals, csvExists, insert, readCsv } from "./seedSql";

export type Dataset = { analyticsSql: string; vaultSql: string; counts: Record<string, number> };

const token = () => randomBytes(16).toString("hex");

/** Muse writes to synthetic/canonical/; fixtures are flat. */
export function dataDir(dir: string): string {
  return existsSync(join(dir, "canonical")) ? join(dir, "canonical") : dir;
}

function unique<T>(file: string, rows: T[], key: (r: T) => string) {
  const seen = new Set<string>();
  for (const r of rows) {
    const k = key(r);
    if (seen.has(k)) throw new Error(`${file}: duplicate key ${k}`);
    seen.add(k);
  }
}

export async function loadDataset(rootDir: string, keys: VaultKeys): Promise<Dataset> {
  const dir = dataDir(rootDir);
  const optional = <S extends Parameters<typeof readCsv>[2]>(file: string, schema: S) =>
    (csvExists(dir, file) ? readCsv(dir, file, schema) : []) as ReturnType<typeof readCsv<S>>;

  const orgs = readCsv(dir, "org.csv", OrgRow);
  const contacts = csvExists(dir, "contacts.csv")
    ? readCsv(dir, "contacts.csv", ContactRow)
    : orgs.map((o) => ({ contact_id: `ct_${o.org_id}`, org_id: o.org_id, name: null, email: o.primary_contact_email, title: null, is_primary: true, rank: 1 }));
  const programs = optional("program.csv", ProgramRow);
  const cycles = optional("program_cycle.csv", ProgramCycleRow);
  const sessions = optional("session.csv", SessionRow);
  const attendance = optional("session_attendance.csv", SessionAttendanceRow);
  const identities = optional("person_identity.csv", PersonIdentityRow);
  const consents = optional("consent.csv", ConsentRow);
  const attributes = optional("person_attributes.csv", PersonAttributesRow);
  const enrollments = optional("enrollment.csv", EnrollmentRow);
  const credits = optional("credit_award.csv", CreditAwardRow);
  const custody = optional("custody_status.csv", CustodyStatusRow);
  const releases = optional("release_event.csv", ReleaseEventRow);
  const outcomes = optional("outcome_event.csv", OutcomeEventRow);
  const followUps = optional("follow_up_status.csv", FollowUpStatusRow);

  // ids are unique, and every reference resolves
  unique("org.csv", orgs, (r) => r.org_id);
  unique("contacts.csv", contacts, (r) => r.contact_id);
  unique("program.csv", programs, (r) => r.program_id);
  unique("program_cycle.csv", cycles, (r) => r.cycle_id);
  unique("session.csv", sessions, (r) => r.session_id);
  unique("enrollment.csv", enrollments, (r) => r.enrollment_id);
  unique("release_event.csv", releases, (r) => r.release_id);
  const orgIds = new Set(orgs.map((o) => o.org_id));
  const programOrg = new Map(programs.map((p) => [p.program_id, p.org_id]));
  const cycleIds = new Set(cycles.map((c) => c.cycle_id));
  const sessionIds = new Set(sessions.map((s) => s.session_id));
  const releaseIds = new Set(releases.map((r) => r.release_id));
  const facilityCodes = new Set(FACILITIES.map((f) => f.facility_code));
  const must = (set: Set<string>, id: string, file: string, what: string) => {
    if (!set.has(id)) throw new Error(`${file}: unknown ${what} ${id}`);
  };
  for (const r of contacts) must(orgIds, r.org_id, "contacts.csv", "org_id");
  for (const r of programs) must(orgIds, r.org_id, "program.csv", "org_id");
  for (const r of cycles) {
    if (!programOrg.has(r.program_id)) throw new Error(`program_cycle.csv: unknown program_id ${r.program_id}`);
    if (r.facility_code) must(facilityCodes, r.facility_code, "program_cycle.csv", "facility_code");
  }
  for (const r of sessions) must(cycleIds, r.cycle_id, "session.csv", "cycle_id");
  for (const r of attendance) must(sessionIds, r.session_id, "session_attendance.csv", "session_id");
  for (const r of enrollments) must(cycleIds, r.cycle_id, "enrollment.csv", "cycle_id");
  for (const r of credits) if (r.cycle_id) must(cycleIds, r.cycle_id, "credit_award.csv", "cycle_id");
  for (const r of identities) must(orgIds, r.org_id, "person_identity.csv", "org_id");
  for (const r of consents) must(orgIds, r.org_id, "consent.csv", "org_id");
  for (const r of outcomes) must(releaseIds, r.release_id, "outcome_event.csv", "release_id");
  for (const r of followUps) must(releaseIds, r.release_id, "follow_up_status.csv", "release_id");

  if (csvExists(dir, "facility.csv")) {
    const facilityFile = readCsv(dir, "facility.csv", z.object({ facility_code: z.string().min(1) }).passthrough());
    for (const f of facilityFile) must(facilityCodes, f.facility_code, "facility.csv", "facility_code");
  }

  // identities -> vault ciphertext, and person_ref -> person_key
  const refToKey = new Map<string, string>();
  const vaultStatements: string[] = [];
  const addRef = (ref: string, key: string) => {
    const prev = refToKey.get(ref);
    if (prev && prev !== key) throw new Error("person_identity.csv: one person_ref maps to two different people");
    refToKey.set(ref, key);
  };
  for (const [i, r] of identities.entries()) {
    if (!r.cdcr_number && !r.org_internal_id) {
      throw new Error(`person_identity.csv row ${i + 2}: org_internal_id is required when cdcr_number is blank`);
    }
    const row = await buildIdentityRow(keys, {
      cdcrNumber: r.cdcr_number,
      orgId: r.org_id,
      orgInternalId: r.org_internal_id,
      firstName: r.first_name,
      lastName: r.last_name,
      dateOfBirth: r.date_of_birth,
      isSynthetic: true,
    });
    vaultStatements.push(bindLiterals(UPSERT_IDENTITY_SQL, identityParams(row)) + ";");
    if (r.cdcr_number) addRef(normalizeCdcr(r.cdcr_number), row.person_key);
    if (r.org_internal_id) addRef(`${r.org_id}:${normalizeInternalId(r.org_internal_id)}`, row.person_key);
  }

  function keyOf(ref: string, file: string): string {
    let norm = ref.trim();
    if (norm.includes(":")) {
      const [org, ...rest] = norm.split(":");
      norm = `${org}:${normalizeInternalId(rest.join(":"))}`;
    } else {
      norm = normalizeCdcr(norm);
      if (!SynCdcr.safeParse(norm).success) throw new Error(`${file}: person_ref must be SYN + 5 digits or org_id:internal_id`);
    }
    const k = refToKey.get(norm);
    if (!k) throw new Error(`${file}: a person_ref has no row in person_identity.csv`);
    return k;
  }
  /** Swap person_ref for person_key; the ref itself never reaches the SQL. */
  const withKey = <T extends { person_ref: string }>(row: T, file: string) => {
    const { person_ref, ...rest } = row;
    return { person_key: keyOf(person_ref, file), ...rest };
  };

  const pk = (r: { person_ref: string }, file: string) => keyOf(r.person_ref, file);
  unique("session_attendance.csv", attendance, (r) => `${r.session_id}|${pk(r, "session_attendance.csv")}`);
  unique("enrollment.csv", enrollments, (r) => `${r.cycle_id}|${pk(r, "enrollment.csv")}`);
  unique("consent.csv", consents, (r) => `${r.org_id}|${pk(r, "consent.csv")}`);
  unique("person_attributes.csv", attributes, (r) => pk(r, "person_attributes.csv"));
  unique("custody_status.csv", custody, (r) => pk(r, "custody_status.csv"));
  unique("outcome_event.csv", outcomes, (r) => `${r.release_id}|${r.outcome_type}|${pk(r, "outcome_event.csv")}`);
  unique("follow_up_status.csv", followUps, (r) => `${r.release_id}|${pk(r, "follow_up_status.csv")}`);

  const out: string[] = [];
  const syn = { is_synthetic: true };
  for (const o of orgs) out.push(insert("orgs", { ...o, private_token: token(), form_token: token(), ...syn }));
  for (const c of contacts) out.push(insert("contacts", { ...c, ...syn }));
  for (const p of programs) {
    const credits = p.credit_types_offered ? p.credit_types_offered.split("|") : [];
    out.push(insert("programs", { ...p, credit_types_offered: JSON.stringify(credits), ...syn }));
  }
  for (const c of cycles) {
    const org_id = programOrg.get(c.program_id) as string;
    const cycle_key = [org_id, c.program_id, c.facility_code ?? "unknown", c.start_date ?? "unknown"].join("|");
    out.push(insert("program_cycles", { ...c, org_id, cycle_key, ...syn }));
  }
  for (const r of sessions) out.push(insert("sessions", { ...r, ...syn }));
  for (const r of attendance) out.push(insert("session_attendance", { ...withKey(r, "session_attendance.csv"), ...syn }));
  for (const r of consents) out.push(insert("consents", { ...withKey(r, "consent.csv"), ...syn }));
  for (const r of attributes) out.push(insert("person_attributes", { ...withKey(r, "person_attributes.csv"), ...syn }));
  for (const r of enrollments) out.push(insert("enrollments", { ...withKey(r, "enrollment.csv"), ...syn }));
  for (const r of credits) out.push(insert("credit_awards", { ...withKey(r, "credit_award.csv"), ...syn }));
  for (const r of custody) out.push(insert("custody_status", { ...withKey(r, "custody_status.csv"), ...syn }));
  for (const r of releases) out.push(insert("release_events", { ...withKey(r, "release_event.csv"), ...syn }));
  for (const r of outcomes) out.push(insert("outcome_events", { ...withKey(r, "outcome_event.csv"), ...syn }));
  for (const r of followUps) out.push(insert("follow_up_status", { ...withKey(r, "follow_up_status.csv"), ...syn }));

  return {
    analyticsSql: out.join("\n") + "\n",
    vaultSql: vaultStatements.join("\n") + (vaultStatements.length ? "\n" : ""),
    counts: {
      orgs: orgs.length,
      contacts: contacts.length,
      programs: programs.length,
      program_cycles: cycles.length,
      sessions: sessions.length,
      session_attendance: attendance.length,
      identities: identities.length,
      consents: consents.length,
      person_attributes: attributes.length,
      enrollments: enrollments.length,
      credit_awards: credits.length,
      custody_status: custody.length,
      release_events: releases.length,
      outcome_events: outcomes.length,
      follow_up_status: followUps.length,
    },
  };
}
