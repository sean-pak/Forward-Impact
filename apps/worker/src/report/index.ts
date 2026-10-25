import { buildDashboard, grantText, type OrgReport, type ParticipantRow } from "@tpw/shared";
import { newToken } from "../outreach/contacts";
import { loadConfirmedCycles, loadFacilities } from "../summary";
import type { Vault } from "../vault";

type EnrollmentRow = {
  person_key: string;
  program_name: string;
  facility_name: string | null;
  start_date: string | null;
  sessions_attended: number | null;
  sessions_planned_for_person: number | null;
  completed: ParticipantRow["completed"];
};

/**
 * The CBO's private report (PRD 5). The org is found by its unguessable private token. Names come back from the vault
 * only for people in this org's confirmed cycles, and the vault itself drops anyone this org did not report. Every
 * view is logged by the vault, even one with no people. No LLM anywhere in this path.
 */
export async function loadOrgReport(db: D1Database, token: string, openVault: (() => Promise<Vault>) | undefined): Promise<OrgReport | null> {
  const org = await db.prepare("SELECT org_id, org_name FROM orgs WHERE private_token = ?").bind(token).first<{ org_id: string; org_name: string }>();
  if (!org) return null;
  const [cycles, facilities, enrollments] = await Promise.all([
    loadConfirmedCycles(db, org.org_id),
    loadFacilities(db),
    db
      .prepare(
        `SELECT e.person_key, p.program_name, f.facility_name, c.start_date, e.sessions_attended, e.sessions_planned_for_person, e.completed
         FROM enrollments e
         JOIN program_cycles c ON c.cycle_id = e.cycle_id
         JOIN programs p ON p.program_id = c.program_id
         LEFT JOIN facilities f ON f.facility_code = c.facility_code
         WHERE c.org_id = ? AND c.status = 'confirmed'
         ORDER BY p.program_name, c.start_date, e.rowid`,
      )
      .bind(org.org_id)
      .all<EnrollmentRow>(),
  ]);

  let participants: ParticipantRow[] | null = null;
  if (openVault) {
    try {
      const vault = await openVault();
      const people = await vault.reidentify(
        enrollments.results.map((e) => e.person_key),
        { purpose: "org_report", actor: "org_report_link", orgId: org.org_id },
      );
      const byKey = new Map(people.map((p) => [p.personKey, p]));
      participants = enrollments.results.map((e) => {
        const p = byKey.get(e.person_key);
        return {
          first_name: p?.firstName ?? null, last_name: p?.lastName ?? null, cdcr_number: p?.cdcrNumber ?? null,
          program_name: e.program_name, facility_name: e.facility_name, start_date: e.start_date,
          sessions_attended: e.sessions_attended, sessions_planned: e.sessions_planned_for_person, completed: e.completed,
        };
      });
    } catch (e) {
      // The message comes from our own key checks or D1 and never holds plaintext; the page shows counts without names.
      console.error("org report: vault unavailable:", e instanceof Error ? e.message.slice(0, 120) : "unknown");
    }
  }

  return {
    org_name: org.org_name,
    dashboard: buildDashboard(cycles, facilities, "staff"),
    participants,
    grant_text: grantText(org.org_name, cycles),
  };
}

/** The link that goes in Sam's receipt and thanks emails. Orgs made before tokens existed get one now. */
export async function orgReportUrl(db: D1Database, webUrl: string | undefined, orgId: string): Promise<string | undefined> {
  if (!webUrl) return undefined;
  let row = await db.prepare("SELECT private_token FROM orgs WHERE org_id = ?").bind(orgId).first<{ private_token: string | null }>();
  if (row && !row.private_token) {
    await db.prepare("UPDATE orgs SET private_token = ? WHERE org_id = ? AND private_token IS NULL").bind(newToken(), orgId).run();
    row = await db.prepare("SELECT private_token FROM orgs WHERE org_id = ?").bind(orgId).first<{ private_token: string | null }>();
  }
  return row?.private_token ? `${webUrl.replace(/\/+$/, "")}/o/${row.private_token}` : undefined;
}
