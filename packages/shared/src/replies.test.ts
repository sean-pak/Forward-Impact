import { describe, expect, it } from "vitest";
import { clarifyEmail, confirmReceiptEmail, escalatedEmail, replySubject, scrambledLine, thanksEmail } from "./replies";

describe("reply templates", () => {
  it("replySubject keeps one Re:", () => {
    expect(replySubject("Program data for Arts")).toBe("Re: Program data for Arts");
    expect(replySubject("RE: Program data")).toBe("RE: Program data");
    expect(replySubject(null)).toBe("Re: Program data");
  });

  it("every email is signed and asks only one thing", () => {
    for (const e of [clarifyEmail({ question: "How many?" }), thanksEmail({ orgName: "A" }), escalatedEmail(), confirmReceiptEmail({ orgName: "A", cycles: [], open: [], scrambled: { names: 0, cdcr: 0 } })]) {
      expect(e.text.trim().endsWith("Sam, TPW's data assistant")).toBe(true);
    }
    const c = clarifyEmail({ question: "How many?" });
    expect(c.text).toContain("How many?");
    expect(c.text.match(/\?/g)).toHaveLength(1);
  });

  it("the receipt lists what was kept, what is missing, the scramble count and how to confirm", () => {
    const r = confirmReceiptEmail({
      orgName: "Arts & Co",
      cycles: [{ program_name: "Writing Class", facility_name: "California Men's Colony", start_date: "2025-02-03", n_enrolled: 30, n_enrolled_approx: true, n_completed: 22, n_completed_approx: false, completion_rule: "attended 80% of sessions" }],
      open: ["People completed for Writing Class at San Quentin"],
      scrambled: { names: 0, cdcr: 0 },
    });
    expect(r.text).toContain("Writing Class at California Men's Colony, started 2025-02-03: about 30 enrolled, 22 completed; completion means: attended 80% of sessions");
    expect(r.text).toContain("People completed for Writing Class at San Quentin");
    expect(r.text).toContain("nothing needed scrambling");
    expect(r.text).toContain("Reply YES to confirm");
    expect(r.html).toContain("Arts &amp; Co");
    expect(r.text).not.toContain("report:");
  });

  it("states scrambled counts when identifiers were handled", () => {
    expect(scrambledLine(12, 12)).toBe("12 names and 12 CDCR numbers were scrambled and stored separately.");
  });

  it("includes the report link only when given", () => {
    expect(thanksEmail({ orgName: "A", reportUrl: "https://web/o/tok" }).text).toContain("https://web/o/tok");
  });
});
