import {
  checkFields, decideOutcome, queryMethod,
  type CheckFields, type LocatorQuery, type LocatorResult, type LocatorSource, type LocatorSubject, type OutcomeDraft,
} from "@tpw/shared";
import type { Vault } from "../vault";
import { LocatorRefused, eitLocator, mockLocator, type Locator } from "./adapter";

/** One click checks at most this many people, so a request stays well inside the Worker's subrequest budget. */
export const MAX_PER_CALL = 20;

export type Deps = {
  db: D1Database;
  openVault: (() => Promise<Vault>) | undefined;
  /** REAL_LOCATOR_ENABLED === "true". Even then the real client is a stub. */
  realEnabled: boolean;
  now?: () => Date;
  /** Tests swap the locator; the default is the mock for synthetic people and the guarded real adapter for everyone else. */
  locatorFor?: (isSynthetic: boolean, recentMs: () => number[]) => Locator;
};

export type LookupRow = {
  person_key: string;
  release_id: string;
  release_date: string;
  release_fiscal_year: string | null;
  is_synthetic: boolean;
  orgs: string | null;
  last_check: null | {
    check_id: string; checked_at: string; source_system: LocatorSource; result: CheckFields["result"];
    match_confidence: CheckFields["match_confidence"]; verified_by_human: boolean;
    returned_facility: string | null; returned_admission_date: string | null;
  };
  needs_verification: boolean;
  outcome: null | { outcome_date: string; precision: "exact" | "interval"; source: string };
};

type DbRow = {
  person_key: string; release_id: string; release_date: string; release_fiscal_year: string | null; is_synthetic: number; orgs: string | null;
  check_id: string | null; checked_at: string | null; source_system: LocatorSource | null; result: CheckFields["result"] | null;
  match_confidence: CheckFields["match_confidence"] | null; verified_by_human: number | null;
  returned_facility: string | null; returned_admission_date: string | null;
  outcome_date: string | null; outcome_date_precision: "exact" | "interval" | null; outcome_source: string | null;
};

const iso = (d: Date) => d.toISOString();
const today = (deps: Deps) => iso((deps.now ?? (() => new Date()))()).slice(0, 10);

/**
 * People TPW may check: released after a program (first such release only), release not in the future, and follow-up
 * consent on file with nothing revoked or declined. This one query is the eligibility rule for the list and the checks.
 */
export async function listLookups(deps: Deps): Promise<LookupRow[]> {
  const { results } = await deps.db
    .prepare(
      `SELECT r.person_key, r.release_id, r.release_date, r.release_fiscal_year, r.is_synthetic,
         (SELECT group_concat(DISTINCT o.org_name) FROM consents k JOIN orgs o ON o.org_id = k.org_id WHERE k.person_key = r.person_key) AS orgs,
         c.check_id, c.checked_at, c.source_system, c.result, c.match_confidence, c.verified_by_human, c.returned_facility, c.returned_admission_date,
         oe.outcome_date, oe.outcome_date_precision, oe.outcome_source
       FROM release_events r
       LEFT JOIN custody_checks c ON c.check_id = (
         SELECT x.check_id FROM custody_checks x WHERE x.person_key = r.person_key ORDER BY x.checked_at DESC, x.rowid DESC LIMIT 1)
       LEFT JOIN outcome_events oe ON oe.person_key = r.person_key AND oe.release_id = r.release_id AND oe.outcome_type = 'return_to_prison'
       WHERE r.post_program = 1 AND r.release_date <= ?
         AND r.release_date = (SELECT MIN(r2.release_date) FROM release_events r2 WHERE r2.person_key = r.person_key AND r2.post_program = 1)
         AND EXISTS (SELECT 1 FROM consents k WHERE k.person_key = r.person_key AND k.consent_followup = 1 AND k.revoked_date IS NULL)
         AND NOT EXISTS (SELECT 1 FROM consents k WHERE k.person_key = r.person_key AND (k.consent_followup = 0 OR k.revoked_date IS NOT NULL))
       ORDER BY r.release_date, r.person_key`,
    )
    .bind(today(deps))
    .all<DbRow>();
  const seen = new Set<string>();
  const rows: LookupRow[] = [];
  for (const r of results) {
    if (seen.has(r.person_key)) continue;
    seen.add(r.person_key);
    const last_check = r.check_id
      ? {
          check_id: r.check_id, checked_at: r.checked_at!, source_system: r.source_system!, result: r.result!,
          match_confidence: r.match_confidence!, verified_by_human: r.verified_by_human === 1,
          returned_facility: r.returned_facility, returned_admission_date: r.returned_admission_date,
        }
      : null;
    rows.push({
      person_key: r.person_key, release_id: r.release_id, release_date: r.release_date, release_fiscal_year: r.release_fiscal_year,
      is_synthetic: r.is_synthetic === 1, orgs: r.orgs, last_check,
      needs_verification: Boolean(last_check && (last_check.result === "multiple_matches" || (last_check.result === "found_in_custody" && last_check.match_confidence === "name_only" && !last_check.verified_by_human))),
      outcome: r.outcome_date ? { outcome_date: r.outcome_date, precision: r.outcome_date_precision!, source: r.outcome_source! } : null,
    });
  }
  return rows;
}

