import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocatorResult } from "@tpw/shared";
import { app } from "../index";
import { decryptField } from "../vault/crypto";
import { createVault, vaultFactory } from "../vault";
import { TEST_ENC_B64, TEST_HMAC_B64, testKeys } from "../vault/testKeys";
import { makeD1, sqlite } from "../testing/sqlite";
import { LocatorRefused, eitLocator, mockLocator, runChecks, type Deps } from ".";

// These tests are written against fixture people (SYN90001 to SYN90007). The Worker bundles the demo dataset's mock,
// so swap in the small fixture file here.
vi.mock("./mock_locator.json", async () => ({ default: (await import("./mock_locator.fixture.json")).default }));

const SECRET = "test-secret";

async function world() {
  const a = makeD1("analytics");
  const v = makeD1("vault");
  const env = {
    DB: a.db, VAULT: v.db, VAULT_HMAC_KEY: TEST_HMAC_B64, VAULT_ENC_KEY: TEST_ENC_B64, API_SECRET: SECRET,
    GOOGLE_CLIENT_ID: "i", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r", MAILBOX_ADDRESS: "hello@example.org",
    REAL_LOCATOR_ENABLED: "false",
  };
  a.raw.exec(`INSERT INTO orgs (org_id, org_name, data_persona, primary_contact_email, private_token, form_token, is_synthetic)
    VALUES ('o1','Org One',4,'a@example.org','p1','f1',1)`);
  const vault = await createVault(env);

  const people: Record<string, string> = {};
  /** A person in the vault, with a first post-program release, and (by default) active consent. */
  async function person(name: string, p: {
    cdcr?: string; first: string; last: string; synthetic?: boolean; release?: string; postProgram?: boolean;
    consent?: "active" | "revoked" | "declined" | "none";
  }) {
    const synthetic = p.synthetic ?? true;
    const { personKey } = await vault.upsertIdentity({
      cdcrNumber: p.cdcr ?? null, firstName: p.first, lastName: p.last, dateOfBirth: "1980-01-01", orgId: "o1", orgInternalId: p.cdcr ? null : `I-${name}`, isSynthetic: synthetic,
    });
    people[name] = personKey;
    a.raw.prepare("INSERT INTO release_events (release_id, person_key, release_date, source, post_program, is_synthetic) VALUES (?, ?, ?, 'cbo_report', ?, ?)")
      .run(`rel_${name}`, personKey, p.release ?? "2024-01-01", p.postProgram === false ? 0 : 1, synthetic ? 1 : 0);
    const consent = p.consent ?? "active";
    if (consent !== "none") {
      a.raw.prepare("INSERT INTO consents (person_key, org_id, consent_followup, consent_share_with_tpw, consent_date, revoked_date, consent_form_version, is_synthetic) VALUES (?, 'o1', ?, 1, '2023-01-01', ?, 'v1', ?)")
        .run(personKey, consent === "declined" ? 0 : 1, consent === "revoked" ? "2024-06-01" : null, synthetic ? 1 : 0);
    }
    return personKey;
  }

  const call = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`https://w.test${path}`, { ...init, headers: { Authorization: `Bearer ${SECRET}`, ...(init.headers ?? {}) } }), env as never);
  const post = (path: string, body: unknown = {}) => call(path, { method: "POST", body: JSON.stringify(body) });
  const deps = (over: Partial<Deps> = {}): Deps => ({ db: a.db, openVault: vaultFactory(env), realEnabled: false, ...over });
  return { a, v, env, person, people, call, post, deps };
}

type Results = { results: { person_key: string; status: string; result?: string; needs_verification?: boolean; outcome?: string | null; reason?: string }[] };

