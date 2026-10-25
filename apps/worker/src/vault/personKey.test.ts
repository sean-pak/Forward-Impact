import { describe, expect, it } from "vitest";
import { importVaultKeys } from "./crypto";
import { normalizeCdcr, normalizeInternalId, normalizeName } from "./normalize";
import { personKey } from "./personKey";
import { OTHER_ENC_B64, TEST_ENC_B64, testKeys } from "./testKeys";

describe("normalize", () => {
  it("normalizes CDCR numbers", () => {
    expect(normalizeCdcr(" ab-123 45 ")).toBe("AB12345");
    expect(normalizeCdcr("syn00001")).toBe("SYN00001");
  });
  it("normalizes names and ids", () => {
    expect(normalizeName("  José ", "O'Brien-Núñez")).toBe("JOSE OBRIENNUNEZ");
    expect(normalizeName(null, "Smith")).toBe("SMITH");
    expect(normalizeInternalId(" d-0003 ")).toBe("D-0003");
  });
});

describe("personKey", () => {
  it("is pk_ + 16 hex and deterministic", async () => {
    const k = await testKeys();
    const a = await personKey(k, { cdcrNumber: "SYN00001", orgId: "org_a" });
    const b = await personKey(k, { cdcrNumber: "SYN00001", orgId: "org_a" });
    expect(a.personKey).toMatch(/^pk_[0-9a-f]{16}$/);
    expect(a).toEqual(b);
    expect(a.basis).toBe("cdcr_number");
  });

  it("is the same person across orgs and across formatting when a CDCR number exists", async () => {
    const k = await testKeys();
    const a = await personKey(k, { cdcrNumber: "SYN00001", orgId: "org_a", orgInternalId: "A-1" });
    const b = await personKey(k, { cdcrNumber: " syn-00001 ", orgId: "org_b", firstName: "Other" });
    expect(a.personKey).toBe(b.personKey);
  });

  it("differs per person and per HMAC key (unkeyed hashes would not)", async () => {
    const k = await testKeys();
    const other = await importVaultKeys(OTHER_ENC_B64, TEST_ENC_B64);
    const a = await personKey(k, { cdcrNumber: "SYN00001", orgId: "o" });
    expect((await personKey(k, { cdcrNumber: "SYN00002", orgId: "o" })).personKey).not.toBe(a.personKey);
    expect((await personKey(other, { cdcrNumber: "SYN00001", orgId: "o" })).personKey).not.toBe(a.personKey);
  });

  it("falls back to the org internal id, scoped to the org", async () => {
    const k = await testKeys();
    const a = await personKey(k, { orgId: "org_a", orgInternalId: "D-0003" });
    const same = await personKey(k, { orgId: "org_a", orgInternalId: " d-0003" });
    const otherOrg = await personKey(k, { orgId: "org_b", orgInternalId: "D-0003" });
    expect(a.basis).toBe("org_internal_id");
    expect(same.personKey).toBe(a.personKey);
    expect(otherOrg.personKey).not.toBe(a.personKey);
    expect((await personKey(k, { cdcrNumber: "", orgId: "org_a", orgInternalId: "D-0003" })).personKey).toBe(a.personKey);
  });

  it("falls back to org + name + DOB as a last resort", async () => {
    const k = await testKeys();
    const a = await personKey(k, { orgId: "o", firstName: "Ann", lastName: "Lee", dateOfBirth: "1980-01-01" });
    const b = await personKey(k, { orgId: "o", firstName: "ann", lastName: "LEE", dateOfBirth: "1980-01-01" });
    const c = await personKey(k, { orgId: "o", firstName: "Ann", lastName: "Lee", dateOfBirth: "1981-01-01" });
    expect(a.basis).toBe("org_name");
    expect(a.personKey).toBe(b.personKey);
    expect(a.personKey).not.toBe(c.personKey);
  });

  it("refuses when there is nothing to key on", async () => {
    await expect(personKey(await testKeys(), { orgId: "o" })).rejects.toThrow(/cannot make a person_key/);
  });
});
