import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../index";
import { syncGmail } from "../gmail/sync";
import { Vault } from "../vault";
import { importVaultKeys, toBase64 } from "../vault/crypto";
import { personKey } from "../vault/personKey";
import { TEST_ENC_B64, TEST_HMAC_B64, testKeys } from "../vault/testKeys";
import { makeGmail, scripted } from "../testing/mail";
import { makeD1, readFixture, readJson, ROOT, sqlite } from "../testing/sqlite";

// Phase 10 acceptance checks, written separately from the build. The expected numbers here are computed in this file
// straight from the raw fixture files, not read from the generator's *.expected.json, so a bug shared by the generator
// and the parser cannot hide. The upload goes through the real HTTP route and the real OpenRouter client; only the
// network call to OpenRouter is replaced, so the request body the model would see is checked byte for byte.

const TODAY = "2026-10-25";
const SECRET = "test-secret";
const csvRows = (file: string) => Papa.parse<string[]>(readFixture(file).toString("utf8"), { skipEmptyLines: "greedy" }).data;
const iso = (d: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const [m, day, y] = d.split("/");
  return `${y}-${m!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
};

// ---------- independent ground truth ----------

function persona4Truth() {
  const [, ...rows] = csvRows("org_d_persona4_individuals.csv");
  const cycles = new Map<string, { enrolled: Set<string>; completed: number; credits: number }>();
  const people = new Map<string, { cdcr: string; name: string; dob: string; release: string | null; starts: string[]; supervision: string }>();
  for (const r of rows) {
    const [name, cdcr, dob, program, facility, start, , , grad, credits, release, supervision] = r as string[];
    const id = cdcr || name!;
    const k = `${program}|${facility}|${start}`;
    const c = cycles.get(k) ?? { enrolled: new Set(), completed: 0, credits: 0 };
    c.enrolled.add(id);
    if (grad!.trim().toUpperCase() === "Y") c.completed++;
    c.credits += Number(credits || 0);
    cycles.set(k, c);
    const p = people.get(id) ?? { cdcr: cdcr!, name: name!, dob: dob!, release: release ? iso(release) : null, starts: [], supervision: supervision! };
    p.starts.push(start!);
    people.set(id, p);
  }
  return { rows: rows.length, cycles, people };
}

const PRESENT = new Set(["X", "✓", "P", "1"]);
function persona3Truth(lateCounts: boolean) {
  const all = csvRows("org_c_persona3_attendance.csv");
  const header = all[2]!;
  const people = all.slice(3);
  const dateCols = header.map((h, j) => (/^\d{4}-\d{2}-\d{2}$/.test(h) ? j : -1)).filter((j) => j >= 0);
  const cancelled = dateCols.filter((j) => people.every((p) => !p[j]?.trim()));
  const live = dateCols.filter((j) => !cancelled.includes(j));
  const out = people.map((p) => {
    let attended = 0;
    for (const j of live) {
      const m = (p[j] ?? "").trim().toUpperCase();
      if (PRESENT.has(m) || (m === "L" && lateCounts)) attended++;
    }
    // Same convention the code documents: excused (E, JT) is planned but not attended.
    const planned = live.length;
    return { name: p[0]!, cdcr: p[1]!, attended, planned, completed: attended / planned >= 0.8, cbo: (p[header.length - 1] ?? "").trim().toUpperCase() === "Y" };
  });
  return { header, dateCols, cancelled, live, people: out };
}

// ---------- a Worker with real SQLite behind both bindings ----------

async function worker() {
  const a = makeD1("analytics");
  const v = makeD1("vault");
  a.raw.exec(`INSERT INTO orgs (org_id, org_name, data_persona, primary_contact_email, form_token, is_synthetic) VALUES
    ('od','Org D',1,'d@real.test','tok_d',0), ('oc','Org C',3,'dana@real.test','tok_c',0);
    INSERT INTO contacts (contact_id, org_id, name, email, is_primary, is_synthetic) VALUES ('kc','oc','Dana','dana@real.test',1,0);
    INSERT INTO programs (program_id, org_id, program_name, is_synthetic) VALUES ('pc','oc','Healing Circle',0);`);
  const env = {
    DB: a.db, VAULT: v.db, VAULT_HMAC_KEY: TEST_HMAC_B64, VAULT_ENC_KEY: TEST_ENC_B64, API_SECRET: SECRET,
    OPENROUTER_API_KEY: "k", LLM_MODEL: "test/model",
    GOOGLE_CLIENT_ID: "i", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r", MAILBOX_ADDRESS: "hello@example.org",
  };
  const call = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`https://w.test${path}`, { ...init, headers: { Authorization: `Bearer ${SECRET}`, ...(init.headers ?? {}) } }), env as never);
  const upload = async (orgId: string, file: string, type: string) => {
    const form = new FormData();
    form.set("org_id", orgId);
    form.set("file", new File([readFixture(file)], file, { type }));
    return call("/api/ingest/upload", { method: "POST", body: form });
  };
  const vault = new Vault(v.db, await testKeys());
  return { a, v, env, call, upload, vault };
}