/** The standard cohort: every mock edge case, plus people who must never be looked up. */
async function seedCohort(w: Awaited<ReturnType<typeof world>>) {
  await w.person("returned", { cdcr: "SYN90001", first: "Fixture", last: "Personone" }); // in custody, admitted after release
  await w.person("clean", { cdcr: "SYN90002", first: "Fixture", last: "Persontwo" }); // not found
  await w.person("released_again", { cdcr: "SYN90003", first: "Fixture", last: "Returned" }); // edge: returned and released shows not_found
  await w.person("errors", { cdcr: "SYN90004", first: "Fixture", last: "Unreachable" }); // edge: error response
  await w.person("twin", { first: "Fixture", last: "Twin" }); // edge: name-only, two matches
  await w.person("name_only", { first: "Fixture", last: "Personthree" }); // name-only, one match
  await w.person("real", { cdcr: "A12345", first: "Real", last: "Person", synthetic: false }); // a real person: never the mock
  // Not eligible:
  await w.person("no_consent", { cdcr: "SYN90005", first: "No", last: "Consent", consent: "none" });
  await w.person("revoked", { cdcr: "SYN90006", first: "Revoked", last: "Consent", consent: "revoked" });
  await w.person("declined", { cdcr: "SYN90007", first: "Declined", last: "Consent", consent: "declined" });
  await w.person("pre_program", { cdcr: "SYN90008", first: "Before", last: "Program", postProgram: false });
  await w.person("not_released", { cdcr: "SYN90009", first: "Still", last: "Inside", release: "2999-01-01" });
}

afterEach(() => vi.unstubAllGlobals());