/** "Check cohort": people never checked, then the longest ago. Not those checked today, with a return already found, or waiting on a human. */
export function pickCohort(rows: LookupRow[], todayDate: string): string[] {
  return rows
    .filter((r) => !r.outcome && !r.needs_verification && !(r.last_check && r.last_check.checked_at.slice(0, 10) >= todayDate))
    .sort((a, b) => (a.last_check?.checked_at ?? "").localeCompare(b.last_check?.checked_at ?? ""))
    .slice(0, MAX_PER_CALL)
    .map((r) => r.person_key);
}

export type CheckOutcome = {
  person_key: string;
  status: "checked" | "skipped";
  reason?: string;
  check_id?: string;
  result?: CheckFields["result"];
  needs_verification?: boolean;
  outcome?: "exact" | "interval" | null;
};

const sourceOutcome = (source: LocatorSource) => (source === "mock_locator" ? "mock_locator" : "eit_locator_verified");

/** First event only. A later exact date may replace an earlier interval from the same source; a source is never overwritten. */
function outcomeStatement(db: D1Database, p: { personKey: string; releaseId: string; draft: OutcomeDraft; source: string; checkId: string; synthetic: boolean }) {
  const d = p.draft;
  return db
    .prepare(
      `INSERT INTO outcome_events (person_key, release_id, outcome_type, outcome_date, outcome_date_precision, outcome_date_earliest,
         days_to_outcome, within_3yr, outcome_source, evidence_check_id, is_synthetic)
       VALUES (?, ?, 'return_to_prison', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (person_key, release_id, outcome_type) DO UPDATE SET
         outcome_date = excluded.outcome_date, outcome_date_precision = excluded.outcome_date_precision,
         outcome_date_earliest = excluded.outcome_date_earliest, days_to_outcome = excluded.days_to_outcome,
         within_3yr = excluded.within_3yr, evidence_check_id = excluded.evidence_check_id
       WHERE outcome_events.outcome_date_precision = 'interval' AND excluded.outcome_date_precision = 'exact'
         AND outcome_events.outcome_source = excluded.outcome_source`,
    )
    .bind(p.personKey, p.releaseId, d.outcome_date, d.outcome_date_precision, d.outcome_date_earliest, d.days_to_outcome, d.within_3yr ? 1 : 0, p.source, p.checkId, p.synthetic ? 1 : 0);
}

async function lastNegativeDate(db: D1Database, personKey: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT MAX(checked_at) AS t FROM custody_checks WHERE person_key = ? AND result = 'not_found'")
    .bind(personKey)
    .first<{ t: string | null }>();
  return row?.t ? row.t.slice(0, 10) : null;
}

/**
 * Looks each person up and records it: a `custody_checks` row (no identifiers), the encrypted query and response in the
 * vault, and an `outcome_events` row only when the check supports one. Identifiers are decrypted once, in memory, through
 * the audited `reidentify`, and never written anywhere else. Failures and guard refusals are rows too, never silent.
 */
