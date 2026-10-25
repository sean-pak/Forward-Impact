import { describe, expect, it } from "vitest";
import { buildIdentityRow, identityParams } from "./identity";
import { Vault } from "./store";
import { testKeys } from "./testKeys";

type Call = { sql: string; params: unknown[] };

/** Records statements and serves canned rows for SELECTs on person_identity. */
function fakeD1(rows: Record<string, unknown>[] = []) {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return {
            run: async () => ({ success: true }),
            all: async () => ({ results: rows.filter((r) => params.includes(r.person_key)) }),
            first: async () => null,
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls };
}

const input = { cdcrNumber: "SYN00001", firstName: "Ann", lastName: "Lee", dateOfBirth: "1980-01-01", orgId: "org_a", orgInternalId: "A-1", isSynthetic: true };

describe("buildIdentityRow", () => {
  it("encrypts every identifier and keeps none in the clear", async () => {
    const row = await buildIdentityRow(await testKeys(), input);
    const flat = JSON.stringify(row);
    for (const secret of ["SYN00001", "Ann", "Lee", "1980-01-01"]) expect(flat).not.toContain(secret);
    expect(row.cdcr_enc).toBeTruthy();
    expect(JSON.parse(row.org_ids)).toEqual({ org_a: "A-1" });
    expect(row.is_synthetic).toBe(1);
  });

  it("leaves absent fields null", async () => {
    const row = await buildIdentityRow(await testKeys(), { orgId: "org_a", orgInternalId: "A-2", isSynthetic: true });
    expect([row.cdcr_enc, row.first_enc, row.last_enc, row.dob_enc]).toEqual([null, null, null, null]);
    expect(row.person_key_basis).toBe("org_internal_id");
  });
});

describe("Vault.upsertIdentity", () => {
  it("binds ciphertext only and returns just the key", async () => {
    const { db, calls } = fakeD1();
    const out = await new Vault(db, await testKeys()).upsertIdentity(input);
    expect(out.personKey).toMatch(/^pk_/);
    expect(calls).toHaveLength(1);
    const bound = JSON.stringify(calls[0]!.params);
    for (const secret of ["SYN00001", "Ann", "Lee", "1980-01-01"]) expect(bound).not.toContain(secret);
    expect(calls[0]!.sql).toContain("ON CONFLICT (person_key)");
  });
});

describe("Vault.upsertIdentities", () => {
  const person = (n: number) => ({ cdcrNumber: `SYN0000${n}`, firstName: `First${n}`, lastName: `Last${n}`, dateOfBirth: "1980-01-01", orgId: "org_a", isSynthetic: true });

  it("writes many people in one statement, ciphertext only, and returns the keys in order", async () => {
    const { db, calls } = fakeD1();
    const keys = await new Vault(db, await testKeys()).upsertIdentities([person(1), person(2), person(1)]);
    expect(keys).toHaveLength(3);
    expect(keys[0]).toEqual(keys[2]); // the same person twice has the same key
    expect(keys[0]!.personKey).not.toBe(keys[1]!.personKey);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("json_each(?)");
    const rows = JSON.parse(calls[0]!.params[0] as string) as unknown[][];
    expect(rows).toHaveLength(2); // duplicates are written once
    const bound = JSON.stringify(rows);
    for (const secret of ["SYN00001", "First1", "Last2", "1980-01-01"]) expect(bound).not.toContain(secret);
  });

  it("writes nothing for an empty list", async () => {
    const { db, calls } = fakeD1();
    expect(await new Vault(db, await testKeys()).upsertIdentities([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("gives the same key as upsertIdentity for the same person", async () => {
    const { db } = fakeD1();
    const vault = new Vault(db, await testKeys());
    const [bulk] = await vault.upsertIdentities([person(1)]);
    expect(bulk!.personKey).toBe((await vault.upsertIdentity(person(1))).personKey);
  });
});

describe("Vault.reidentify", () => {
  it("writes the access log first, then returns plaintext", async () => {
    const keys = await testKeys();
    const row = await buildIdentityRow(keys, input);
    const { db, calls } = fakeD1([{ ...row }]);
    const out = await new Vault(db, keys).reidentify([row.person_key, row.person_key], { purpose: "org_report", actor: "org:org_a", orgId: "org_a" });
    expect(calls[0]!.sql).toContain("INSERT INTO vault_access_log");
    expect(calls[0]!.params).toEqual(["org:org_a", "org_report", "org_a", 1]);
    expect(out).toEqual([
      { personKey: row.person_key, basis: "cdcr_number", cdcrNumber: "SYN00001", firstName: "Ann", lastName: "Lee", dateOfBirth: "1980-01-01", orgInternalIds: { org_a: "A-1" }, isSynthetic: true },
    ]);
  });

  it("never returns another org's people", async () => {
    const keys = await testKeys();
    const row = await buildIdentityRow(keys, input);
    const { db } = fakeD1([{ ...row }]);
    expect(await new Vault(db, keys).reidentify([row.person_key], { purpose: "org_report", actor: "org:org_b", orgId: "org_b" })).toEqual([]);
  });

  it("decrypts nothing if the log write fails", async () => {
    const keys = await testKeys();
    const row = await buildIdentityRow(keys, input);
    let selected = false;
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          run: async () => { throw new Error("log down"); },
          all: async () => { selected = true; return { results: [{ ...row }] }; },
        }),
      }),
    } as unknown as D1Database;
    await expect(new Vault(db, keys).reidentify([row.person_key], { purpose: "admin_vault_view", actor: "admin" })).rejects.toThrow("log down");
    expect(selected).toBe(false);
  });

  it("params line up with the statement", async () => {
    const row = await buildIdentityRow(await testKeys(), input);
    const sql = (await import("./identity")).UPSERT_IDENTITY_SQL;
    expect(identityParams(row)).toHaveLength((sql.match(/\?/g) ?? []).length);
  });
});
