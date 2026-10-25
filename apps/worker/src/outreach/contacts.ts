import Papa from "papaparse";
import { groupByOrg, isSyntheticEmail, orgIdFromName, parseContactRows, type RejectedRow } from "@tpw/shared";

export type ImportResult = {
  orgsCreated: number;
  orgsMatched: number;
  contactsAdded: number;
  contactsUpdated: number;
  rejected: RejectedRow[];
};

/** URL-safe random token for the org's private links. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function uniqueOrgId(db: D1Database, name: string): Promise<string> {
  const base = orgIdFromName(name);
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}_${n}`;
    if (!(await db.prepare("SELECT 1 AS x FROM orgs WHERE org_id = ?").bind(id).first())) return id;
  }
}

/**
 * Imports a mailing-list CSV (org, name, email, title). New orgs are created; the first listed contact
 * of an org with no primary becomes its primary. Existing orgs match by name, case-insensitively.
 * An email that already belongs to a different org is rejected so replies cannot be routed to the wrong org.
 */
export async function importContacts(db: D1Database, csv: string): Promise<ImportResult> {
  const parsed = Papa.parse<Record<string, unknown>>(csv, { header: true, skipEmptyLines: true });
  const { contacts, rejected } = parseContactRows(parsed.data);
  const result: ImportResult = { orgsCreated: 0, orgsMatched: 0, contactsAdded: 0, contactsUpdated: 0, rejected };

  for (const group of groupByOrg(contacts)) {
    const found = await db
      .prepare("SELECT org_id FROM orgs WHERE lower(org_name) = lower(?)")
      .bind(group.orgName)
      .first<{ org_id: string }>();
    const stmts: D1PreparedStatement[] = [];
    let orgId: string;
    if (found) {
      orgId = found.org_id;
      result.orgsMatched++;
    } else {
      orgId = await uniqueOrgId(db, group.orgName);
      const synthetic = group.contacts.every((c) => isSyntheticEmail(c.email)) ? 1 : 0;
      // data_persona is NOT NULL in the schema; 1 is a placeholder until ingest detects the real one.
      stmts.push(
        db
          .prepare(
            `INSERT INTO orgs (org_id, org_name, data_persona, primary_contact_email, private_token, form_token, is_synthetic)
             VALUES (?, ?, 1, ?, ?, ?, ?)`,
          )
          .bind(orgId, group.orgName, group.contacts[0]!.email, newToken(), newToken(), synthetic),
      );
      result.orgsCreated++;
    }

    const existing = (
      await db.prepare("SELECT email, is_primary, rank FROM contacts WHERE org_id = ?").bind(orgId).all<{ email: string; is_primary: number; rank: number }>()
    ).results;
    const hasPrimary = existing.some((c) => c.is_primary === 1);
    let nextRank = existing.reduce((m, c) => Math.max(m, c.rank), 0) + 1;
    let primaryAssigned = hasPrimary;

    for (const c of group.contacts) {
      const elsewhere = await db
        .prepare("SELECT o.org_name FROM contacts c JOIN orgs o ON o.org_id = c.org_id WHERE lower(c.email) = ? AND c.org_id != ?")
        .bind(c.email, orgId)
        .first<{ org_name: string }>();
      if (elsewhere) {
        rejected.push({ line: 0, reason: `${c.email} already belongs to ${elsewhere.org_name}` });
        continue;
      }
      if (existing.some((e) => e.email.toLowerCase() === c.email)) {
        stmts.push(
          db
            .prepare("UPDATE contacts SET name = COALESCE(NULLIF(?, ''), name), title = COALESCE(NULLIF(?, ''), title) WHERE org_id = ? AND lower(email) = ?")
            .bind(c.name, c.title, orgId, c.email),
        );
        result.contactsUpdated++;
        continue;
      }
      const makePrimary = !primaryAssigned;
      primaryAssigned = true;
      stmts.push(
        db
          .prepare(
            `INSERT INTO contacts (contact_id, org_id, name, email, title, is_primary, rank, is_synthetic)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(`ct_${crypto.randomUUID().slice(0, 8)}`, orgId, c.name || null, c.email, c.title || null, makePrimary ? 1 : 0, nextRank++, isSyntheticEmail(c.email) ? 1 : 0),
      );
      if (makePrimary && found) {
        stmts.push(db.prepare("UPDATE orgs SET primary_contact_email = ? WHERE org_id = ?").bind(c.email, orgId));
      }
      result.contactsAdded++;
    }
    if (stmts.length) await db.batch(stmts);
  }
  return result;
}

/** Makes one contact the org's only primary. Returns false if the contact is not in that org. */
export async function setPrimary(db: D1Database, orgId: string, contactId: string): Promise<boolean> {
  const c = await db
    .prepare("SELECT email FROM contacts WHERE contact_id = ? AND org_id = ?")
    .bind(contactId, orgId)
    .first<{ email: string }>();
  if (!c) return false;
  await db.batch([
    db.prepare("UPDATE contacts SET is_primary = 0 WHERE org_id = ?").bind(orgId),
    db.prepare("UPDATE contacts SET is_primary = 1 WHERE contact_id = ?").bind(contactId),
    db.prepare("UPDATE orgs SET primary_contact_email = ? WHERE org_id = ?").bind(c.email, orgId),
  ]);
  return true;
}

export type OrgWithContacts = {
  org_id: string;
  org_name: string;
  asks_sent: number;
  contacts: { contact_id: string; name: string | null; email: string; title: string | null; is_primary: boolean; rank: number }[];
};

export async function listOrgs(db: D1Database): Promise<OrgWithContacts[]> {
  const { results } = await db
    .prepare(
      `SELECT o.org_id, o.org_name, (SELECT COUNT(*) FROM outreach x WHERE x.org_id = o.org_id) AS asks_sent,
              c.contact_id, c.name, c.email, c.title, c.is_primary, c.rank
       FROM orgs o LEFT JOIN contacts c ON c.org_id = o.org_id
       ORDER BY o.org_name, c.rank`,
    )
    .all<{
      org_id: string; org_name: string; asks_sent: number;
      contact_id: string | null; name: string | null; email: string | null; title: string | null; is_primary: number | null; rank: number | null;
    }>();
  const orgs = new Map<string, OrgWithContacts>();
  for (const r of results) {
    const o = orgs.get(r.org_id) ?? { org_id: r.org_id, org_name: r.org_name, asks_sent: r.asks_sent, contacts: [] };
    orgs.set(r.org_id, o);
    if (r.contact_id && r.email) {
      o.contacts.push({ contact_id: r.contact_id, name: r.name, email: r.email, title: r.title, is_primary: r.is_primary === 1, rank: r.rank ?? 0 });
    }
  }
  return [...orgs.values()];
}