export async function runChecks(deps: Deps, personKeys: string[]): Promise<CheckOutcome[]> {
  const now = deps.now ?? (() => new Date());
  const wanted = [...new Set(personKeys)];
  const eligible = new Map((await listLookups(deps)).map((r) => [r.person_key, r]));
  const out: CheckOutcome[] = [];
  const todo: LookupRow[] = [];
  for (const key of wanted) {
    const row = eligible.get(key);
    if (!row) out.push({ person_key: key, status: "skipped", reason: "Not eligible: needs a release after the program and active follow-up consent." });
    else if (todo.length >= MAX_PER_CALL) out.push({ person_key: key, status: "skipped", reason: `Limit of ${MAX_PER_CALL} lookups per click; click again.` });
    else todo.push(row);
  }
  if (todo.length === 0) return out;
  if (!deps.openVault) throw new Error("The vault is not configured.");
  const vault = await deps.openVault();

  const people = new Map(
    (await vault.reidentify(todo.map((r) => r.person_key), { purpose: "locator_check", actor: "admin_lookups" })).map((p) => [p.personKey, p]),
  );

  const since = iso(new Date(now().getTime() - 86_400_000));
  const { results: recentRows } = await deps.db
    .prepare("SELECT source_system, checked_at FROM custody_checks WHERE checked_at >= ?")
    .bind(since)
    .all<{ source_system: LocatorSource; checked_at: string }>();
  const recent: Record<LocatorSource, number[]> = { mock_locator: [], eit_locator: [] };
  for (const r of recentRows) if (r.source_system in recent) recent[r.source_system].push(Date.parse(r.checked_at));

  for (const row of todo) {
    const person = people.get(row.person_key);
    const cdcr = person?.cdcrNumber ?? null;
    const query: LocatorQuery = cdcr ? { cdcr } : { first: person?.firstName ?? undefined, last: person?.lastName ?? undefined };
    if (!person || (!cdcr && !(query.first && query.last))) {
      out.push({ person_key: row.person_key, status: "skipped", reason: "No CDCR number or full name on file to look up." });
      continue;
    }
    const synthetic = person.isSynthetic && row.is_synthetic;
    const subject: LocatorSubject = { isSynthetic: synthetic, cdcrNumber: cdcr, consentFollowup: true, consentRevoked: false };
    const locator = (deps.locatorFor ?? defaultLocator(deps))(synthetic, () => recent.eit_locator);

    let result: LocatorResult | null = null;
    let blocked: string | null = null;
    let failure: string | null = null;
    try {
      result = await locator.lookup(query, subject);
    } catch (e) {
      if (e instanceof LocatorRefused) blocked = e.message;
      else failure = e instanceof Error ? e.message.slice(0, 200) : "lookup failed";
    }

    const fields: CheckFields = blocked
      ? { query_method: queryMethod(query), result: "blocked", returned_facility: null, returned_admission_date: null, returned_release_date: null, match_confidence: "none" }
      : checkFields(query, result ?? { kind: "error", message: failure ?? "lookup failed" });

    const checkId = crypto.randomUUID();
    const checkedAt = iso(now());
    const decision = decideOutcome({
      check: fields, verified: false, releaseDate: row.release_date, checkedOn: checkedAt.slice(0, 10),
      lastNegativeCheck: fields.result === "found_in_custody" && !fields.returned_admission_date ? await lastNegativeDate(deps.db, row.person_key) : null,
    });

    // Vault first, so a check row never points at a raw response that was not stored.
    await vault.recordLocatorRaw(checkId, query, blocked ? { blocked } : failure ? { error: failure } : result);
    const statements = [
      deps.db
        .prepare(
          `INSERT INTO custody_checks (check_id, person_key, checked_at, source_system, query_method, method_of_access, result,
             returned_facility, returned_admission_date, returned_release_date, match_confidence, verified_by_human, raw_response_ref, is_synthetic)
           VALUES (?, ?, ?, ?, ?, 'http_script', ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .bind(checkId, row.person_key, checkedAt, locator.source, fields.query_method, fields.result, fields.returned_facility,
          fields.returned_admission_date, fields.returned_release_date, fields.match_confidence, checkId, synthetic ? 1 : 0),
    ];
    if (decision.status === "outcome") {
      statements.push(outcomeStatement(deps.db, { personKey: row.person_key, releaseId: row.release_id, draft: decision.draft, source: sourceOutcome(locator.source), checkId, synthetic }));
    }
    await deps.db.batch(statements);
    recent[locator.source].push(now().getTime());

    out.push({
      person_key: row.person_key, status: "checked", check_id: checkId, result: fields.result,
      needs_verification: decision.status === "needs_verification",
      outcome: decision.status === "outcome" ? decision.draft.outcome_date_precision : null,
      ...(blocked ? { reason: blocked } : {}),
      ...(failure ? { reason: failure } : {}),
    });
  }
  return out;
}

function defaultLocator(deps: Deps) {
  return (isSynthetic: boolean, recentMs: () => number[]): Locator =>
    isSynthetic ? mockLocator() : eitLocator({ enabled: deps.realEnabled, recentMs });
}

export type VerifyResult = { ok: true; outcome: "exact" | "interval" | null } | { ok: false; status: 400 | 404; error: string };

/**
 * A human confirms that a name-only hit is the right person. Only then does it become an outcome. A check with several
 * matches cannot be verified: look the person up again by CDCR number.
 */
export async function verifyCheck(deps: Deps, checkId: string): Promise<VerifyResult> {
  const check = await deps.db
    .prepare(
      `SELECT check_id, person_key, checked_at, source_system, result, match_confidence, verified_by_human, returned_admission_date, is_synthetic
       FROM custody_checks WHERE check_id = ?`,
    )
    .bind(checkId)
    .first<{ check_id: string; person_key: string; checked_at: string; source_system: LocatorSource; result: CheckFields["result"]; match_confidence: CheckFields["match_confidence"]; verified_by_human: number; returned_admission_date: string | null; is_synthetic: number }>();
  if (!check) return { ok: false, status: 404, error: "check not found" };
  if (check.result === "multiple_matches") return { ok: false, status: 400, error: "Several people matched this name. Look the person up by CDCR number instead." };
  if (check.result !== "found_in_custody" || check.match_confidence !== "name_only") return { ok: false, status: 400, error: "Only a name-only custody hit needs verifying." };
  if (check.verified_by_human === 1) return { ok: false, status: 400, error: "Already verified." };

  const release = (await listLookups(deps)).find((r) => r.person_key === check.person_key);
  if (!release) return { ok: false, status: 400, error: "This person is no longer eligible for lookups." };

  const decision = decideOutcome({
    check: { result: check.result, match_confidence: check.match_confidence, returned_admission_date: check.returned_admission_date },
    verified: true, releaseDate: release.release_date, checkedOn: check.checked_at.slice(0, 10),
    lastNegativeCheck: check.returned_admission_date ? null : await lastNegativeDate(deps.db, check.person_key),
  });
  const statements = [deps.db.prepare("UPDATE custody_checks SET verified_by_human = 1 WHERE check_id = ?").bind(check.check_id)];
  if (decision.status === "outcome") {
    statements.push(
      outcomeStatement(deps.db, {
        personKey: check.person_key, releaseId: release.release_id, draft: decision.draft,
        source: sourceOutcome(check.source_system), checkId: check.check_id, synthetic: check.is_synthetic === 1,
      }),
    );
  }
  await deps.db.batch(statements);
  return { ok: true, outcome: decision.status === "outcome" ? decision.draft.outcome_date_precision : null };
}

/** Name on hover: one audited re-identification, and only for someone on the lookup list. */
export async function revealPerson(deps: Deps, personKey: string): Promise<{ first_name: string | null; last_name: string | null; cdcr_number: string | null } | null> {
  if (!deps.openVault) throw new Error("The vault is not configured.");
  if (!(await listLookups(deps)).some((r) => r.person_key === personKey)) return null;
  const [p] = await (await deps.openVault()).reidentify([personKey], { purpose: "admin_vault_view", actor: "admin_lookups" });
  return p ? { first_name: p.firstName, last_name: p.lastName, cdcr_number: p.cdcrNumber } : null;
}
