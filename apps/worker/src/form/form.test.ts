import { describe, expect, it } from "vitest";
import type { CycleFormRow } from "@tpw/shared";
import { confirmSubmission, getSubmission, loadForm, submitForm } from "./form";

type Call = { sql: string; params: unknown[] };

function fakeD1(answer: (sql: string, params: unknown[]) => unknown = () => null) {
  const calls: Call[] = [];
  const bound = (sql: string, params: unknown[]) => ({
    sql, params,
    run: async () => (calls.push({ sql, params }), { meta: { changes: 1 } }),
    first: async () => answer(sql, params),
    all: async () => ({ results: (answer(sql, params) as unknown[]) ?? [] }),
  });
  const db = {
    prepare: (sql: string) => ({ ...bound(sql, []), bind: (...p: unknown[]) => bound(sql, p) }),
    batch: async (list: { sql: string; params: unknown[] }[]) => (list.forEach((s) => calls.push({ sql: s.sql, params: s.params })), []),
  } as unknown as D1Database;
  return { db, calls };
}

const row = (o: Partial<CycleFormRow> = {}): CycleFormRow => ({
  program_id: "", program_name: "Writing Circle", facility_raw: "San Quentin", yard: "", start_date: "2025-02-01",
  end_date: "", sessions_planned: "", course_hours_planned_per_participant: "", n_enrolled: "30", n_completed: "",
  total_course_hours_delivered: "", n_enrolled_approx: false, n_completed_approx: false,
  total_course_hours_delivered_approx: false, completion_rule: "", extra: {}, ...o,
});

const org = { org_id: "o1", org_name: "Org One", primary_contact_email: "a@real.test", is_synthetic: 0 };
const answer = (sql: string) => {
  if (sql.includes("FROM orgs WHERE form_token")) return org;
  if (sql.includes("FROM fields")) return [];
  if (sql.includes("lower(program_name)")) return [];
  return null;
};

describe("submitForm", () => {
  it("404s on an unknown token", async () => {
    const { db } = fakeD1(() => null);
    expect(await submitForm(db, "nope", [row()])).toMatchObject({ ok: false, status: 404 });
  });

  it("writes submission (channel form), a new program, an awaiting_confirmation cycle, and no issues", async () => {
    const { db, calls } = fakeD1(answer);
    const r = await submitForm(db, "tok", [row()]);
    expect(r).toMatchObject({ ok: true, blocked: false });
    const sub = calls.find((c) => c.sql.includes("INSERT INTO submissions"))!;
    expect(sub.sql).toContain("'form'");
    expect(sub.params).toContain("awaiting_confirmation");
    expect(calls.some((c) => c.sql.includes("INSERT INTO programs"))).toBe(true);
    const cyc = calls.find((c) => c.sql.includes("INSERT INTO program_cycles"))!;
    expect(cyc.params).toContain("awaiting_confirmation");
    expect(cyc.params[1]).toMatch(/^o1\|prog_.+\|SQ\|2025-02-01$/);
    expect(calls.some((c) => c.sql.includes("INSERT INTO field_issues"))).toBe(false);
  });

  it("a missing required value becomes a draft cycle with an issue and a needs_info submission", async () => {
    const { db, calls } = fakeD1(answer);
    const r = await submitForm(db, "tok", [row({ n_enrolled: "" })]);
    expect(r).toMatchObject({ ok: true, blocked: true });
    expect(calls.find((c) => c.sql.includes("INSERT INTO submissions"))!.params).toContain("needs_info");
    expect(calls.find((c) => c.sql.includes("INSERT INTO program_cycles"))!.params).toContain("draft");
    const issue = calls.find((c) => c.sql.includes("INSERT INTO field_issues"))!;
    expect(issue.params).toContain("missing_required");
    expect(calls.find((c) => c.sql.includes("INSERT INTO program_cycles"))!.params[10]).toBeNull();
  });

  it("ignores pre-filled rows with no dates or counts, and rejects an all-blank form", async () => {
    const { db } = fakeD1(answer);
    expect(await submitForm(db, "tok", [row({ start_date: "", n_enrolled: "" })])).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects a program id from another org and a duplicate cycle", async () => {
    const { db } = fakeD1(answer);
    expect(await submitForm(db, "tok", [row({ program_id: "someone_elses" })])).toMatchObject({ ok: false, status: 400 });
    expect(await submitForm(db, "tok", [row(), row()])).toMatchObject({ ok: false, error: expect.stringContaining("twice") });
  });

  it("stores completion rule as staging in extra, never on the program until confirm", async () => {
    const { db, calls } = fakeD1(answer);
    await submitForm(db, "tok", [row({ completion_rule: "attendance >= 80%" })]);
    expect(calls.find((c) => c.sql.includes("INSERT INTO program_cycles"))!.params).toContain('{"_completion_rule":"attendance >= 80%"}');
    expect(calls.some((c) => c.sql.includes("UPDATE programs"))).toBe(false);
  });
});

