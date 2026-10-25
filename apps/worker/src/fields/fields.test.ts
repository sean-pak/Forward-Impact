import { describe, expect, it } from "vitest";
import type { CycleFormRow } from "@tpw/shared";
import { loadForm, writeSubmission, type OrgRow } from "../form";
import { handleReply, startConversation, type Deps, type Inbound } from "../reply";
import { classify, makeGmail, scripted } from "../testing/mail";
import { makeD1, sqlite } from "../testing/sqlite";
import { addField, approveField, dismissField, listFields, reactivateField, recordHeaderSightings, retireField } from "./fields";

const org: OrgRow = { org_id: "o1", org_name: "Dana Arts", primary_contact_email: "dana@real.test", is_synthetic: 0 };

const row = (o: Partial<CycleFormRow> = {}): CycleFormRow => ({
  program_id: "", program_name: "Writing Circle", facility_raw: "San Quentin", yard: "", start_date: "2026-01-05", end_date: "2026-03-01",
  sessions_planned: "", course_hours_planned_per_participant: "", n_enrolled: "20", n_completed: "15", total_course_hours_delivered: "",
  n_enrolled_approx: false, n_completed_approx: false, total_course_hours_delivered_approx: false, completion_rule: "attended all sessions", extra: {}, ...o,
});

function setup() {
  const d = makeD1("analytics");
  d.raw.exec(`INSERT INTO orgs (org_id, org_name, data_persona, primary_contact_email, form_token, is_synthetic) VALUES ('o1','Dana Arts',2,'dana@real.test','ftok',0);`);
  const g = makeGmail();
  const send = async (submissionId: string, text?: string, llm = scripted({}).llm) => {
    const deps: Deps = { db: d.db, gmail: g.gmail, llm };
    g.receive("T1", text ?? "data", [], "Program data");
    const inbound: Inbound = {
      gmailId: `m${g.sent.length + 1}`, threadId: "T1", from: "dana@real.test", subject: "Program data", text: text ?? "data",
      rfcMessageId: "<m@real.test>", references: null, occurredAt: new Date().toISOString(),
    };
    return text === undefined ? startConversation(deps, submissionId, inbound) : handleReply(deps, submissionId, inbound);
  };
  const submit = async (r: CycleFormRow = row()) => {
    const w = await writeSubmission(d.db, org, [r], {
      channel: "email_body", parserVersion: "t", llmMappingUsed: false, detectedPersona: 2, senderEmail: "dana@real.test", duplicates: "flag", askMissingCompleted: true,
    });
    if (!w.ok) throw new Error(w.error);
    return w.submission_id;
  };
  return { ...d, g, send, submit };
}

