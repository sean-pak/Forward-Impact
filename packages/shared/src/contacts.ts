import { z } from "zod";

/** One mailing-list row after header normalization. */
export const ListContactSchema = z.object({
  org: z.string().trim().min(1, "org is missing"),
  name: z.string().trim().default(""),
  email: z.string().trim().toLowerCase().pipe(z.email("not a valid email")),
  title: z.string().trim().default(""),
});
export type ListContact = z.infer<typeof ListContactSchema>;

export type RejectedRow = { line: number; reason: string };

const HEADER_ALIASES: Record<string, keyof ListContact> = {
  org: "org",
  organization: "org",
  "org name": "org",
  org_name: "org",
  name: "name",
  "contact name": "name",
  email: "email",
  "email address": "email",
  title: "title",
  "job title": "title",
};

/** Maps free-form CSV headers onto org/name/email/title. Unknown columns are dropped. */
function normalizeKeys(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    const key = HEADER_ALIASES[k.trim().toLowerCase()];
    if (key && typeof v === "string") out[key] = v;
  }
  return out;
}

/** Validates parsed CSV rows. `line` is the 1-based file line (header is line 1). */
export function parseContactRows(rows: Record<string, unknown>[]): { contacts: ListContact[]; rejected: RejectedRow[] } {
  const contacts: ListContact[] = [];
  const rejected: RejectedRow[] = [];
  rows.forEach((raw, i) => {
    const parsed = ListContactSchema.safeParse(normalizeKeys(raw));
    if (parsed.success) contacts.push(parsed.data);
    else rejected.push({ line: i + 2, reason: parsed.error.issues.map((x) => `${x.path.join(".") || "row"}: ${x.message}`).join("; ") });
  });
  return { contacts, rejected };
}

export type OrgGroup = {
  orgName: string;
  /** rank 1 is the highest rank (first listed in the file). */
  contacts: { name: string; email: string; title: string; rank: number }[];
};

/** Groups rows by org name (case-insensitive). File order sets rank; a repeated email in one org is kept once. */
export function groupByOrg(rows: ListContact[]): OrgGroup[] {
  const groups = new Map<string, OrgGroup>();
  for (const r of rows) {
    const key = r.org.toLowerCase();
    const g = groups.get(key) ?? { orgName: r.org, contacts: [] };
    groups.set(key, g);
    if (g.contacts.some((c) => c.email === r.email)) continue;
    g.contacts.push({ name: r.name, email: r.email, title: r.title, rank: g.contacts.length + 1 });
  }
  return [...groups.values()];
}

/** "Fixture Arts Collective" -> "org_fixture_arts_collective". */
export function orgIdFromName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `org_${slug || "unnamed"}`;
}

/** The synthetic-data rule: `@example.org` addresses are fake and must never be emailed. */
export function isSyntheticEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith("@example.org");
}