describe.skipIf(!sqlite)("custody lookups", () => {
  it("lists only released, consented people, by person_key and org", async () => {
    const w = await world();
    await seedCohort(w);
    const body = (await (await w.call("/api/lookups")).json()) as { rows: { person_key: string; orgs: string }[]; real_locator_enabled: boolean };
    expect(body.real_locator_enabled).toBe(false);
    expect(body.rows.map((r) => r.person_key).sort()).toEqual(
      ["returned", "clean", "released_again", "errors", "twin", "name_only", "real"].map((n) => w.people[n]!).sort(),
    );
    expect(body.rows[0]!.orgs).toBe("Org One");
    // The list carries no names or CDCR numbers.
    expect(JSON.stringify(body)).not.toMatch(/SYN9|Fixture|A12345/);
  });

  it("checking the cohort writes checks and outcome events; the edge cases come out right", async () => {
    const w = await world();
    await seedCohort(w);
    // The real URL must never be called, with or without the mock.
    const fetchSpy = vi.fn(() => { throw new Error("network call"); });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await w.post("/api/lookups/check-cohort");
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as Results;
    expect(results).toHaveLength(7);
    const by = (name: string) => results.find((r) => r.person_key === w.people[name])!;
    expect(by("returned")).toMatchObject({ status: "checked", result: "found_in_custody", outcome: "exact" });
    expect(by("clean")).toMatchObject({ result: "not_found", outcome: null });
    expect(by("released_again")).toMatchObject({ result: "not_found", outcome: null });
    expect(by("errors")).toMatchObject({ result: "error", outcome: null });
    expect(by("twin")).toMatchObject({ result: "multiple_matches", needs_verification: true, outcome: null });
    expect(by("name_only")).toMatchObject({ result: "found_in_custody", needs_verification: true, outcome: null });
    expect(by("real")).toMatchObject({ result: "blocked", outcome: null });
    expect(fetchSpy).not.toHaveBeenCalled();

    // custody_checks: every lookup is a row, including the error and the block.
    const checks = w.a.q("SELECT * FROM custody_checks ORDER BY rowid");
    expect(checks).toHaveLength(7);
    const check = (name: string) => checks.find((c) => c.person_key === w.people[name])!;
    expect(check("returned")).toMatchObject({ source_system: "mock_locator", query_method: "cdcr_number", match_confidence: "exact_cdcr", returned_facility: "SQ", returned_admission_date: "2025-03-02", verified_by_human: 0, is_synthetic: 1 });
    expect(check("twin")).toMatchObject({ query_method: "name", match_confidence: "name_only", returned_facility: null });
    expect(check("name_only")).toMatchObject({ query_method: "name", match_confidence: "name_only", returned_admission_date: "2025-09-09" });
    expect(check("real")).toMatchObject({ source_system: "eit_locator", result: "blocked", is_synthetic: 0 });

    // The one outcome: exact date, days from release, simulated-world label is the mock source.
    const outcomes = w.a.q("SELECT * FROM outcome_events");
    expect(outcomes).toEqual([
      expect.objectContaining({
        person_key: w.people.returned, release_id: "rel_returned", outcome_type: "return_to_prison", outcome_date: "2025-03-02",
        outcome_date_precision: "exact", days_to_outcome: 426, within_3yr: 1, outcome_source: "mock_locator", evidence_check_id: check("returned")!.check_id,
      }),
    ]);

    // Raw queries and responses are encrypted in the vault, one per check, and decrypt with the vault key.
    const raw = w.v.q("SELECT * FROM locator_raw");
    expect(raw).toHaveLength(7);
    const keys = await testKeys();
    const id = check("returned")!.check_id as string;
    expect(check("returned")!.raw_response_ref).toBe(id);
    const row = raw.find((r) => r.check_id === id)!;
    expect(JSON.parse(await decryptField(keys, row.query_enc as string, `${id}:query`))).toEqual({ cdcr: "SYN90001" });
    expect(await decryptField(keys, row.response_enc as string, `${id}:response`)).toContain("Personone");

    // One audited re-identification for the whole cohort, and no identifier anywhere in analytics.
    expect(w.v.q("SELECT actor, purpose, n_person_keys FROM vault_access_log WHERE purpose = 'locator_check'")).toEqual([
      { actor: "admin_lookups", purpose: "locator_check", n_person_keys: 7 },
    ]);
    expect(w.a.dump()).not.toMatch(/SYN9|Fixture|Personone|Real|A12345|Twin/);
    expect(JSON.stringify(raw)).not.toMatch(/SYN9|Fixture|Personone|A12345/);
  });

  it("a second click the same day has nothing to do, and the list shows who needs verification", async () => {
    const w = await world();
    await seedCohort(w);
    await w.post("/api/lookups/check-cohort");
    expect((await (await w.post("/api/lookups/check-cohort")).json()) as Results).toEqual({ results: [] });
    expect(w.a.q("SELECT * FROM custody_checks")).toHaveLength(7);

    const { rows } = (await (await w.call("/api/lookups")).json()) as { rows: { person_key: string; needs_verification: boolean; outcome: unknown; last_check: { result: string } }[] };
    expect(rows.filter((r) => r.needs_verification).map((r) => r.person_key).sort()).toEqual([w.people.twin!, w.people.name_only!].sort());
    expect(rows.find((r) => r.person_key === w.people.returned)!.outcome).toMatchObject({ outcome_date: "2025-03-02", precision: "exact", source: "mock_locator" });
  });

  it("a name-only hit becomes an outcome only after a human verifies it; several matches cannot be verified", async () => {
    const w = await world();
    await seedCohort(w);
    await w.post("/api/lookups/check-cohort");
    const checkId = (name: string) => w.a.q("SELECT check_id FROM custody_checks WHERE person_key = ?", w.people[name]!)[0]!.check_id as string;

    expect(w.a.q("SELECT * FROM outcome_events WHERE person_key = ?", w.people.name_only!)).toEqual([]);
    const twin = await w.post(`/api/lookups/checks/${checkId("twin")}/verify`);
    expect(twin.status).toBe(400);
    expect(((await twin.json()) as { error: string }).error).toMatch(/CDCR number/);
    expect((await w.post(`/api/lookups/checks/${checkId("clean")}/verify`)).status).toBe(400);
    expect((await w.post("/api/lookups/checks/nope/verify")).status).toBe(404);

    const ok = await w.post(`/api/lookups/checks/${checkId("name_only")}/verify`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, outcome: "exact" });
    expect(w.a.q("SELECT verified_by_human FROM custody_checks WHERE check_id = ?", checkId("name_only"))).toEqual([{ verified_by_human: 1 }]);
    expect(w.a.q("SELECT outcome_date, outcome_date_precision, outcome_source, evidence_check_id FROM outcome_events WHERE person_key = ?", w.people.name_only!)).toEqual([
      { outcome_date: "2025-09-09", outcome_date_precision: "exact", outcome_source: "mock_locator", evidence_check_id: checkId("name_only") },
    ]);
    expect((await w.post(`/api/lookups/checks/${checkId("name_only")}/verify`)).status).toBe(400);
  });

  it("a named check only runs for eligible people; everyone else is skipped with no check row", async () => {
    const w = await world();
    await seedCohort(w);
    const keys = ["no_consent", "revoked", "declined", "pre_program", "not_released", "clean"].map((n) => w.people[n]!);
    const { results } = (await (await w.post("/api/lookups/check", { person_keys: [...keys, "pk_unknown"] })).json()) as Results;
    expect(results.filter((r) => r.status === "skipped")).toHaveLength(6);
    expect(results.filter((r) => r.status === "checked").map((r) => r.person_key)).toEqual([w.people.clean]);
    expect(w.a.q("SELECT person_key FROM custody_checks")).toEqual([{ person_key: w.people.clean }]);
    expect(w.v.q("SELECT n_person_keys FROM vault_access_log WHERE purpose = 'locator_check'")).toEqual([{ n_person_keys: 1 }]);
  });

  it("a person with an outcome already is not checked again by the cohort (first event only)", async () => {
    const w = await world();
    await w.person("returned", { cdcr: "SYN90001", first: "Fixture", last: "Personone" });
    await w.post("/api/lookups/check", { person_keys: [w.people.returned!] });
    w.a.raw.exec("UPDATE custody_checks SET checked_at = '2026-01-01T00:00:00.000Z'");
    expect(((await (await w.post("/api/lookups/check-cohort")).json()) as Results).results).toEqual([]);
    // Asked for directly, it is checked again but the first outcome stays.
    await w.post("/api/lookups/check", { person_keys: [w.people.returned!] });
    expect(w.a.q("SELECT outcome_date FROM outcome_events")).toEqual([{ outcome_date: "2025-03-02" }]);
  });

  it("an existing simulated outcome keeps its source", async () => {
    const w = await world();
    await w.person("returned", { cdcr: "SYN90001", first: "Fixture", last: "Personone" });
    w.a.raw.prepare("INSERT INTO outcome_events (person_key, release_id, outcome_type, outcome_date, outcome_date_precision, outcome_source) VALUES (?, 'rel_returned', 'return_to_prison', '2024-09-09', 'exact', 'simulated')")
      .run(w.people.returned!);
    await w.post("/api/lookups/check", { person_keys: [w.people.returned!] });
    expect(w.a.q("SELECT outcome_date, outcome_source FROM outcome_events")).toEqual([{ outcome_date: "2024-09-09", outcome_source: "simulated" }]);
  });

  it("no admission date: the outcome is an interval between the last negative check and the first hit", async () => {
    const w = await world();
    const p = await w.person("slow", { cdcr: "SYN90010", first: "Slow", last: "Mover", release: "2025-01-01" });
    let answer: LocatorResult = { kind: "not_found" };
    const locator = { source: "mock_locator" as const, lookup: async () => answer };
    let clock = Date.parse("2025-06-01T12:00:00Z");
    const deps = w.deps({ now: () => new Date(clock), locatorFor: () => locator });

    await runChecks(deps, [p]);
    clock = Date.parse("2025-06-11T12:00:00Z");
    answer = { kind: "found", match: { cdcr_number: "SYN90010", first_name: "Slow", last_name: "Mover", facility: "SQ", admission_date: null, projected_release_date: null } };
    const [second] = await runChecks(deps, [p]);
    expect(second).toMatchObject({ result: "found_in_custody", outcome: "interval" });
    expect(w.a.q("SELECT outcome_date, outcome_date_precision, outcome_date_earliest, days_to_outcome FROM outcome_events")).toEqual([
      { outcome_date: "2025-06-06", outcome_date_precision: "interval", outcome_date_earliest: "2025-06-01", days_to_outcome: 156 },
    ]);

    // A later check that knows the admission date upgrades the interval to an exact date, same source.
    clock = Date.parse("2025-06-21T12:00:00Z");
    answer = { kind: "found", match: { cdcr_number: "SYN90010", first_name: "Slow", last_name: "Mover", facility: "SQ", admission_date: "2025-06-03", projected_release_date: null } };
    await runChecks(deps, [p]);
    expect(w.a.q("SELECT outcome_date, outcome_date_precision, outcome_source FROM outcome_events")).toEqual([
      { outcome_date: "2025-06-03", outcome_date_precision: "exact", outcome_source: "mock_locator" },
    ]);
  });

  it("a thrown error is recorded as an error row, not lost", async () => {
    const w = await world();
    const p = await w.person("boom", { cdcr: "SYN90011", first: "Boom", last: "Case" });
    const locator = { source: "mock_locator" as const, lookup: async (): Promise<LocatorResult> => { throw new Error("socket closed"); } };
    const [r] = await runChecks(w.deps({ locatorFor: () => locator }), [p]);
    expect(r).toMatchObject({ status: "checked", result: "error" });
    expect(w.a.q("SELECT result, match_confidence FROM custody_checks")).toEqual([{ result: "error", match_confidence: "none" }]);
    expect(w.a.q("SELECT * FROM outcome_events")).toEqual([]);
  });

  it("limits one click to 20 people", async () => {
    const w = await world();
    const keys: string[] = [];
    for (let i = 0; i < 22; i++) keys.push(await w.person(`p${i}`, { cdcr: `SYN9${String(1000 + i)}`, first: "Many", last: `P${i}` }));
    const results = await runChecks(w.deps({ locatorFor: () => mockLocator() }), keys);
    expect(results.filter((r) => r.status === "checked")).toHaveLength(20);
    expect(results.filter((r) => r.status === "skipped")).toHaveLength(2);
  });

  it("names appear only through an audited reveal, and only for someone on the list", async () => {
    const w = await world();
    await seedCohort(w);
    const ok = await w.post("/api/lookups/reveal", { person_key: w.people.returned });
    expect(await ok.json()).toEqual({ first_name: "Fixture", last_name: "Personone", cdcr_number: "SYN90001" });
    expect(ok.headers.get("Cache-Control")).toBe("no-store");
    expect(w.v.q("SELECT actor, purpose, n_person_keys FROM vault_access_log WHERE purpose = 'admin_vault_view'")).toEqual([
      { actor: "admin_lookups", purpose: "admin_vault_view", n_person_keys: 1 },
    ]);
    const nope = await w.post("/api/lookups/reveal", { person_key: w.people.revoked });
    expect(nope.status).toBe(404);
    expect(await nope.text()).not.toMatch(/Revoked|SYN90006/);
    expect(w.v.q("SELECT * FROM vault_access_log WHERE purpose = 'admin_vault_view'")).toHaveLength(1);
  });

  it("the mock search route needs the bearer secret", async () => {
    const w = await world();
    const open = await app.fetch(new Request("https://w.test/mock-locator/search?cdcr=SYN90001"), w.env as never);
    expect(open.status).toBe(401);
    expect(await (await w.call("/mock-locator/search?cdcr=SYN90001")).json()).toMatchObject({ kind: "found", match: { facility: "SQ" } });
    expect(await (await w.call("/mock-locator/search?first=Fixture&last=Twin")).json()).toMatchObject({ kind: "multiple" });
    expect(await (await w.call("/mock-locator/search?cdcr=SYN90004")).json()).toEqual({ kind: "error", message: "Service unavailable" });
  });
});

