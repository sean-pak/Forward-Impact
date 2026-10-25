import { describe, expect, it } from "vitest";
import { FACILITIES } from "./facilities";
import { normalizeFacility } from "./normalizeFacility";

describe("FACILITIES", () => {
  it("has the 31 CDCR adult institutions with unique codes", () => {
    expect(FACILITIES).toHaveLength(31);
    expect(new Set(FACILITIES.map((f) => f.facility_code)).size).toBe(31);
  });
});

describe("normalizeFacility", () => {
  it.each([
    ["Men's Colony", "CMC"],
    ["Mens Colony", "CMC"],
    ["California Men’s Colony", "CMC"],
    ["S.Q.", "SQ"],
    ["SQ", "SQ"],
    ["san quentin", "SQ"],
    ["San Quentin State Prison", "SQ"],
    ["SQRC", "SQ"],
    ["  Solano ", "SOL"],
    ["CSP-Solano", "SOL"],
    ["SATF-CSP", "SATF"],
    ["R.J. Donovan", "RJD"],
    ["folsom", "FSP"],
    ["cmc", "CMC"],
  ])("maps %j to %s", (raw, code) => {
    expect(normalizeFacility(raw)).toBe(code);
  });

  it("returns null for unknown, empty, or ambiguous text", () => {
    expect(normalizeFacility("Corcoran")).toBeNull(); // COR or SATF
    expect(normalizeFacility("Soledad")).toBeNull(); // CTF or SVSP
    expect(normalizeFacility("Hogwarts")).toBeNull();
    expect(normalizeFacility("")).toBeNull();
    expect(normalizeFacility(null)).toBeNull();
    expect(normalizeFacility(undefined)).toBeNull();
  });

  it("no alias points at two prisons", () => {
    const seen = new Map<string, string>();
    for (const f of FACILITIES) {
      for (const t of [f.facility_code, f.facility_name, ...f.aliases]) {
        const code = normalizeFacility(t);
        expect(code, `${t} should map to ${f.facility_code}`).toBe(f.facility_code);
        seen.set(t, f.facility_code);
      }
    }
  });
});