describe("confirmSubmission", () => {
  const sub = (status: string) => (sql: string) => {
    if (sql.includes("FROM orgs WHERE form_token")) return org;
    if (sql.includes("FROM submissions WHERE submission_id")) return { submission_id: "s1", status };
    if (sql.includes("FROM program_cycles c JOIN")) return [];
    if (sql.includes("FROM field_issues")) return [];
    if (sql.includes("SELECT cycle_id, cycle_key")) return [{ cycle_id: "c1", cycle_key: "o1|p|SQ|2025-02-01", program_id: "p", extra: '{"_completion_rule":"attendance >= 80%"}' }];
    return null;
  };

  it("confirms, supersedes the earlier cycle with the same key, and applies the stated rule", async () => {
    const { db, calls } = fakeD1(sub("awaiting_confirmation"));
    expect(await confirmSubmission(db, "tok", "s1")).toEqual({ ok: true, already: false });
    const sqls = calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes("SET status = 'superseded'"))).toBe(true);
    expect(sqls.some((s) => s.includes("SET status = 'confirmed' WHERE cycle_id"))).toBe(true);
    expect(calls.find((c) => c.sql.includes("UPDATE programs"))!.params).toEqual(["attendance >= 80%", "p"]);
    expect(sqls.some((s) => s.includes("UPDATE submissions SET status = 'confirmed'"))).toBe(true);
  });

  it("refuses a submission that needs info, and is idempotent when already confirmed", async () => {
    const needs = fakeD1(sub("needs_info"));
    expect(await confirmSubmission(needs.db, "tok", "s1")).toMatchObject({ ok: false, status: 409 });
    expect(needs.calls).toEqual([]);
    const done = fakeD1(sub("confirmed"));
    expect(await confirmSubmission(done.db, "tok", "s1")).toEqual({ ok: true, already: true });
    expect(done.calls).toEqual([]);
  });

  it("lists an earlier entry with the same cycle key as a duplicate, and not once confirmed", async () => {
    const dup = { cycle_id: "c0", program_name: "Writing", facility_name: "San Quentin Rehabilitation Center", start_date: "2025-02-01", n_enrolled: 30, n_completed: null, submitted_at: "2025-03-01T11:45:00Z" };
    const answerWith = (status: string) => (sql: string, p: unknown[]) => {
      if (sql.includes("JOIN program_cycles o")) return p[1] === "confirmed" ? [] : [dup];
      return sub(status)(sql);
    };
    const pending = await getSubmission(fakeD1(answerWith("awaiting_confirmation")).db, "tok", "s1");
    expect(pending!.duplicates).toEqual([dup]);
    expect((await getSubmission(fakeD1(answerWith("confirmed")).db, "tok", "s1"))!.duplicates).toEqual([]);
  });

  it("does not show a submission to another org's token", async () => {
    const { db } = fakeD1((sql) => (sql.includes("FROM orgs WHERE form_token") ? org : null));
    expect(await getSubmission(db, "tok", "s_other")).toBeNull();
  });
});

describe("loadForm", () => {
  it("pre-fills stable details from the last confirmed cycle, never dates or counts", async () => {
    const { db } = fakeD1((sql) => {
      if (sql.includes("FROM orgs WHERE form_token")) return org;
      if (sql.includes("FROM fields")) return [];
      if (sql.includes("FROM programs WHERE org_id")) return [{ program_id: "p", program_name: "Writing", completion_rule: "80%" }];
      if (sql.includes("FROM program_cycles WHERE org_id"))
        return [{ program_id: "p", facility_code: "SQ", yard: "Yard A", sessions_planned: 12, course_hours_planned_per_participant: 24, extra: "{}" }];
      return null;
    });
    const f = await loadForm(db, "tok");
    expect(f!.facilities).toHaveLength(31);
    expect(f!.programs[0]).toMatchObject({ program_name: "Writing", prefill: { facility_name: "San Quentin Rehabilitation Center", yard: "Yard A", sessions_planned: "12" } });
    expect(Object.keys(f!.programs[0]!.prefill)).not.toContain("start_date");
  });
});
