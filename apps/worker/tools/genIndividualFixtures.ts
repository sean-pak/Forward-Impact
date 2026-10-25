// Writes the phase 10 fixtures: a persona 3 attendance sheet (CSV and XLSX) and a persona 4 individual CSV,
// each with a ground-truth file computed from the planted facts, not from Sam's own code.
// Everything is synthetic: SYN CDCR numbers, made-up names. Same seed, same output.
//   pnpm --filter @tpw/scripts exec tsx ../apps/worker/tools/genIndividualFixtures.ts
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/ingest");
let seed = 20261024;
const rng = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T,>(xs: T[]) => xs[Math.floor(rng() * xs.length)]!;
const shuffle = <T,>(xs: T[]) => xs.map((x) => [rng(), x] as const).sort((a, b) => a[0] - b[0]).map((p) => p[1]);

const FIRST = "Alberto Bernard Calvin Damian Everett Fernando Gilbert Hector Ignacio Jerome Kendrick Lorenzo Maurice Nathaniel Octavio Percy Rafael Salvador Terrence Ulysses Vernon Wendell Xavier Yusuf Zachary Armando Basilio Cornelius Desmond Emmanuel Franklin Gustavo Horacio Isidro Julian Leopold Mauricio Napoleon Orlando Patrick Reginald Silas Tobias Ulrich Valentin Warren Alonzo Bartholomew Clarence Dominic Edmund Florian Gregory Harlan Ismael Jasper Kareem Leonard Marshall Nelson".split(" ");
const LAST = "Abernathy Blackwood Castellano Delacroix Ellington Fairbanks Gutierrez Hawthorne Iglesias Jovanovic Kowalczyk Lindqvist Montenegro Nakamura Okonkwo Pemberton Quattrone Rutherford Sandoval Thibodeaux Underhill Valdivia Whitaker Yamamoto Zamudio Ashworth Bellamy Cavanaugh Dunleavy Escobedo Fontaine Galvan Holloway Ibarra Jablonski Kimbrough Lockhart Mendoza Nightingale Ostrander Pellegrino Quigley Radcliffe Salazar Tavares Urquhart Vasquez Wolverton Yeager Zellner Amundsen Brantley Calderon Dillingham Espinoza Fitzgerald Grantham Hargrove Isaacson".split(" ");

const people = (n: number) => {
  const firsts = shuffle(FIRST);
  const lasts = shuffle(LAST);
  // The shift by whole laps keeps every full name distinct up to 3,600 people.
  return Array.from({ length: n }, (_, i) => ({ first: firsts[i % firsts.length]!, last: lasts[(i * 7 + 3 + Math.floor(i / firsts.length)) % lasts.length]! }));
};
const syn = (n: number) => `SYN${String(n).padStart(5, "0")}`;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const csv = (rows: string[][]) => rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n") + "\n";
const write = (name: string, data: string | Uint8Array | object) =>
  writeFileSync(join(OUT, name), typeof data === "string" || data instanceof Uint8Array ? data : JSON.stringify(data, null, 2) + "\n");

