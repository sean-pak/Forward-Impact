import { describe, expect, it } from "vitest";
import { rowsFromFormData } from "./formData";

describe("rowsFromFormData", () => {
  it("reads rows, checkboxes and registry answers", () => {
    const fd = new FormData();
    fd.set("r0.program_name", "Writing");
    fd.set("r0.n_enrolled", "30");
    fd.set("r0.n_enrolled_approx", "on");
    fd.set("r0.extra.setting", "yard");
    fd.set("r1.program_name", "Other");
    const [a, b] = rowsFromFormData(fd, 2, ["setting"]);
    expect(a).toMatchObject({ program_name: "Writing", n_enrolled: "30", n_enrolled_approx: true, n_completed_approx: false, extra: { setting: "yard" } });
    expect(b).toMatchObject({ program_name: "Other", n_enrolled: "", extra: { setting: "" } });
  });
});
