import { describe, expect, it } from "vitest";
import { parseCompletionRule, ruleFromNotes, ruleMet } from "./completion";

describe("parseCompletionRule", () => {
  it.each([
    ["attended at least 80% of sessions", { kind: "pct", min: 0.8 }],
    ["attendance >= 75 percent", { kind: "pct", min: 0.75 }],
    ["attended all sessions", { kind: "pct", min: 1 }],
    ["at least 10 sessions", { kind: "count", min: 10 }],
    ["12 or more sessions", { kind: "count", min: 12 }],
  ])("reads %s", (text, want) => expect(parseCompletionRule(text)).toEqual(want));

  it.each(["finished the capstone project", "", "0%", "150%"])("does not guess at %s", (text) => expect(parseCompletionRule(text)).toBeNull());
});

describe("ruleMet", () => {
  it("compares attended to planned at the threshold", () => {
    const r = { kind: "pct", min: 0.8 } as const;
    expect(ruleMet(r, 12, 15)).toBe(true); // exactly 80%
    expect(ruleMet(r, 11, 15)).toBe(false);
    expect(ruleMet(r, 0, 0)).toBe(false);
    expect(ruleMet({ kind: "count", min: 10 }, 10, 40)).toBe(true);
  });
});

describe("ruleFromNotes", () => {
  it("builds standard wording and never repeats the sheet's sentence", () => {
    expect(ruleFromNotes(["Healing Circle, Spring. Completion = attended at least 80% of sessions. Facilitator R.Q."])).toBe("attended at least 80% of sessions");
    expect(ruleFromNotes(["Graduates attended all sessions"])).toBe("attended all sessions");
  });
  it("ignores sentences that are not about completion", () => {
    expect(ruleFromNotes(["Doors open at 80% capacity"])).toBeNull();
    expect(ruleFromNotes([])).toBeNull();
  });
});
