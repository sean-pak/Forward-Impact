import {
  buildCohort,
  buildOutcomePanel,
  type BenchmarkRow,
  type EventInput,
  type FollowUpInput,
  type OutcomePanel,
  type ReleaseInput,
  type View,
} from "@tpw/shared";

type ReleaseRow = Omit<ReleaseInput, "post_program" | "is_synthetic"> & { post_program: number | null; is_synthetic: number };

/**
 * Return-to-prison metrics per release fiscal year. The database only supplies rows; every count and rate is computed
 * in `@tpw/shared`. Suppression happens there too, so a public response never holds the hidden numbers.
 */
export async function loadOutcomePanel(db: D1Database, view: View, asOf: string): Promise<OutcomePanel> {
  const [releases, events, followUps, negatives, benchmarks] = await Promise.all([
    db.prepare("SELECT person_key, release_id, release_date, post_program, is_synthetic FROM release_events WHERE post_program = 1").all<ReleaseRow>(),
    db.prepare("SELECT person_key, release_id, outcome_date, outcome_source FROM outcome_events WHERE outcome_type = 'return_to_prison'").all<EventInput>(),
    db.prepare("SELECT person_key, release_id, days_observed FROM follow_up_status").all<{ person_key: string; release_id: string; days_observed: number }>(),
    // A negative check is a successful lookup that found nobody in custody. Errors, blocks and unresolved matches say nothing.
    db.prepare("SELECT person_key, MAX(substr(checked_at, 1, 10)) AS last_negative_check FROM custody_checks WHERE result = 'not_found' GROUP BY person_key").all<{ person_key: string; last_negative_check: string }>(),
    db.prepare("SELECT source, cohort_fy, outcome_type, stratum_field, stratum_value, numerator, denominator, rate, period_note FROM benchmark_reference").all<BenchmarkRow>(),
  ]);

  const lastNegative = new Map(negatives.results.map((n) => [n.person_key, n.last_negative_check]));
  const byRelease = new Map<string, FollowUpInput>();
  for (const f of followUps.results) {
    byRelease.set(`${f.person_key}|${f.release_id}`, { ...f, last_negative_check: lastNegative.get(f.person_key) ?? null });
  }
  // A check can exist for a release that has no follow_up_status row (the locator does not write one).
  for (const r of releases.results) {
    const key = `${r.person_key}|${r.release_id}`;
    if (!byRelease.has(key) && lastNegative.has(r.person_key)) {
      byRelease.set(key, { person_key: r.person_key, release_id: r.release_id, days_observed: null, last_negative_check: lastNegative.get(r.person_key)! });
    }
  }

  const cohort = buildCohort(
    releases.results.map((r) => ({ ...r, post_program: r.post_program === 1, is_synthetic: r.is_synthetic === 1 })),
    events.results,
    [...byRelease.values()],
    asOf,
  );
  return buildOutcomePanel(cohort, benchmarks.results, view, asOf);
}