describe("locator guards (adapters)", () => {
  const real = { isSynthetic: false, cdcrNumber: "A12345", consentFollowup: true, consentRevoked: false };

  it("the mock refuses a real person", async () => {
    await expect(mockLocator().lookup({ cdcr: "A12345" }, real)).rejects.toBeInstanceOf(LocatorRefused);
    await expect(mockLocator().lookup({ cdcr: "SYN90001" }, { ...real, isSynthetic: true })).resolves.toMatchObject({ kind: "found" });
  });

  it("the real adapter is refused when the flag is off, even for a consented real person", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const eit = eitLocator({ enabled: false, recentMs: () => [] });
    await expect(eit.lookup({ cdcr: "A12345" }, real)).rejects.toThrow(/disabled/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the real adapter refuses a synthetic person and any SYN number with the flag on", async () => {
    const eit = eitLocator({ enabled: true, recentMs: () => [] });
    await expect(eit.lookup({ cdcr: "A12345" }, { ...real, isSynthetic: true })).rejects.toBeInstanceOf(LocatorRefused);
    await expect(eit.lookup({ cdcr: "SYN90001" }, real)).rejects.toThrow(/SYN/);
    await expect(eit.lookup({ cdcr: "A12345" }, { ...real, cdcrNumber: "syn90001" })).rejects.toThrow(/SYN/);
  });

  it("the real adapter refuses without active consent, and over the rate limit", async () => {
    const eit = eitLocator({ enabled: true, recentMs: () => [], now: () => 1_000_000 });
    await expect(eit.lookup({ cdcr: "A12345" }, { ...real, consentFollowup: false })).rejects.toThrow(/consent/);
    await expect(eit.lookup({ cdcr: "A12345" }, { ...real, consentRevoked: true })).rejects.toThrow(/consent/);
    const busy = eitLocator({ enabled: true, recentMs: () => [999_000], now: () => 1_000_000 });
    await expect(busy.lookup({ cdcr: "A12345" }, real)).rejects.toThrow(/Wait/);
  });

  it("even with every guard passing the real client is not built, and the network is untouched", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const eit = eitLocator({ enabled: true, recentMs: () => [] });
    const err = await eit.lookup({ cdcr: "A12345" }, real).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LocatorRefused);
    expect(err.message).toMatch(/not built/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
