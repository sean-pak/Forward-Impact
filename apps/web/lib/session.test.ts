import { describe, expect, it } from "vitest";
import { SESSION_MAX_AGE_S, createSessionValue, passwordMatches, verifySessionValue } from "./session";

describe("admin session", () => {
  it("accepts a fresh cookie and rejects tampering, wrong secret, expiry, and junk", async () => {
    const now = 1_700_000_000_000;
    const v = await createSessionValue("s1", now);
    expect(await verifySessionValue(v, "s1", now + 1000)).toBe(true);
    expect(await verifySessionValue(v, "other", now)).toBe(false);
    expect(await verifySessionValue(v.replace(/^\d+/, "9999999999"), "s1", now)).toBe(false);
    expect(await verifySessionValue(v, "s1", now + (SESSION_MAX_AGE_S + 5) * 1000)).toBe(false);
    expect(await verifySessionValue(undefined, "s1", now)).toBe(false);
    expect(await verifySessionValue("abc", "s1", now)).toBe(false);
  });

  it("compares passwords", async () => {
    expect(await passwordMatches("hunter2", "hunter2", "s")).toBe(true);
    expect(await passwordMatches("hunter3", "hunter2", "s")).toBe(false);
  });
});
