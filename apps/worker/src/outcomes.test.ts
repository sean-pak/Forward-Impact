import { describe, expect, it } from "vitest";
import { OutcomePanelSchema } from "@tpw/shared";
import { app } from "./index";
import { loadOutcomePanel } from "./outcomes";
import { makeD1, sqlite } from "./testing/sqlite";

const SECRET = "test-secret";
const AS_OF = "2026-10-24";

const d = sqlite ? describe : describe.skip;

/** 40 synthetic people released 2022-01-01: 12 returned (simulated), 28 followed to day 1,095 with no return. */
function seed(a: ReturnType<typeof makeD1>) {
  const rel = (i: number, extra = "") =>
    a.raw.exec(`INSERT INTO release_events (release_id, person_key, release_date, release_fiscal_year, source, post_program, is_synthetic${extra ? ", release_type" : ""})
      VALUES ('r${i}', 'p${i}', '2022-01-01', 'FY2021_22', 'simulated', 1, 1${extra ? ", 'first_release'" : ""});`);
  for (let i = 0; i < 40; i++) rel(i);
  for (let i = 0; i < 12; i++) {
    a.raw.exec(`INSERT INTO outcome_events (person_key, release_id, outcome_type, outcome_date, outcome_date_precision, outcome_source, is_synthetic)
      VALUES ('p${i}', 'r${i}', 'return_to_prison', '2022-04-11', 'exact', 'simulated', 1);`);
  }
  for (let i = 12; i < 40; i++) {
    a.raw.exec(`INSERT INTO follow_up_status (person_key, release_id, days_observed, censored, follow_up_complete) VALUES ('p${i}', 'r${i}', 1095, 0, 1);`);
  }
  // Not in the cohort: released before the program, and a future release.
  a.raw.exec(`INSERT INTO release_events (release_id, person_key, release_date, source, post_program) VALUES ('x1', 'q1', '2021-01-01', 'simulated', 0), ('x2', 'q2', '2027-01-01', 'simulated', 1);`);
  a.raw.exec(`INSERT INTO benchmark_reference (source, cohort_fy, outcome_type, stratum_field, stratum_value, numerator, denominator, rate, period_note)
    VALUES ('CDCR Statewide Recidivism Report FY 2020-21', 'FY2020_21', 'return_to_prison', 'all', 'all', 6249, 30655, 0.204, 'COVID');`);
}

d("loadOutcomePanel", () => {
  it("counts the cohort, labels it SIMULATED and names the benchmark", async () => {
    const a = makeD1("analytics");
    seed(a);
    const panel = OutcomePanelSchema.parse(await loadOutcomePanel(a.db, "staff", AS_OF));
    expect(panel.rows).toHaveLength(1);
    const row = panel.rows[0]!;
    expect(row).toMatchObject({ fiscal_year: "FY2021_22", follow_up_complete: true, simulated: true, source_labels: ["SIMULATED"], source_mix: { simulated: 1 } });
    expect(row.n_released.value).toBe(40);
    // event on day 100: inside every window
    expect(row.rate_1yr).toMatchObject({ numerator: 12, denominator: 40, value: 0.3 });
    expect(row.rate_3yr).toMatchObject({ numerator: 12, denominator: 40 });
    expect(row.km_3yr.value).toBeCloseTo(0.3, 10);
    expect(panel.benchmark).toMatchObject({ cohort_fy: "FY2020_21", rate: 0.204 });
  });

  it("takes follow-up from the last not_found custody check when there is no follow_up_status row", async () => {
    const a = makeD1("analytics");
    a.raw.exec(`INSERT INTO release_events (release_id, person_key, release_date, source, post_program, is_synthetic) VALUES ('r1', 'p1', '2025-01-01', 'locator', 1, 1);
      INSERT INTO custody_checks (check_id, person_key, checked_at, source_system, query_method, method_of_access, result, match_confidence)
        VALUES ('c1', 'p1', '2025-07-01T10:00:00Z', 'mock_locator', 'cdcr_number', 'http_script', 'not_found', 'none'),
               ('c2', 'p1', '2026-01-01T10:00:00Z', 'mock_locator', 'cdcr_number', 'http_script', 'not_found', 'none'),
               ('c3', 'p1', '2026-09-01T10:00:00Z', 'mock_locator', 'cdcr_number', 'http_script', 'error', 'none');`);
    const row = (await loadOutcomePanel(a.db, "staff", AS_OF)).rows[0]!;
    // 2025-01-01 to 2026-01-01 is 365 days; the later error says nothing
    expect(row.rate_1yr).toMatchObject({ numerator: 0, denominator: 1 });
    expect(row.rate_2yr).toMatchObject({ numerator: 0, denominator: 0 });
  });

  it("leaves out an unverified locator hit", async () => {
    const a = makeD1("analytics");
    a.raw.exec(`INSERT INTO release_events (release_id, person_key, release_date, source, post_program, is_synthetic) VALUES ('r1', 'p1', '2024-01-01', 'locator', 1, 1);
      INSERT INTO outcome_events (person_key, release_id, outcome_type, outcome_date, outcome_date_precision, outcome_source)
        VALUES ('p1', 'r1', 'return_to_prison', '2024-03-01', 'exact', 'eit_locator_unverified');`);
    const panel = await loadOutcomePanel(a.db, "staff", AS_OF);
    expect(panel.rows[0]!.rate_1yr).toMatchObject({ numerator: 0, denominator: 0 });
    expect(panel.flags.unverified_event_excluded).toBe(1);
  });
});

d("GET /api/admin/outcomes", () => {
  const call = (a: ReturnType<typeof makeD1>, path: string, auth = true) =>
    app.fetch(new Request(`https://w.test${path}`, { headers: auth ? { Authorization: `Bearer ${SECRET}` } : {} }), { DB: a.db, API_SECRET: SECRET } as never);

  it("needs the bearer secret", async () => {
    const a = makeD1("analytics");
    expect((await call(a, "/api/admin/outcomes", false)).status).toBe(401);
  });

  it("public view: a cohort of 40 with 12 events shows n and N; a cohort under 30 shows no numbers at all", async () => {
    const a = makeD1("analytics");
    seed(a);
    for (let i = 100; i < 110; i++) {
      a.raw.exec(`INSERT INTO release_events (release_id, person_key, release_date, source, post_program, is_synthetic) VALUES ('r${i}', 'p${i}', '2023-01-01', 'simulated', 1, 1);
        INSERT INTO outcome_events (person_key, release_id, outcome_type, outcome_date, outcome_date_precision, outcome_source) VALUES ('p${i}', 'r${i}', 'return_to_prison', '2023-02-01', 'exact', 'simulated');`);
    }
    const res = await call(a, "/api/admin/outcomes?view=public");
    expect(res.status).toBe(200);
    const panel = OutcomePanelSchema.parse(await res.json());
    const [big, small] = panel.rows;
    expect(big!.rate_1yr).toMatchObject({ suppressed: false, numerator: 12, denominator: 40 });
    expect(small).toMatchObject({ fiscal_year: "FY2022_23", suppressed: true });
    const text = JSON.stringify(small);
    expect(text).not.toContain('"numerator"');
    expect(text).not.toMatch(/"value":\s*(?!null)\d/);
  });
});
