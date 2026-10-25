import { describe, expect, it } from "vitest";
import { makeHealth } from "./health";

describe("makeHealth", () => {
  it("is ok only when both databases are up", () => {
    expect(makeHealth(true, true)).toEqual({ ok: true, db: true, vault: true });
    expect(makeHealth(true, false).ok).toBe(false);
    expect(makeHealth(false, true).ok).toBe(false);
  });
});