// ---------------------------------------------------------------- persona 3: Org C attendance sheet
{
  const N = 60;
  const SESSIONS = 18;
  const CANCELLED = new Set([5, 12]); // lockdown days: blank for everyone
  const start = new Date(Date.UTC(2026, 0, 12));
  const dates = Array.from({ length: SESSIONS }, (_, i) => addDays(start, i * 7));
  const live = [...Array(SESSIONS).keys()].filter((i) => !CANCELLED.has(i));
  const PRESENT = ["X", "X", "X", "✓", "P", "1"];
  const ABSENT = ["", "", "A", "0"];
  const names = people(N);

  // Latent truth: each person's true status per live session, before the symbols are chosen.
  type St = "present" | "late" | "excused" | "absent";
  const truth = names.map((_, i) => {
    const completer = rng() < 0.65;
    const rate = completer ? 0.82 + rng() * 0.18 : 0.25 + rng() * 0.45;
    return { i, statuses: live.map((): St => (rng() < rate ? "present" : "absent")) };
  });
  // Plant the unusual marks: 8 late (counts as attended), 3 court days "JT" (excused), 4 "E" (excused).
  const cells = shuffle(truth.flatMap((t) => live.map((_, k) => [t.i, k] as const)));
  cells.slice(0, 8).forEach(([i, k]) => (truth[i]!.statuses[k] = "late"));
  cells.slice(8, 11).forEach(([i, k]) => (truth[i]!.statuses[k] = "excused"));
  const jt = new Set(cells.slice(8, 11).map(([i, k]) => `${i}:${k}`));
  cells.slice(11, 15).forEach(([i, k]) => (truth[i]!.statuses[k] = "excused"));

  const results = truth.map((t) => {
    const attended = t.statuses.filter((s) => s === "present" || s === "late").length; // late counts as attended
    const planned = live.length;
    return { attended, planned, rate: Math.round((attended / planned) * 10_000) / 10_000, completed: attended / planned >= 0.8 };
  });
  // The "Completed?" column disagrees with the 80% rule for exactly 3 people (not near the line).
  const flips = new Set(results.map((r, i) => [i, Math.abs(r.rate - 0.8)] as const).filter(([, d]) => d > 0.1).slice(0, 3).map(([i]) => i));
  const cbo = results.map((r, i) => (flips.has(i) ? !r.completed : r.completed));

  const symbol = (t: (typeof truth)[number], k: number): string => {
    const s = t.statuses[k]!;
    if (s === "late") return "L";
    if (s === "excused") return jt.has(`${t.i}:${k}`) ? "JT" : "E";
    return s === "present" ? pick(PRESENT) : pick(ABSENT);
  };
  const header = ["Name", "CDCR #", ...dates.map(iso), "Completed?"];
  const body: string[][] = truth.map((t) => {
    const marks = Array.from({ length: SESSIONS }, (_, c) => (CANCELLED.has(c) ? "" : symbol(t, live.indexOf(c))));
    return [`${names[t.i]!.first} ${names[t.i]!.last}`, syn(41_000 + t.i * 3), ...marks, cbo[t.i] ? "Y" : "N"];
  });
  // One duplicate: the same person again, first name misspelled, no CDCR number, one mark different.
  const dupOf = 17;
  const dup = [...body[dupOf]!];
  dup[0] = `${names[dupOf]!.first.slice(0, -1)}${names[dupOf]!.first.endsWith("y") ? "i" : "e"} ${names[dupOf]!.last}`;
  dup[1] = "";
  body.push(dup);

  const notes = "Healing Circle - San Quentin - Spring 2026. Completion = attended at least 80% of sessions. Sheet kept by R.Q.";
  const width = header.length;
  const pad = (cells: string[]) => [...cells, ...Array(width - cells.length).fill("")];
  const grid = [pad([notes]), pad(["", "", "Attendance by class date"]), header, ...body];
  write("org_c_persona3_attendance.csv", csv(grid));

  const ws = XLSX.utils.aoa_to_sheet(grid.map((r, ri) => r.map((c, ci) => (ri === 2 && ci >= 2 && ci < width - 1 ? new Date(Date.UTC(2026, 0, 12 + (ci - 2) * 7)) : c))), { cellDates: true });
  ws["!merges"] = [{ s: { r: 1, c: 2 }, e: { r: 1, c: width - 2 } }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Healing Circle");
  write("org_c_persona3_attendance.xlsx", new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" })));

  // Row numbers are lines of the file with blank lines removed: notes, label, header, then people from line 4.
  write("org_c_persona3_attendance.expected.json", {
    note: "Ground truth planted by the generator. Legend: JT = excused, L = late; a late counts as attended. Rule: at least 80% of sessions.",
    sessions: { total: SESSIONS, cancelled_columns: [...CANCELLED], planned: live.length, start_date: iso(dates[live[0]!]!), end_date: iso(dates[live[live.length - 1]!]!) },
    legend_question_marks: ["JT", "L"],
    duplicate: { lines: [4 + dupOf, 4 + N] },
    people: results.map((r, i) => ({ line: 4 + i, ...r })),
    n_enrolled_before_merge: N + 1,
    n_enrolled: N,
    n_completed: results.filter((r) => r.completed).length,
    n_completed_if_late_not_counted: truth.filter((t) => {
      const a = t.statuses.filter((s) => s === "present").length;
      return a / live.length >= 0.8;
    }).length,
    conflicts: [...flips].map((i) => 4 + i),
  });
  write("org_c_persona3_attendance.llm.json", {
    map_columns: {
      persona: 3, unmapped_marks: [],
      columns: [
        { index: 0, target: "id_full_name" }, { index: 1, target: "id_cdcr" },
        ...dates.map((_, i) => ({ index: 2 + i, target: "session_date" })),
        { index: width - 1, target: "completed_flag" },
      ],
    },
  });
}

// ---------------------------------------------------------------- persona 4: Org D individual CSV
{
  const roster = people(150);
  const rows: string[][] = [];
  const TODAY = "2026-10-25"; // the fixture test passes this as "today"
  const CYCLES = [
    { program: "Reentry Readiness", facility: "Folsom", code: "FSP", start: "2025-02-03", end: "2025-05-12", n: 40 },
    { program: "Reentry Readiness", facility: "Men's Colony", code: "CMC", start: "2025-03-10", end: "2025-06-16", n: 38 },
    { program: "Job Skills Lab", facility: "San Quentin", code: "SQ", start: "2025-09-08", end: "2025-12-15", n: 36 },
    { program: "Job Skills Lab", facility: "Folsom", code: "FSP", start: "2026-02-02", end: "2026-05-11", n: 36 },
  ];
  const dobOf = (i: number) => `${1965 + ((i * 7) % 35)}-${String(1 + ((i * 5) % 12)).padStart(2, "0")}-${String(1 + ((i * 11) % 28)).padStart(2, "0")}`;
  const usDate = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}/${d.slice(0, 4)}`;
  // One record per person, so a person listed twice has the same release and risk both times.
  const person = new Map<number, { cdcr: string | null; risk: string; release: string }>();
  const truthCycles: { program: string; facility: string; code: string; start: string; enrolled: number; completed: number; credits: number }[] = [];
  let next = 0;

  CYCLES.forEach((c, ci) => {
    const t = { program: c.program, facility: c.facility, code: c.code, start: c.start, enrolled: 0, completed: 0, credits: 0 };
    truthCycles.push(t);
    for (let k = 0; k < c.n; k++) {
      // The second cycle repeats the first three people: three people listed in two programs.
      const idx = ci === 1 && k < 3 ? k : next++;
      if (!person.has(idx)) {
        let release = "";
        const r = rng();
        if (r < 0.55) release = iso(addDays(new Date(`${c.end}T00:00:00Z`), 30 + Math.floor(rng() * 300)));
        else release = iso(addDays(new Date(`${TODAY}T00:00:00Z`), 60 + Math.floor(rng() * 700)));
        if (idx === 20) release = "2024-11-20"; // released before the first program started
        if (ci === 2 && k === 21) release = "2025-06-02"; // released before the third program started
        person.set(idx, { cdcr: idx % 20 === 7 ? null : syn(52_000 + idx), risk: rng() < 0.1 ? "" : pick(["Low", "Low", "Moderate", "Moderate", "High"]), release });
      }
      const pr = person.get(idx)!;
      const first = roster[idx % roster.length]!;
      const completed = rng() < 0.65 ? "Y" : rng() < 0.7 ? "N" : "In progress";
      const credits = completed === "Y" ? 10 + Math.floor(rng() * 31) : 0;
      const inCustody = pr.release > TODAY;
      rows.push([
        `${first.first} ${first.last}`, pr.cdcr ?? "", usDate(dobOf(idx)), c.program, c.facility, c.start, c.end,
        completed === "Y" ? String(24 + Math.floor(rng() * 8)) : String(8 + Math.floor(rng() * 14)),
        completed, credits ? String(credits) : "", rng() < 0.5 ? pr.release : usDate(pr.release),
        inCustody ? "" : pick(["Parole", "Parole", "PRCS"]), pr.risk,
      ]);
      t.enrolled++;
      if (completed === "Y") t.completed++;
      t.credits += credits;
    }
  });
  const all = [...person.values()];
  // A person is released before the program when their release date is earlier than the earliest start of their rows.
  const starts = new Map<string, string>();
  rows.forEach((r) => {
    const key = r[1] || r[0]!;
    const prev = starts.get(key);
    if (!prev || r[5]! < prev) starts.set(key, r[5]!);
  });
  const pre = rows.filter((r, i) => {
    const idxRelease = r[10]!.includes("/") ? iso(new Date(Date.UTC(+r[10]!.split("/")[2]!, +r[10]!.split("/")[0]! - 1, +r[10]!.split("/")[1]!))) : r[10]!;
    return idxRelease <= TODAY && idxRelease < starts.get(r[1] || r[0]!)! && rows.findIndex((x) => (x[1] || x[0]) === (r[1] || r[0])) === i;
  }).length;
  const header = ["Name", "Inmate #", "DOB", "Program", "Facility", "Start", "End", "Hours", "Grad?", "Credits earned", "Release date", "Supervision", "Risk"];
  write("org_d_persona4_individuals.csv", csv([header, ...rows]));
  write("org_d_persona4_individuals.expected.json", {
    note: "Ground truth planted by the generator. Today for the test is 2026-10-25. People are counted once however many programs they are in.",
    rows: rows.length,
    cycles: truthCycles,
    people: all.length,
    people_with_no_cdcr: all.filter((x) => !x.cdcr).length,
    people_with_cdcr: all.filter((x) => x.cdcr).length,
    people_released: all.filter((x) => x.release <= TODAY).length,
    people_with_future_release: all.filter((x) => x.release > TODAY).length,
    people_released_before_program_start: pre,
    rows_with_blank_risk: rows.filter((r) => !r[12]).length,
  });
  write("org_d_persona4_individuals.llm.json", {
    map_columns: {
      persona: 4, unmapped_marks: [],
      columns: [
        { index: 0, target: "id_full_name" }, { index: 1, target: "id_cdcr" }, { index: 2, target: "id_dob" },
        { index: 3, target: "program_name" }, { index: 4, target: "facility_raw" }, { index: 5, target: "start_date" }, { index: 6, target: "end_date" },
        { index: 7, target: "hours_attended" }, { index: 8, target: "completed_flag" }, { index: 9, target: "credit_days_earned" },
        { index: 10, target: "release_date" }, { index: 11, target: "supervision_type" }, { index: 12, target: "risk_band" },
      ],
    },
  });
}
console.log("fixtures written to", OUT);
