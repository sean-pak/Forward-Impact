import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import { describe, expect, it } from "vitest";
import { buildCohort, countCohorts, type EventInput, type FollowUpInput, type ReleaseInput } from "@tpw/shared";

// Phase 13 done-when: our cohort rates match Muse's expected/cohort_outcome_metrics.csv (TPW_ALL, ALL programs, stratum all).
// Muse's output is not in the repo until the human drops it in `synthetic/` (docs/SEED_CONTRACT.md). Until then this file
// is skipped, and the hand-computed cases in packages/shared/src/outcomes.test.ts are the only check.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dir = join(root, "synthetic");
const files = ["canonical/release_event.csv", "canonical/outcome_event.csv", "expected/cohort_outcome_metrics.csv"];
const present = files.every((f) => existsSync(join(dir, f)));
const AS_OF = "2026-10-24"; // the date Muse censored at (schema-v2 11.5)

const read = (f: string) => Papa.parse<Record<string, string>>(readFileSync(join(dir, f), "utf8"), { header: true, skipEmptyLines: true }).data;
const bool = (s: string | undefined) => ["true", "1", "yes"].includes((s ?? "").trim().toLowerCase());
const num = (s: string | undefined) => (s === undefined || s.trim() === "" ? null : Number(s));

describe.skipIf(!present)("outcome metrics vs Muse's expected cohort_outcome_metrics.csv", () => {
  it("matches counts, rates and follow-up for every release fiscal year", () => {
    const releases: ReleaseInput[] = read("canonical/release_event.csv").map((r) => ({
      person_key: r.person_ref!, release_id: r.release_id!, release_date: r.release_date!, post_program: bool(r.post_program), is_synthetic: true,
    }));
    const events: EventInput[] = read("canonical/outcome_event.csv")
      .filter((r) => r.outcome_type === "return_to_prison")
      .map((r) => ({ person_key: r.person_ref!, release_id: r.release_id!, outcome_date: r.outcome_date!, outcome_source: r.outcome_source! }));
    const followUps: FollowUpInput[] = existsSync(join(dir, "canonical/follow_up_status.csv"))
      ? read("canonical/follow_up_status.csv").map((r) => ({ person_key: r.person_ref!, release_id: r.release_id!, days_observed: num(r.days_observed), last_negative_check: r.last_negative_check || null }))
      : [];
    const ours = new Map(countCohorts(buildCohort(releases, events, followUps, AS_OF).people).map((c) => [c.fiscal_year, c]));

    const expected = read("expected/cohort_outcome_metrics.csv").filter(
      (r) => r.org_id === "TPW_ALL" && r.program_id === "ALL" && r.outcome_type === "return_to_prison" && r.stratum_field === "all",
    );
    expect(expected.length).toBeGreaterThan(0);
    expect([...ours.keys()].sort()).toEqual(expected.map((e) => e.release_fiscal_year!).sort());

    for (const e of expected) {
      const c = ours.get(e.release_fiscal_year!)!;
      const label = e.release_fiscal_year!;
      expect(c.n_released, `${label} n_released`).toBe(num(e.n_released));
      for (const y of [1, 2, 3] as const) {
        expect(c.n_with[y], `${label} n_with_${y}yr`).toBe(num(e[`n_with_${y}yr`]));
        expect(c.n_event[y], `${label} n_event_${y}yr`).toBe(num(e[`n_event_${y}yr`]));
      }
      expect(c.follow_up_complete, `${label} follow_up_complete`).toBe(bool(e.follow_up_complete));
      const km = num(e.km_3yr_estimate);
      if (km !== null && c.km) expect(c.km.estimate, `${label} km_3yr_estimate`).toBeCloseTo(km, 2);
      const mix = e.outcome_source_mix ? (JSON.parse(e.outcome_source_mix) as Record<string, number>) : {};
      expect(Object.keys(c.source_mix).sort(), `${label} outcome_source_mix keys`).toEqual(Object.keys(mix).sort());
    }
  });
});