describe.skipIf(!sqlite)("field registry (real SQLite)", () => {
  it("add 'RAC eligible?' -> the email asks it, the form shows it, YES lands in extra without a model, retire stops both", async () => {
    const { db, q, g, send, submit } = setup();
    const added = await addField(db, { label: "RAC eligible?", type: "boolean" });
    expect(added).toMatchObject({ ok: true, field_key: "rac_eligible" });

    // The form shows it.
    expect((await loadForm(db, "ftok"))!.fields.map((f) => f.field_key)).toEqual(["rac_eligible"]);

    // The next email asks it: the only open item, one question, in code-template words.
    const sub = await submit();
    expect(await send(sub)).toMatchObject({ action: "ask" });
    expect(g.sent).toHaveLength(1);
    expect(g.sent[0]!.text).toContain("For Writing Circle: RAC eligible? Please reply YES or NO.");
    expect(q("SELECT status FROM submissions")).toEqual([{ status: "awaiting_confirmation" }]); // an optional field never blocks

    // A plain YES answers it directly: the model is never called (an empty script would throw).
    const m = scripted({});
    expect(await send(sub, "Yes", m.llm)).toMatchObject({ action: "receipt" });
    expect(m.calls).toEqual([]);
    expect(JSON.parse(q("SELECT extra FROM program_cycles")[0]!.extra as string)).toMatchObject({ rac_eligible: true });
    expect(g.sent.at(-1)!.text).not.toContain("RAC eligible");

    // Retire: no longer on the form, and the next submission is not asked. The stored answer stays.
    expect(await retireField(db, "rac_eligible")).toEqual({ ok: true });
    expect(await loadForm(db, "ftok")).toMatchObject({ fields: [] });
    const sub2 = await submit(row({ start_date: "2026-04-01", end_date: "2026-06-01" }));
    const before = g.sent.length;
    expect(await send(sub2)).toMatchObject({ action: "receipt" });
    expect(g.sent[before]!.text).not.toContain("RAC eligible");
    expect(JSON.parse(q("SELECT extra FROM program_cycles WHERE submission_id = ?", sub)[0]!.extra as string)).toMatchObject({ rac_eligible: true });

    // Reactivating brings both back.
    expect(await reactivateField(db, "rac_eligible")).toEqual({ ok: true });
    expect((await loadForm(db, "ftok"))!.fields).toHaveLength(1);
  });

  it("NO is stored as false; a long reply goes to the model; a required blank field uses the template and still does not block", async () => {
    const { db, q, g, send, submit } = setup();
    await addField(db, { label: "Needs interpreter?", type: "boolean", required: true, ask_template: "Did {program} at {facility} need an interpreter?" });
    const sub = await submit();
    await send(sub);
    expect(g.sent[0]!.text).toContain("Did Writing Circle at San Quentin Rehabilitation Center need an interpreter? Please reply YES or NO.");
    expect(q("SELECT status FROM submissions")).toEqual([{ status: "awaiting_confirmation" }]);
    await send(sub, "No");
    expect(JSON.parse(q("SELECT extra FROM program_cycles")[0]!.extra as string)).toMatchObject({ needs_interpreter: false });

    // A sentence is not a plain yes/no: it goes through the classifier like any other reply.
    const sub2 = await submit(row({ start_date: "2026-05-01", end_date: "2026-07-01" }));
    await send(sub2);
    const m = scripted({ classify_reply: [classify("answer", { field_key: "needs_interpreter", value: "yes" })] });
    await send(sub2, "Yes, for two of the sessions", m.llm);
    expect(m.calls).toEqual(["classify_reply"]);
    expect(JSON.parse(q("SELECT extra FROM program_cycles WHERE submission_id = ?", sub2)[0]!.extra as string)).toMatchObject({ needs_interpreter: true });
  });

  it("a blank optional field is asked after the core questions, and a choice field lists its options", async () => {
    const { db, g, send, submit } = setup();
    await addField(db, { label: "Track", type: "enum", options: ["Reentry", "Wellness"] });
    await send(await submit(row({ completion_rule: "", n_completed: "" })));
    expect(g.sent[0]!.text).toContain("How many people completed Writing Circle"); // core first
    expect(g.sent[0]!.text).not.toContain("Track");
    await send(await submit(row({ start_date: "2026-06-01", end_date: "2026-08-01" })));
    expect(g.sent[1]!.text).toContain("For Writing Circle: Track? Please choose one of: Reentry, Wellness.");
  });

  it("add and status rules", async () => {
    const { db, raw } = setup();
    // The migrations do not seed the built-in fields (the seed loader does), so add one the way the loader would.
    raw.exec("INSERT INTO fields (field_key, label, type, required, ask_template, status, is_core) VALUES ('n_enrolled','People enrolled','integer',1,'How many?','active',1)");
    expect(await addField(db, { label: "Start date", type: "text" })).toMatchObject({ ok: false, status: 400 });
    expect(await addField(db, { label: "Track", type: "enum", options: ["One"] })).toMatchObject({ ok: false, status: 400 });
    expect(await addField(db, { label: "Grant year", type: "integer" })).toMatchObject({ ok: true });
    expect(await addField(db, { label: "Grant year", type: "integer" })).toMatchObject({ ok: false, status: 409 });
    await retireField(db, "grant_year");
    expect(await addField(db, { label: "Grant year", type: "integer" })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("reactivate") });
    // Built-in fields cannot be touched, unknown keys 404, wrong status 409.
    expect(await retireField(db, "n_enrolled")).toMatchObject({ ok: false, status: 409 });
    expect(await retireField(db, "nope")).toMatchObject({ ok: false, status: 404 });
    expect(await approveField(db, "grant_year")).toMatchObject({ ok: false, status: 409 });
    const all = await listFields(db);
    expect(all.find((f) => f.field_key === "n_enrolled")).toMatchObject({ is_core: true, status: "active" });
    expect(all.find((f) => f.field_key === "grant_year")).toMatchObject({ status: "retired" });
  });

  it("a header seen twice becomes a pending field; approve activates it; dismiss retires it for good; retired keys never come back", async () => {
    const { db, q } = setup();
    const h = { key: "grant_year", label: "Grant year" };
    await recordHeaderSightings(db, [h]);
    expect((await listFields(db)).some((f) => f.field_key === "grant_year")).toBe(false);
    await recordHeaderSightings(db, [h]);
    expect((await listFields(db)).find((f) => f.field_key === "grant_year")).toMatchObject({ status: "pending", type: "text", seen_count: 2 });
    // Pending fields are neither asked nor on the form.
    expect((await loadForm(db, "ftok"))!.fields).toEqual([]);

    expect(await approveField(db, "grant_year", { type: "integer" })).toEqual({ ok: true });
    expect((await loadForm(db, "ftok"))!.fields).toMatchObject([{ field_key: "grant_year", type: "integer" }]);

    const t = { key: "tutor_hours", label: "Tutor hours" };
    await recordHeaderSightings(db, [t, t]);
    expect(await dismissField(db, "tutor_hours")).toEqual({ ok: true });
    await recordHeaderSightings(db, [t, t, t]);
    expect(q("SELECT status FROM fields WHERE field_key = 'tutor_hours'")).toEqual([{ status: "retired" }]);
    expect(q("SELECT dismissed FROM field_suggestions WHERE field_key = 'tutor_hours'")).toEqual([{ dismissed: 1 }]);

    // Approve refuses a choice type without options.
    await recordHeaderSightings(db, [{ key: "track", label: "Track" }, { key: "track", label: "Track" }]);
    expect(await approveField(db, "track", { type: "enum" })).toMatchObject({ ok: false, status: 400 });
    expect(q("SELECT status FROM fields WHERE field_key = 'track'")).toEqual([{ status: "pending" }]);
  });

  it("table ingest: a matching header fills extra, unused headers are counted, an identifier header is never suggested", async () => {
    const { db, q } = setup();
    await addField(db, { label: "RAC eligible?", type: "boolean" });
    const { ingest } = await import("../ingest");
    const csv = (cells: string[][]) => new TextEncoder().encode(cells.map((r) => r.join(",")).join("\n"));
    const header = ["Program", "Prison", "Start", "Enrolled", "RAC Eligible", "Grant year", "Participant Name", "CDCR #"];
    const data = ["Writing Circle", "San Quentin", "2026-01-05", "20", "Yes", "2026", "SYN-Jane Roe", "SYN00001"];
    // Two uploads: the second one promotes "Grant year".
    for (let i = 0; i < 2; i++) {
      const l = scripted({ map_columns: [{ persona: 1, unmapped_marks: [], columns: [
        { index: 0, target: "program_name" }, { index: 1, target: "facility_raw" }, { index: 2, target: "start_date" }, { index: 3, target: "n_enrolled" },
        { index: 4, target: "ignore" }, { index: 5, target: "ignore" }, { index: 6, target: "ignore" }, { index: 7, target: "ignore" },
      ] }] });
      const out = await ingest(db, l.llm, org, { kind: "table", filename: "t.csv", bytes: csv([header, data.map((v, j) => (i === 1 && j === 2 ? "2026-02-02" : v))]) }, { channel: "email_attachment", senderEmail: "dana@real.test" });
      expect(out.submission_id).toBeTruthy();
      expect(JSON.parse(q("SELECT extra FROM program_cycles ORDER BY rowid DESC LIMIT 1")[0]!.extra as string)).toMatchObject({ rac_eligible: true });
    }
    expect(q("SELECT field_key, status FROM fields WHERE is_core = 0 ORDER BY field_key")).toEqual([
      { field_key: "grant_year", status: "pending" }, { field_key: "rac_eligible", status: "active" },
    ]);
    // Identifier headers and the matched header leave no trace; only headers were stored.
    expect(q("SELECT field_key FROM field_suggestions ORDER BY field_key")).toEqual([{ field_key: "grant_year" }]);
    expect(JSON.stringify(q("SELECT * FROM field_suggestions"))).not.toMatch(/Jane|SYN0|CDCR|Name/i);
  });
});
