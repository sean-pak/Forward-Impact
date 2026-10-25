import { describe, expect, it } from "vitest";
import { groupByOrg, isSyntheticEmail, orgIdFromName, parseContactRows } from "./contacts";

describe("parseContactRows", () => {
  it("accepts header aliases and lowercases email", () => {
    const { contacts, rejected } = parseContactRows([{ Organization: "Arts", "Contact Name": "A", "Email Address": " A@X.org ", "Job Title": "ED" }]);
    expect(rejected).toEqual([]);
    expect(contacts).toEqual([{ org: "Arts", name: "A", email: "a@x.org", title: "ED" }]);
  });

  it("rejects bad rows with the file line number and keeps the good ones", () => {
    const { contacts, rejected } = parseContactRows([
      { org: "A", email: "a@x.org" },
      { org: "", email: "b@x.org" },
      { org: "C", email: "nope" },
    ]);
    expect(contacts).toHaveLength(1);
    expect(rejected.map((r) => r.line)).toEqual([3, 4]);
  });
});

describe("groupByOrg", () => {
  it("groups case-insensitively, ranks by file order, drops duplicate emails", () => {
    const rows = parseContactRows([
      { org: "Arts", name: "One", email: "1@x.org" },
      { org: "Edu", email: "e@x.org" },
      { org: "arts", name: "Two", email: "2@x.org" },
      { org: "Arts", name: "One again", email: "1@x.org" },
    ]).contacts;
    const g = groupByOrg(rows);
    expect(g.map((o) => o.orgName)).toEqual(["Arts", "Edu"]);
    expect(g[0]!.contacts.map((c) => [c.email, c.rank])).toEqual([["1@x.org", 1], ["2@x.org", 2]]);
  });
});

describe("helpers", () => {
  it("slugs org ids", () => {
    expect(orgIdFromName("Fixture Arts Collective!")).toBe("org_fixture_arts_collective");
    expect(orgIdFromName("???")).toBe("org_unnamed");
  });
  it("flags example.org as synthetic", () => {
    expect(isSyntheticEmail("a@Example.org")).toBe(true);
    expect(isSyntheticEmail("a@gmail.com")).toBe(false);
  });
});