/** Replaces only the HTTPS call to OpenRouter. Answers with the recorded mapping and keeps every request body. */
function fakeOpenRouter(answers: Record<string, unknown>) {
  const bodies: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (!String(url).startsWith("https://openrouter.ai/")) throw new Error(`unexpected network call to ${url}`);
    const body = String(init.body);
    bodies.push(body);
    const name = JSON.parse(body).response_format.json_schema.name as string;
    if (!(name in answers)) return new Response(JSON.stringify({ error: { message: `no answer for ${name}` } }), { status: 500 });
    return Response.json({ choices: [{ message: { content: JSON.stringify(answers[name]) } }] });
  });
  return bodies;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.skipIf(!sqlite)("phase 10 done-when, checked independently", () => {
  it("persona 4 by /api/ingest/upload: per-program counts match the raw CSV, nothing counts until confirm", async () => {
    const w = await worker();
    const truth = persona4Truth();
    const bodies = fakeOpenRouter({ map_columns: readJson("org_d_persona4_individuals.llm.json").map_columns });
    const before = await (await w.call("/api/admin/summary")).text();

    const res = await w.upload("od", "org_d_persona4_individuals.csv", "text/csv");
    expect(res.status).toBe(200);
    const out = (await res.json()) as { submission_id: string; status: string; cycles: number };
    expect(out).toMatchObject({ status: "awaiting_confirmation", cycles: truth.cycles.size });
    expect(bodies).toHaveLength(1);

    const got = w.a.q(`SELECT p.program_name AS program, f.facility_name AS facility, c.facility_code AS code, c.start_date AS start,
                              c.n_enrolled AS enrolled, c.n_completed AS completed, c.source_grain, c.status, c.cycle_id
                       FROM program_cycles c JOIN programs p USING (program_id) LEFT JOIN facilities f USING (facility_code)`);
    expect(got).toHaveLength(truth.cycles.size);
    for (const [k, t] of truth.cycles) {
      const [program, , start] = k.split("|");
      const row = got.find((g) => g.program === program && g.start === start);
      expect(row, k).toBeDefined();
      expect(row, k).toMatchObject({ enrolled: t.enrolled.size, completed: t.completed, source_grain: "derived_from_individuals", status: "awaiting_confirmation" });
      const credits = w.a.q("SELECT sum(credit_days_earned) AS n FROM credit_awards WHERE cycle_id = ?", row!.cycle_id)[0]!.n;
      expect(credits, `${k} credits`).toBe(t.credits);
    }
    // Same person in two programs: one vault row, one enrollment per program.
    expect(w.v.q("SELECT count(*) AS n FROM person_identity")[0]!.n).toBe(truth.people.size);
    expect(w.a.q("SELECT count(*) AS n FROM enrollments")[0]!.n).toBe(truth.rows);

    // Unconfirmed: the dashboard is unchanged and no outcome tables are written.
    expect(await (await w.call("/api/admin/summary")).text()).toBe(before);
    for (const t of ["release_events", "custody_status", "person_attributes"]) expect(w.a.q(`SELECT count(*) AS n FROM ${t}`)[0]!.n, t).toBe(0);

    // The staff page reports the scrambled counts (and only counts).
    const view = await (await w.call(`/api/submissions/${out.submission_id}`)).text();
    const withCdcr = [...truth.people.values()].filter((p) => p.cdcr).length;
    expect(w.a.q("SELECT scrambled_names AS n, scrambled_cdcr AS c FROM submissions")[0]).toEqual({ n: truth.people.size, c: withCdcr });
    expect(view).not.toMatch(/SYN\d{5}/);
  });

  it("persona 4 after confirm: each person's release, projected release and post_program flag match the CSV", async () => {
    const w = await worker();
    const truth = persona4Truth();
    fakeOpenRouter({ map_columns: readJson("org_d_persona4_individuals.llm.json").map_columns });
    const out = (await (await w.upload("od", "org_d_persona4_individuals.csv", "text/csv")).json()) as { submission_id: string };
    const { confirmById } = await import("../form");
    expect((await confirmById(w.a.db, out.submission_id)).ok).toBe(true);

    // Map people back through the audited vault call (the only way to see who is who).
    const keys = w.a.q("SELECT DISTINCT person_key FROM enrollments").map((r) => r.person_key as string);
    const ids = await w.vault.reidentify(keys, { purpose: "admin_vault_view", actor: "phase10-verify" });
    expect(w.v.q("SELECT n_person_keys AS n FROM vault_access_log")).toEqual([{ n: truth.people.size }]);
    const keyOf = new Map(ids.map((i) => [i.cdcrNumber ?? `${i.firstName} ${i.lastName}`, i.personKey]));

    let released = 0, projected = 0, prePrograms = 0;
    for (const [id, p] of truth.people) {
      const key = keyOf.get(id);
      expect(key, id).toBeDefined();
      const rel = w.a.q("SELECT release_date, post_program, release_type, source FROM release_events WHERE person_key = ?", key);
      const cus = w.a.q("SELECT status, projected_release_date FROM custody_status WHERE person_key = ?", key);
      if (p.release && p.release <= TODAY) {
        released++;
        const earliest = [...p.starts].sort()[0]!;
        if (p.release < earliest) prePrograms++;
        expect(rel, id).toEqual([{ release_date: p.release, post_program: p.release >= earliest ? 1 : 0, release_type: "unknown", source: "cbo_report" }]);
        expect(cus[0]?.status, id).toBe("released");
      } else if (p.release) {
        projected++;
        expect(rel, `${id} future date is not a release`).toEqual([]);
        expect(cus, id).toEqual([{ status: "in_custody", projected_release_date: p.release }]);
      }
    }
    expect(released).toBeGreaterThan(0);
    expect(projected).toBeGreaterThan(0);
    expect(prePrograms).toBeGreaterThan(0); // the fixture really has releases before the program started
    expect(w.a.q("SELECT count(*) AS n FROM release_events")[0]!.n).toBe(released);
    expect(w.a.q("SELECT count(*) AS n FROM release_events WHERE post_program = 0")[0]!.n).toBe(prePrograms);
    expect(w.a.q("SELECT count(*) AS n FROM program_cycles WHERE status = 'confirmed'")[0]!.n).toBe(truth.cycles.size);
  });

  it("uploading the same persona 4 file twice does not create a second vault row per person", async () => {
    const w = await worker();
    fakeOpenRouter({ map_columns: readJson("org_d_persona4_individuals.llm.json").map_columns });
    await w.upload("od", "org_d_persona4_individuals.csv", "text/csv");
    await w.upload("od", "org_d_persona4_individuals.csv", "text/csv");
    expect(w.v.q("SELECT count(*) AS n FROM person_identity")[0]!.n).toBe(persona4Truth().people.size);
  });

  it("persona 3 XLSX by email: legend question, answer applied, per-person attended/planned match the raw sheet", async () => {
    const w = await worker();
    const truth = persona3Truth(true);
    const g = makeGmail();
    const m = scripted({
      map_columns: readJson("org_c_persona3_attendance.llm.json").map_columns,
      classify_legend: [{ marks: [{ mark: "JT", meaning: "excused" }, { mark: "L", meaning: "late" }], late_counts_as_attended: true }],
    });
    const xlsx = { filename: "attendance.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: new Uint8Array(readFixture("org_c_persona3_attendance.xlsx")) };
    g.receive("T9", "Attendance for spring.", [xlsx]);
    await syncGmail(w.env as never, g.gmail, m.llm);
    expect(g.sent).toHaveLength(1);
    expect(g.sent[0]!.text).toMatch(/What do 'JT' and 'L' mean/);
    expect(g.sent[0]!.text).toMatch(/does a late count as attended/i);
    expect(g.sent[0]!.text).toContain("I have one question before I can count it"); // one topic: the legend, with late as its sub-part
    expect(g.sent[0]!.text).not.toMatch(/duplicate|same person/i); // the duplicate waits for its own email

    g.receive("T9", "JT = excused for court, L = late, and late counts as attended.");
    await syncGmail(w.env as never, g.gmail, m.llm);

    // Sessions: the two blank columns are cancelled and excluded from planned.
    expect(w.a.q("SELECT count(*) AS n FROM sessions")[0]!.n).toBe(truth.dateCols.length);
    const cancelledDates = truth.cancelled.map((j) => truth.header[j]);
    expect(w.a.q("SELECT session_date AS d FROM sessions WHERE cancelled = 1 ORDER BY d").map((r) => r.d)).toEqual(cancelledDates);

    const keys = w.a.q("SELECT person_key FROM enrollments").map((r) => r.person_key as string);
    const ids = await w.vault.reidentify(keys, { purpose: "admin_vault_view", actor: "phase10-verify" });
    const byName = new Map(ids.map((i) => [`${i.firstName} ${i.lastName}`, i.personKey]));
    let checked = 0;
    for (const p of truth.people) {
      const key = byName.get(p.name);
      if (!key) continue; // the misspelled duplicate line has no row of its own once merged (or before the dup answer, its own)
      const [e] = w.a.q("SELECT sessions_attended AS a, sessions_planned_for_person AS pl, completed FROM enrollments WHERE person_key = ?", key);
      expect(e, p.name).toMatchObject({ a: p.attended, pl: p.planned, completed: p.completed ? "yes" : "no" });
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(60);

    // YES to the duplicate, then YES to the receipt.
    g.receive("T9", "YES");
    await syncGmail(w.env as never, g.gmail, m.llm);
    const receipt = g.sent.at(-1)!.text;
    const distinct = truth.people.length - 1; // the generator planted one misspelled duplicate
    const completed = persona3Truth(true).people.slice(0, -1).filter((p) => p.completed).length;
    const conflicts = truth.people.slice(0, -1).filter((p) => p.cbo !== p.completed).length;
    expect(receipt).toContain(`${distinct} enrolled, ${completed} completed`);
    expect(receipt).toMatch(/\d+ names and \d+ CDCR numbers were scrambled/);
    expect(receipt).toContain(`For ${conflicts} people`);
    g.receive("T9", "YES");
    await syncGmail(w.env as never, g.gmail, m.llm);
    expect(w.a.q("SELECT status, n_enrolled, n_completed FROM program_cycles")).toEqual([{ status: "confirmed", n_enrolled: distinct, n_completed: completed }]);
    expect(m.calls).toEqual(["map_columns", "classify_legend"]);
  });

  it("PII leak check over every channel, case-insensitive, including the real OpenRouter request bodies and the XLSX path", async () => {
    const w = await worker();
    const logs: string[] = [];
    for (const k of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
    const bodies = fakeOpenRouter({
      map_columns: readJson("org_d_persona4_individuals.llm.json").map_columns,
    });
    const responses: string[] = [];
    responses.push(await (await w.upload("od", "org_d_persona4_individuals.csv", "text/csv")).text());
    vi.unstubAllGlobals();
    const bodies3 = fakeOpenRouter({ map_columns: readJson("org_c_persona3_attendance.llm.json").map_columns });
    responses.push(await (await w.upload("oc", "org_c_persona3_attendance.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).text());
    responses.push(await (await w.upload("oc", "org_c_persona3_attendance.csv", "text/csv")).text());
    for (const id of w.a.q("SELECT submission_id FROM submissions").map((r) => r.submission_id as string)) responses.push(await (await w.call(`/api/submissions/${id}`)).text());
    responses.push(await (await w.call("/api/submissions")).text());
    responses.push(await (await w.call("/api/admin/summary")).text());
    responses.push(await (await w.call("/api/admin/vault/status")).text());
    expect(bodies.length + bodies3.length).toBe(3);
    expect(w.v.q("SELECT count(*) AS n FROM person_identity")[0]!.n).toBeGreaterThan(200);

    // Every identifier, in every spelling it could plausibly be re-written as.
    const ids = new Set<string>();
    const p4 = csvRows("org_d_persona4_individuals.csv").slice(1);
    for (const r of p4) {
      ids.add(r[0]!); r[0]!.split(" ").forEach((t) => t.length >= 4 && ids.add(t));
      if (r[1]) { ids.add(r[1]); ids.add(r[1].replace("SYN", "")); }
      if (r[2]) { ids.add(r[2]); ids.add(iso(r[2])); ids.add(iso(r[2]).replaceAll("-", "")); }
    }
    for (const p of persona3Truth(true).people) {
      ids.add(p.name); p.name.split(" ").forEach((t) => t.length >= 4 && ids.add(t));
      if (p.cdcr) { ids.add(p.cdcr); ids.add(p.cdcr.replace("SYN", "")); }
    }
    const haystacks: Record<string, string> = {
      "analytics DB": w.a.dump(),
      "vault DB (ciphertext only)": w.v.dump(),
      "log lines": logs.join("\n"),
      "OpenRouter request bodies": [...bodies, ...bodies3].join("\n"),
      "Worker API responses": responses.join("\n"),
    };
    // Word-boundary, case-insensitive, so "Fairbanks" inside a longer word does not count but "FAIRBANKS" does.
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const [where, text] of Object.entries(haystacks)) {
      const leaked = [...ids].filter((id) => new RegExp(`(^|[^A-Za-z0-9])${esc(id)}($|[^A-Za-z0-9])`, "i").test(text));
      expect(leaked, `${where} contains identifiers`).toEqual([]);
    }
  });

  it("person_key is a keyed HMAC: changes with the key, and is not a plain hash of the CDCR number", async () => {
    const k1 = await testKeys();
    const k2 = await importVaultKeys(toBase64(new Uint8Array(32).fill(42)), TEST_ENC_B64);
    const input = { cdcrNumber: "SYN52000", orgId: "od" };
    const a = (await personKey(k1, input)).personKey;
    const b = (await personKey(k2, input)).personKey;
    expect(a).not.toBe(b);
    for (const msg of ["SYN52000", "cdcr:SYN52000"]) {
      const plain = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(msg))).toString("hex").slice(0, 16);
      expect(a).not.toBe(`pk_${plain}`);
    }
  });

  it("only code under src/vault/ touches the VAULT binding", () => {
    const src = join(ROOT, "apps/worker/src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) { if (p !== join(src, "vault")) walk(p); continue; }
        if (!/\.ts$/.test(n) || /\.test\.ts$/.test(n)) continue;
        const text = readFileSync(p, "utf8");
        if (/\.VAULT\b|\bVAULT\s*\.\s*prepare|\["VAULT"\]/.test(text)) offenders.push(p.slice(src.length + 1));
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
