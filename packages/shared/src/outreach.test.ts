import { describe, expect, it } from "vitest";
import { askEmail, outreachStats } from "./outreach";

const input = { orgName: "Arts & Co", contactName: "Dana Reyes", formUrl: "https://web/submit/tok", pixelUrl: "https://w/p/x.gif" };

describe("askEmail", () => {
  it("has the form link, the reply path, the signature and the pixel", () => {
    const e = askEmail(input);
    expect(e.text).toContain("https://web/submit/tok");
    expect(e.text).toContain("numbers, spreadsheets, attendance sheets, photos");
    expect(e.text.trim().endsWith("Sam, TPW's data assistant")).toBe(true);
    expect(e.text).toContain("not a person");
    expect(e.html).toContain('<img src="https://w/p/x.gif"');
    expect(e.html).toContain("Arts &amp; Co");
    expect(e.text).toContain("Hi Dana,");
  });
  it("greets without a name", () => {
    expect(askEmail({ ...input, contactName: " " }).text.startsWith("Hello,")).toBe(true);
  });
});

describe("outreachStats", () => {
  it("is empty-safe: no rate without sends", () => {
    expect(outreachStats([])).toEqual({ sent: 0, opened: 0, replied: 0, responseRate: null, medianHoursToReply: null });
  });
  it("reports the rate with numerator and denominator and the median reply time", () => {
    const s = outreachStats([
      { sent_at: "2026-10-26T00:00:00Z", opened_at: "2026-10-26T01:00:00Z", replied_at: "2026-10-26T02:00:00Z" },
      { sent_at: "2026-10-26T00:00:00Z", opened_at: null, replied_at: "2026-10-26T06:00:00Z" },
      { sent_at: "2026-10-26T00:00:00Z", opened_at: null, replied_at: null },
    ]);
    expect(s).toMatchObject({ sent: 3, opened: 1, replied: 2, responseRate: { numerator: 2, denominator: 3 }, medianHoursToReply: 4 });
  });
});
