import { describe, expect, it } from "vitest";
import { baseProgramNames } from "./ingestText";

describe("baseProgramNames", () => {
  it("one class run in spring and fall is one program", () => {
    expect(baseProgramNames(["spring meditation class", "fall group"])).toEqual(["Meditation class", "Meditation class"]);
    expect(baseProgramNames(["Writing Class", "Writing Class"])).toEqual(["Writing Class", "Writing Class"]);
    expect(baseProgramNames(["2025 Fall Writing Class"])).toEqual(["Writing Class"]);
  });

  it("does not merge by guess when the message names several classes", () => {
    expect(baseProgramNames(["spring yoga", "spring writing", "fall group"])).toEqual(["Yoga", "Writing", "fall group"]);
  });

  it("keeps names that only look like terms", () => {
    expect(baseProgramNames(["New Beginnings", "First Steps"])).toEqual(["New Beginnings", "First Steps"]);
    expect(baseProgramNames(["fall group"])).toEqual(["fall group"]);
  });
});
