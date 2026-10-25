import { describe, expect, it } from "vitest";
import { isCountSuppressed, isFacilitySuppressed, isRateSuppressed } from "./suppress";

describe("suppression rules", () => {
  it("rate: denominator under 30", () => {
    expect(isRateSuppressed(29)).toBe(true);
    expect(isRateSuppressed(30)).toBe(false);
    expect(isRateSuppressed(0)).toBe(true);
  });
  it("count: 1 to 10 hidden, 0 and 11+ shown", () => {
    expect(isCountSuppressed(0)).toBe(false);
    expect(isCountSuppressed(1)).toBe(true);
    expect(isCountSuppressed(10)).toBe(true);
    expect(isCountSuppressed(11)).toBe(false);
  });
  it("facility: fewer than 3 orgs", () => {
    expect(isFacilitySuppressed(2)).toBe(true);
    expect(isFacilitySuppressed(3)).toBe(false);
  });
});
