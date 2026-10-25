// Deterministic synthetic demo dataset for Sam, TPW's data assistant. Replaces "Muse" (docs/SYNTHETIC_DATA_PROMPT.md).
// Run from the repo root:  pnpm exec tsx scripts/synthetic/generate.ts
// Writes synthetic/canonical/*.csv, synthetic/expected/*, synthetic/mock_locator.json and synthetic/README.md.
// Seed 20261024. Same seed, same bytes. Everything here is invented: no real person, org, address or CDCR number.
//
// DEMO ASSUMPTION (not a finding): simulated outcomes use a mild program effect (completers x 0.92) so the program group is
// close to the CDCR benchmark. Participants self-select; the product tells viewers "association, not cause".
import Papa from "papaparse";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "synthetic");
const SEED = 20261024;

// ---------------------------------------------------------------------------------------------------------------------
// seeded randomness

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const ri = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
const chance = (p: number) => rand() < p;
const between = (a: number, b: number) => a + rand() * (b - a);
function weighted<T>(items: readonly (readonly [T, number])[]): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let x = rand() * total;
  for (const [v, w] of items) {
    x -= w;
    if (x < 0) return v;
  }
  return items[items.length - 1]![0];
}
function shuffle<T>(xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}
function normal(): number {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}
function gamma(k: number): number {
  if (k < 1) return gamma(k + 1) * Math.pow(1 - rand(), 1 / k);
  const dd = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * dd);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + dd * (1 - v + Math.log(v))) return dd * v;
  }
}
const beta = (a: number, b: number) => {
  const x = gamma(a);
  return x / (x + gamma(b));
};
const round = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp;

// ---------------------------------------------------------------------------------------------------------------------
// dates as day numbers (UTC)

const DAY = 86_400_000;
const D = (s: string) => Math.round(Date.parse(`${s}T00:00:00Z`) / DAY);
const F = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
const ASOF = D("2026-10-24"); // data is censored here
const REL_CAP = D("2026-06-30"); // last day of FY2025_26
const fyOf = (n: number) => {
  const y = Number(F(n).slice(0, 4));
  const m = Number(F(n).slice(5, 7));
  const s = m >= 7 ? y : y - 1;
  return `FY${s}_${String((s + 1) % 100).padStart(2, "0")}`;
};
const fyStart = (label: string) => D(`${label.slice(2, 6)}-07-01`);
const fyEnd = (label: string) => D(`${Number(label.slice(2, 6)) + 1}-06-30`);
function shiftYears(day: number, years: number): number {
  const dt = new Date(day * DAY);
  dt.setUTCFullYear(dt.getUTCFullYear() - years);
  return Math.round(dt.getTime() / DAY);
}
function ageOn(dob: string, on: string): number {
  let age = Number(on.slice(0, 4)) - Number(dob.slice(0, 4));
  const md = (s: string) => Number(s.slice(5, 7)) * 100 + Number(s.slice(8, 10));
  if (md(on) < md(dob)) age--;
  return age;
}
function bandOfAge(age: number): string {
  if (age < 18) return "unknown";
  if (age >= 60) return "60_plus";
  if (age < 20) return "18_19";
  const lo = Math.floor(age / 5) * 5;
  return `${lo}_${lo + 4}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// completion rules (same idea as the product: a rule is only applied when it can be parsed)

type Rule = { kind: "pct"; min: number } | { kind: "count"; min: number } | null;
function parseRule(text: string): Rule {
  const t = text.toLowerCase();
  const pct = /(\d{1,3})\s*%/.exec(t);
  if (pct) return { kind: "pct", min: Number(pct[1]) / 100 };
  if (/\b(?:all|every|each)\b[^.]*\bsessions?\b/.test(t)) return { kind: "pct", min: 1 };
  const count = /at least\s*(\d+)\s*sessions?/.exec(t);
  if (count) return { kind: "count", min: Number(count[1]) };
  return null;
}
const ruleMet = (r: NonNullable<Rule>, attended: number, planned: number) =>
  r.kind === "count" ? attended >= r.min : planned > 0 && attended / planned >= r.min - 1e-9;

// ---------------------------------------------------------------------------------------------------------------------
// reference data

const FACILITY_CODES = new Set(
  "ASP CAL CCI CCWF CEN CHCF CIM CIW CMC CMF COR CRC CTF FSP HDSP ISP KVSP LAC MCSP NKSP PBSP PVSP RJD SAC SATF SCC SOL SQ SVSP VSP WSP".split(" "),
);
const FIRST_NAMES =
  "Adrian Alan Alberto Andre Angel Anthony Antonio Arturo Ben Brandon Brian Calvin Carlos Cesar Charles Chris Cory Curtis Damon Daniel Darnell Darius David Dennis Derek Diego Donald Dwayne Edgar Eduardo Elias Emilio Enrique Eric Ernest Esteban Evan Felix Fernando Francisco Frank Gabriel Garrett George Gerald Gilbert Gregory Hector Henry Hugo Ian Isaac Ivan Jacob Jamal Jared Javier Jay Jeremy Jerome Jesse Joel Jonathan Jorge Jose Joshua Juan Julian Justin Keith Kenneth Kevin Lamar Larry Lawrence Leon Leonard Lewis Louis Luis Malik Manuel Marcus Mario Mark Martin Marvin Matthew Maurice Melvin Michael Miguel Mitchell Nathan Neil Nelson Nicholas Noah Omar Oscar Pablo Patrick Paul Pedro Peter Phillip Rafael Ramon Randall Raymond Reginald Ricardo Richard Robert Roberto Rodney Roger Roland Ronald Ruben Russell Ryan Salvador Samuel Santiago Sean Sergio Shane Stanley Stephen Steven Terrance Terry Thomas Timothy Tony Travis Trevor Tyrone Vernon Victor Vincent Walter Warren Wayne William Xavier Zachary".split(
    " ",
  );
const LAST_NAMES =
  "Abbott Acosta Aguilar Alvarado Anderson Archer Armstrong Atkins Avila Bailey Baker Banks Barajas Barnett Barrera Bell Bennett Benson Bishop Blackwell Booker Bowman Bradley Brennan Briggs Brooks Bryant Burke Burns Caldwell Calhoun Camacho Campos Carrillo Carter Castillo Chambers Chavez Clarke Cobb Coleman Collins Contreras Cooper Cortez Crawford Cruz Cunningham Daniels Davidson Dawson Delgado Diaz Dixon Dominguez Donovan Douglas Duarte Duncan Dunn Edwards Ellis Escobar Espinoza Estrada Evans Farmer Ferguson Fields Figueroa Fisher Fleming Flores Fowler Franklin Frazier Fuentes Gallegos Garner Gibson Gilbert Gomez Gonzales Graham Grant Gray Greene Griffin Guerrero Gutierrez Hammond Hanson Harper Harrison Hartman Hayes Henderson Hernandez Hicks Hodges Holland Holmes Houston Howard Hudson Hughes Hunter Ibarra Ingram Jackson Jacobs Jefferson Jenkins Jensen Johnston Jordan Keller Kennedy Kim Knight Lambert Lawson Leon Lewis Lindsey Lopez Lowe Lozano Lucero Lynch Maldonado Marshall Mathis Maxwell McBride McCoy Medina Mendez Mercado Meyers Miller Mills Mitchell Montoya Moody Morales Moreno Morgan Morrison Munoz Murphy Navarro Nelson Newman Nguyen Nichols Noble Norris Ochoa Oliver Ortega Owens Pacheco Padilla Parker Patterson Payne Pearson Pena Perkins Perry Phillips Pierce Pittman Porter Powell Quinn Ramirez Ramsey Randall Ray Reed Reyes Rhodes Richards Riley Rivera Roberts Robles Rocha Rodgers Rojas Romero Rosales Rowe Ruiz Salazar Sanders Santos Schmidt Scott Sharp Shaw Silva Simmons Singleton Solis Soto Spencer Stanley Stevens Stokes Sullivan Tate Thornton Tillman Trujillo Tucker Turner Valdez Vargas Vaughn Vega Wade Walker Wallace Warner Watkins Weaver Webb Wells Whitaker Whitfield Wiley Willis Wilkerson Winters Wong Wood Wright Yates Young Zamora".split(
    " ",
  );
const COUNTIES = ["Los Angeles", "San Diego", "Alameda", "Sacramento", "Fresno", "Kern", "San Joaquin", "Riverside", "San Bernardino", "Contra Costa", "Santa Clara", "Orange", "Stanislaus", "Tulare", "Solano", "Sonoma", "Monterey", "Butte"];
const RETURN_FACILITIES = ["WSP", "CIM", "SQ", "NKSP", "SATF", "KVSP", "COR", "CCI", "CRC", "LAC", "SAC", "PVSP", "CMC", "ASP", "SVSP", "HDSP", "FSP", "MCSP", "CTF", "SOL"];

// ---------------------------------------------------------------------------------------------------------------------
// orgs, programs, facilities

type ProgDef = { key: string; name: string; category: string; rule: string; credits: string; hps: number };
type OrgDef = {
  id: string;
  name: string;
  type: string;
  persona: 1 | 2 | 3 | 4;
  agreement: boolean;
  short: string;
  prefix: string; // org-internal id prefix for persona 4
  facilities: string[];
  programs: ProgDef[];
  contacts: { name: string; title: string; email: string }[];
};

const ORGS: OrgDef[] = [
  {
    id: "org_lantern_row", name: "Lantern Row Arts Collective", type: "arts", persona: 1, agreement: false, short: "lan", prefix: "L",
    facilities: ["SQ", "SOL", "FSP", "CIM"],
    programs: [
      { key: "writing", name: "Writing Through Walls", category: "arts", rule: "attended at least 80% of sessions", credits: "rac", hps: 2 },
      { key: "drawing", name: "Open Studio Drawing", category: "arts", rule: "completed all 12 sessions", credits: "none", hps: 2 },
      { key: "spoken", name: "Spoken Word Workshop", category: "arts", rule: "attended at least 75% of sessions", credits: "rac", hps: 1.5 },
    ],
    contacts: [{ name: "Avery Lindqvist", title: "Program Director", email: "avery.lindqvist@example.org" }, { name: "Sana Whitcombe", title: "Volunteer Coordinator", email: "sana.whitcombe@example.org" }],
  },
  {
    id: "org_cedar_field", name: "Cedar Field Learning Project", type: "education", persona: 1, agreement: false, short: "ced", prefix: "C",
    facilities: ["CMC", "CRC", "MCSP", "CTF"],
    programs: [
      { key: "ged", name: "GED Prep Intensive", category: "education", rule: "earned a certificate of completion", credits: "rac|emc", hps: 2 },
      { key: "math", name: "College Bridge Math", category: "education", rule: "attended at least 80% of sessions", credits: "emc", hps: 2 },
    ],
    contacts: [{ name: "Marisol Okafor", title: "Executive Director", email: "marisol.okafor@example.org" }],
  },
  {
    id: "org_open_hands", name: "Open Hands Fellowship", type: "faith", persona: 1, agreement: false, short: "oph", prefix: "O",
    facilities: ["SQ", "SAC", "RJD", "LAC"],
    programs: [
      { key: "circle", name: "Fellowship Circle", category: "faith", rule: "attended at least 10 sessions", credits: "none", hps: 1.5 },
      { key: "mentor", name: "Mentor Pairing Program", category: "faith", rule: "attended at least 80% of sessions", credits: "rac", hps: 1.5 },
    ],
    contacts: [{ name: "Theodore Brandvold", title: "Chaplain Coordinator", email: "theodore.brandvold@example.org" }],
  },
  {
    id: "org_riverbend", name: "Riverbend Reentry Alliance", type: "reentry", persona: 2, agreement: false, short: "riv", prefix: "R",
    facilities: ["SOL", "CMC", "FSP", "SCC"],
    programs: [
      { key: "readiness", name: "Release Readiness Workshop", category: "other", rule: "unstated", credits: "unknown", hps: 2 },
      { key: "housing", name: "Housing Navigation Class", category: "other", rule: "attended all sessions", credits: "none", hps: 2 },
    ],
    contacts: [{ name: "Delphine Arroyo-Nash", title: "Reentry Manager", email: "delphine.arroyonash@example.org" }],
  },
  {
    id: "org_second_chapter", name: "Second Chapter Legal Clinic", type: "legal", persona: 2, agreement: false, short: "scl", prefix: "S",
    facilities: ["SQ", "CIM", "CRC", "PVSP"],
    programs: [
      { key: "rights", name: "Know Your Rights Series", category: "other", rule: "attended at least 80% of sessions", credits: "none", hps: 2 },
      { key: "clearing", name: "Record Clearing Clinic", category: "other", rule: "completed the intake and filing steps", credits: "none", hps: 2 },
    ],
    contacts: [{ name: "Priya Halvorsen", title: "Managing Attorney", email: "priya.halvorsen@example.org" }, { name: "Gideon Tamura", title: "Paralegal", email: "gideon.tamura@example.org" }],
  },
  {
    id: "org_harbor_light", name: "Harbor Light Employment Network", type: "employment", persona: 2, agreement: false, short: "hrb", prefix: "H",
    facilities: ["MCSP", "SAC", "PVSP", "CIW"],
    programs: [
      { key: "resume", name: "Resume and Interview Skills", category: "job_training", rule: "attended at least 80% of sessions", credits: "none", hps: 2 },
      { key: "digital", name: "Digital Literacy Basics", category: "education", rule: "attended at least 75% of sessions", credits: "emc", hps: 2 },
    ],
    contacts: [{ name: "Beatrix Kowalczyk", title: "Program Lead", email: "beatrix.kowalczyk@example.org" }],
  },
  {
    id: "org_still_water", name: "Still Water Healing Circle", type: "healing", persona: 3, agreement: false, short: "stw", prefix: "W",
    facilities: ["SQ", "CIW", "CTF"],
    programs: [
      { key: "healing", name: "Healing Circle", category: "restorative_justice", rule: "attended at least 80% of sessions", credits: "rac", hps: 2 },
      { key: "grief", name: "Grief and Loss Group", category: "cognitive_behavioral", rule: "attended at least 75% of sessions", credits: "rac", hps: 2 },
    ],
    contacts: [{ name: "Imani Castellanos", title: "Facilitator Lead", email: "imani.castellanos@example.org" }],
  },
  {
    id: "org_common_ground", name: "Common Ground Peacemaking", type: "healing", persona: 3, agreement: false, short: "cmg", prefix: "P",
    facilities: ["SQ", "CMC", "SOL"],
    programs: [{ key: "peace", name: "Peacemaking Circle", category: "restorative_justice", rule: "attended at least 80% of sessions", credits: "rac", hps: 2 }],
    contacts: [{ name: "Lorenzo Fitzgerald", title: "Circle Keeper", email: "lorenzo.fitzgerald@example.org" }],
  },
  {
    id: "org_bridgeway", name: "Bridgeway Learning Lab", type: "education", persona: 3, agreement: false, short: "brg", prefix: "B",
    facilities: ["FSP", "CIM", "SAC"],
    programs: [
      { key: "finlit", name: "Financial Literacy Course", category: "education", rule: "attended at least 80% of sessions", credits: "emc", hps: 2 },
      { key: "smallbiz", name: "Small Business Basics", category: "job_training", rule: "attended at least 75% of sessions", credits: "emc", hps: 2 },
    ],
    contacts: [{ name: "Noor Abernathy", title: "Lab Coordinator", email: "noor.abernathy@example.org" }],
  },
  {
    id: "org_gateway", name: "Gateway Reentry Partners", type: "reentry", persona: 4, agreement: true, short: "gwy", prefix: "G",
    facilities: ["SQ", "SOL", "CMC", "MCSP", "LAC"],
    programs: [
      { key: "t4c", name: "Thinking for a Change", category: "cognitive_behavioral", rule: "completed all 12 modules", credits: "rac", hps: 2 },
      { key: "planning", name: "Release Planning Seminar", category: "other", rule: "attended at least 80% of sessions", credits: "rac", hps: 2 },
      { key: "recovery", name: "Substance Use Recovery Group", category: "substance_use", rule: "attended at least 80% of sessions", credits: "rac", hps: 2 },
    ],
    contacts: [{ name: "Raquel Thorsen", title: "Data Manager", email: "raquel.thorsen@example.org" }, { name: "Dominic Oyelaran", title: "Executive Director", email: "dominic.oyelaran@example.org" }],
  },
  {
    id: "org_northstar", name: "Northstar Education Initiative", type: "education", persona: 4, agreement: true, short: "nst", prefix: "N",
    facilities: ["CTF", "RJD", "LAC", "FSP", "CRC"],
    programs: [
      { key: "abe", name: "Adult Basic Education Cohort", category: "education", rule: "attended at least 75% of sessions", credits: "emc", hps: 2 },
      { key: "prep", name: "College Prep Seminar", category: "education", rule: "completed the final project and exam", credits: "emc", hps: 3 },
    ],
    contacts: [{ name: "Winifred Achterberg", title: "Program Director", email: "winifred.achterberg@example.org" }],
  },
  {
    id: "org_keystone", name: "Keystone Job Skills", type: "employment", persona: 4, agreement: true, short: "key", prefix: "K",
    facilities: ["SOL", "CMC", "RJD", "CIM"],
    programs: [
      { key: "trades", name: "Construction Trades Pre-Apprenticeship", category: "job_training", rule: "passed the final skills assessment", credits: "rac|mcc", hps: 3 },
      { key: "culinary", name: "Culinary Skills Training", category: "job_training", rule: "attended at least 80% of sessions", credits: "rac", hps: 2 },
    ],
    contacts: [{ name: "Tobias Nakagawa", title: "Operations Director", email: "tobias.nakagawa@example.org" }],
  },
];

// ---------------------------------------------------------------------------------------------------------------------
// cycles

type Session = { id: string; date: number; cancelled: boolean; reason: string | null };
type Cycle = {
  id: string;
  short: string;
  org: OrgDef;
  prog: ProgDef;
  fac: string;
  yard: string | null;
  start: number;
  end: number | null;
  S: number | null; // sessions planned (including cancelled dates)
  hoursPer: number | null;
  cap: number;
  inProgress: boolean;
  status: "confirmed" | "awaiting_confirmation" | "superseded";
  nEnr: number | null; // typed aggregates (persona 1/2 only)
  nComp: number | null;
  totalHours: number | null;
  sessions: Session[];
  people: Enr[];
  rule: Rule;
  flags: string[]; // planted data-quality facts for the expected files
};

const cycles: Cycle[] = [];
const usedCycleIds = new Set<string>();

function addCycle(org: OrgDef, prog: ProgDef, fac: string, start: number, opts: { inProgress?: boolean; cap?: number } = {}): Cycle {
  const persona = org.persona;
  const S = persona === 3 ? ri(12, 18) : ri(10, 24);
  const end = start + (S - 1) * 7;
  const ym = F(start).slice(2, 4) + F(start).slice(5, 7);
  let short = `${org.short}_${prog.key}_${fac.toLowerCase()}_${ym}`;
  while (usedCycleIds.has(short)) short += "x";
  usedCycleIds.add(short);
  const cycle: Cycle = {
    id: `cy_${short}`, short, org, prog, fac,
    yard: persona === 2 ? null : chance(0.7) ? pick(["A", "B", "C", "D", "Facility A", "Facility B", "Chapel", "Education Wing"]) : null,
    start, end, S, hoursPer: round(S * prog.hps, 1), cap: opts.cap ?? (persona === 3 ? ri(14, 26) : persona === 4 ? ri(36, 72) : 0),
    inProgress: opts.inProgress ?? false, status: "confirmed", nEnr: null, nComp: null, totalHours: null, sessions: [], people: [], rule: parseRule(prog.rule), flags: [],
  };
  cycles.push(cycle);
  return cycle;
}

// When a cycle starts: weights by period so releases have programs behind them in every fiscal year.
const START_BLOCKS: [string, number][] = [
  ["2022-03-01", 1.0], ["2022-07-01", 1.1], ["2023-01-01", 1.3], ["2023-07-01", 1.1], ["2024-01-01", 1.0],
  ["2024-07-01", 0.9], ["2025-01-01", 0.7], ["2025-07-01", 0.6], ["2026-01-01", 0.3],
];
function randomStart(): number {
  const from = D(weighted(START_BLOCKS.map(([s, w]) => [s, w] as const)));
  return ri(from, Math.min(from + 180, D("2026-04-30")));
}

// How many cycles each org x facility gets: a deterministic pattern, so the totals are stable.
const EARLY: Record<string, string> = { "org_gateway|SQ": "2022-01-10", "org_keystone|SOL": "2022-01-24", "org_northstar|CTF": "2022-02-07", "org_still_water|SQ": "2022-02-01" };
const incidences: { org: OrgDef; fac: string }[] = ORGS.flatMap((org) => org.facilities.map((fac) => ({ org, fac })));
const doubled = new Set<number>();
{
  const lowIdx = incidences.map((x, i) => [x, i] as const).filter(([x]) => x.org.persona <= 2).map(([, i]) => i);
  const p3Idx = incidences.map((x, i) => [x, i] as const).filter(([x]) => x.org.persona === 3).map(([, i]) => i);
  const p4Idx = incidences.map((x, i) => [x, i] as const).filter(([x]) => x.org.persona === 4).map(([, i]) => i);
  for (const i of shuffle(lowIdx).slice(0, 5)) doubled.add(i);
  for (const i of shuffle(p3Idx).slice(0, 3)) doubled.add(i);
  for (const i of shuffle(p4Idx).slice(0, 5)) doubled.add(i);
}
incidences.forEach(({ org, fac }, i) => {
  const early = EARLY[`${org.id}|${fac}`];
  const n = doubled.has(i) ? 2 : 1;
  for (let k = 0; k < n; k++) {
    const prog = pick(org.programs);
    const start = k === 0 && early ? D(early) : randomStart();
    addCycle(org, prog, fac, start, early && k === 0 ? { cap: org.persona === 4 ? 62 : 24 } : {});
  }
});
// Riverbend must use its unstated-rule workshop at least once (planted: one rule `unstated`)
{
  const rv = cycles.find((c) => c.org.id === "org_riverbend" && c.fac === "SCC")!;
  rv.prog = ORGS.find((o) => o.id === "org_riverbend")!.programs[0]!;
  rv.rule = parseRule(rv.prog.rule);
}
// A few cycles that are still running (end date in the future, n_completed blank)
const IN_PROGRESS: [string, string, string][] = [
  ["org_lantern_row", "SQ", "2026-09-08"], ["org_cedar_field", "CMC", "2026-08-24"], ["org_riverbend", "SOL", "2026-09-15"],
  ["org_gateway", "LAC", "2026-08-10"], ["org_northstar", "RJD", "2026-09-01"],
];
for (const [orgId, fac, start] of IN_PROGRESS) {
  const org = ORGS.find((o) => o.id === orgId)!;
  const c = addCycle(org, pick(org.programs), fac, D(start), { inProgress: true, cap: org.persona === 4 ? 44 : 0 });
  c.end = D(start) + (c.S! - 1) * 7;
  if (c.end <= ASOF) c.end = ASOF + 21;
}
cycles.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));

// Persona 3 calendars: weekly dates, 1 to 3 cancelled
for (const c of cycles.filter((x) => x.org.persona === 3)) {
  const S = c.S!;
  const cancelIdx = new Set(shuffle(Array.from({ length: S - 2 }, (_, i) => i + 1)).slice(0, ri(1, 3)));
  c.sessions = Array.from({ length: S }, (_, i) => ({
    id: `sess_${c.short}_${String(i + 1).padStart(2, "0")}`,
    date: c.start + i * 7,
    cancelled: cancelIdx.has(i),
    reason: cancelIdx.has(i) ? weighted([["lockdown", 0.45], ["staff_unavailable", 0.3], ["facility_event", 0.15], ["holiday", 0.1]] as const) : null,
  }));
}

// ---------------------------------------------------------------------------------------------------------------------
// people and enrollments (persona 3 and 4 only)

type Completed = "yes" | "no" | "in_progress" | "unknown";
type Enr = {
  id: string; cycle: Cycle; person: Person; date: number; A: number | null; P: number | null; rate: number | null; hours: number | null;
  completed: Completed; basis: "rule_applied" | "cbo_marked" | "unknown"; compDate: number | null; present: Set<string>; excused: Set<string>;
};
type Person = {
  n: number;
  cls: "released_consented" | "released_declined" | "unreleased";
  fy: string | null;
  relDay: number | null; // truth: the (first post-program) release
  leave: boolean; // left before the cycle ended
  enrolls: Enr[];
  cdcr: string | null;
  first: string; last: string;
  dob: string | null;
  internal: Record<string, string>; // org id -> internal id
  risk: string; sup: string; offense: string; sentence: string; prior: string; county: string; age: number;
  hasP4: boolean;
  dup: boolean;
  priorRelDay: number | null; // planted: released once before the program, came back, released again
  revoked: number | null;
  consentFollowup: boolean;
  shareTpw: boolean;
  late: boolean; // planted: first return is after day 1,095
  reReleaseDay: number | null;
  ref: string;
};
const people: Person[] = [];
const newPerson = (cls: Person["cls"], fy: string | null, relDay: number | null): Person => {
  const p: Person = {
    n: people.length, cls, fy, relDay, leave: false, enrolls: [], cdcr: null, first: "", last: "", dob: null, internal: {}, risk: "unknown", sup: "parole",
    offense: "unknown", sentence: "unknown", prior: "unknown", county: "", age: 0, hasP4: false, dup: false, priorRelDay: null, revoked: null,
    consentFollowup: false, shareTpw: false, late: false, reReleaseDay: null, ref: "",
  };
  people.push(p);
  return p;
};

let enrSeq = new Map<string, number>();
function enroll(p: Person, c: Cycle, leaveDay: number | null): Enr {
  const seq = (enrSeq.get(c.id) ?? 0) + 1;
  enrSeq.set(c.id, seq);
  const persona = c.org.persona;
  const date = c.start + (chance(0.15) ? ri(1, 14) : 0);
  const e: Enr = { id: `enr_${c.short}_${String(seq).padStart(3, "0")}`, cycle: c, person: p, date, A: null, P: null, rate: null, hours: null, completed: "unknown", basis: "unknown", compDate: null, present: new Set(), excused: new Set() };
  const leaves = leaveDay !== null && c.end !== null && leaveDay < c.end - 7;
  const live = c.sessions.filter((s) => !s.cancelled);
  const ruleOn = c.rule !== null;
  const typeCompleter = !leaves && chance(0.72);
  if (c.inProgress) {
    e.completed = "in_progress";
    e.basis = "cbo_marked";
  } else {
    const S = c.S!;
    // attendance rate for this person
    let rate: number;
    if (ruleOn || persona === 3) rate = typeCompleter ? 0.8 + 0.2 * beta(2, 1.5) : leaves ? 0.7 * beta(2, 4) : 0.9 * beta(2, 3);
    else rate = typeCompleter ? beta(6, 2) : beta(2, 3);
    if (persona === 3) {
      const L = live.length;
      let A = Math.round(rate * L);
      const usable = leaves ? live.filter((s) => s.date <= (leaveDay as number)) : live;
      A = Math.min(A, usable.length);
      const chosen = shuffle(usable).slice(0, A);
      for (const s of chosen) e.present.add(s.id);
      for (const s of live) if (!e.present.has(s.id) && chance(0.1)) e.excused.add(s.id);
      e.A = A;
      e.P = L;
    } else {
      e.P = S;
      e.A = Math.min(S, Math.round(rate * S));
    }
    e.rate = e.P > 0 ? round(e.A / e.P, 4) : null;
    e.hours = chance(0.05) ? null : round(e.A * c.prog.hps, 1);
    if (c.rule) {
      e.completed = ruleMet(c.rule, e.A, e.P) ? "yes" : "no";
      e.basis = "rule_applied";
    } else if (persona === 4 && chance(0.02)) {
      e.completed = "unknown";
      e.basis = "unknown";
    } else {
      e.completed = leaves ? "no" : typeCompleter ? "yes" : "no";
      e.basis = "cbo_marked";
    }
    if (e.completed === "yes") e.compDate = c.end;
  }
  p.enrolls.push(e);
  c.people.push(e);
  return e;
}

// 1) released people first, so every fiscal year gets exactly the cohort size we want. [fy, consented, declined]
const COHORTS: [string, number, number][] = [["FY2021_22", 27, 12], ["FY2022_23", 158, 68], ["FY2023_24", 152, 65], ["FY2024_25", 98, 42], ["FY2025_26", 28, 12]];
const pool = cycles.filter((c) => c.org.persona >= 3);
for (const [fy, nCons, nDecl] of COHORTS) {
  const lo = Math.max(fyStart(fy), D("2022-03-15"));
  const hi = Math.min(fyEnd(fy), REL_CAP);
  const plans = shuffle([...Array.from({ length: nCons }, () => true), ...Array.from({ length: nDecl }, () => false)]);
  for (const consented of plans) {
    const day = ri(lo, hi);
    const p = newPerson(consented ? "released_consented" : "released_declined", fy, day);
    let cands = pool.filter((c) => c.start <= day - 21 && !c.inProgress);
    if (cands.length === 0) throw new Error(`no cycle available for a release on ${F(day)}`);
    const weights = cands.map((c) => {
      const room = c.cap - c.people.length;
      return [c, (room > 0 ? room : 0.02) * (day >= (c.end as number) ? Math.exp(-(day - (c.end as number)) / 450) : 0.35)] as const;
    });
    const c = weighted(weights);
    p.leave = day < (c.end as number) - 7;
    enroll(p, c, day);
  }
}
// 2) everyone else is still inside
for (const c of pool) {
  while (c.people.length < c.cap) enroll(newPerson("unreleased", null, null), c, null);
}
// 3) about 40 people attend programs at two different orgs
{
  const eligible = shuffle(people.filter((p) => p.enrolls.length === 1));
  let made = 0;
  for (const p of eligible) {
    if (made >= 40) break;
    const first = p.enrolls[0]!.cycle;
    const cands = pool.filter((c) => c.org.id !== first.org.id && (p.relDay === null || c.start <= p.relDay - 21) && (p.relDay !== null || !c.inProgress || c.start > first.start));
    if (cands.length === 0) continue;
    const second = pick(cands);
    enroll(p, second, p.relDay);
    p.dup = true;
    made++;
  }
}
for (const p of people) p.hasP4 = p.enrolls.some((e) => e.cycle.org.persona === 4);

// 4) planted: a few people were released once before the program, came back, and were released again
const priorPick = shuffle(people.filter((p) => p.cls === "released_consented" && !p.dup && p.fy !== null && ["FY2022_23", "FY2023_24", "FY2024_25"].includes(p.fy))).slice(0, 24);
for (const p of priorPick) {
  const startDay = Math.min(...p.enrolls.map((e) => e.cycle.start));
  p.priorRelDay = ri(D("2020-07-01"), startDay - 60);
}

// ---------------------------------------------------------------------------------------------------------------------
// identities

const usedNames = new Set<string>();
const uniqueName = (): [string, string] => {
  for (;;) {
    const f = pick(FIRST_NAMES);
    const l = pick(LAST_NAMES);
    if (!usedNames.has(`${f} ${l}`)) {
      usedNames.add(`${f} ${l}`);
      return [f, l];
    }
  }
};
const cdcrNumbers = shuffle(Array.from({ length: 30000 }, (_, i) => 10000 + i)).slice(0, people.length);
// about 5% of persona 4 people have no CDCR number: only people still inside, with one persona-4 enrollment (they cannot be looked up)
const p4People = people.filter((p) => p.hasP4);
const noCdcr = new Set(shuffle(p4People.filter((p) => p.cls === "unreleased" && !p.dup && p.enrolls.length === 1 && p.enrolls[0]!.cycle.org.persona === 4)).slice(0, Math.round(p4People.length * 0.05)));
const internalSeq = new Map<string, number>();
for (const p of people) {
  [p.first, p.last] = uniqueName();
  if (!noCdcr.has(p)) p.cdcr = `SYN${cdcrNumbers[p.n]}`;
  for (const e of p.enrolls) {
    if (e.cycle.org.persona === 4 && !p.internal[e.cycle.org.id]) {
      const n = (internalSeq.get(e.cycle.org.id) ?? 0) + 1;
      internalSeq.set(e.cycle.org.id, n);
      p.internal[e.cycle.org.id] = `${e.cycle.org.prefix}-${String(n * 3 + ri(0, 2)).padStart(4, "0")}`;
    }
  }
  const primary = p.enrolls[0]!.cycle.org.id;
  p.ref = p.cdcr ?? `${primary}:${p.internal[primary]}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// attributes (birth date, risk band, ...)

const AGE_MIX: [number, number][] = [[18, 2], [20, 12], [25, 18], [30, 18], [35, 15], [40, 11], [45, 9], [50, 7], [55, 5], [60, 3]];
const drawAge = () => {
  const lo = weighted(AGE_MIX.map(([a, w]) => [a, w] as const));
  return lo === 18 ? ri(18, 19) : lo === 60 ? ri(60, 68) : ri(lo, lo + 4);
};
for (const p of people) {
  const firstEnr = Math.min(...p.enrolls.map((e) => e.date));
  if (p.relDay !== null) {
    const minAge = Math.ceil(18 + (p.relDay - firstEnr) / 365.25) + 1;
    p.age = Math.max(drawAge(), minAge);
    p.dob = F(shiftYears(p.relDay, p.age) - ri(0, 364));
  } else {
    p.age = drawAge();
    p.dob = F(shiftYears(firstEnr, p.age) - ri(0, 364));
  }
  p.risk = weighted([["low", 35], ["moderate", 30], ["high", 25], ["unknown", 10]] as const);
  p.sup = weighted([["parole", 55], ["prcs", 43], ["discharged", 2]] as const);
  p.offense = weighted([["persons", 35], ["property", 25], ["drug", 20], ["other", 20]] as const);
  p.sentence = weighted([["determinate", 60], ["determinate_2nd_strike", 15], ["indeterminate", 15], ["third_strike", 5], ["unknown", 5]] as const);
  p.prior = weighted([["1", 45], ["2", 22], ["3", 13], ["4", 8], ["5_9", 9], ["10_plus", 3]] as const);
  p.county = pick(COUNTIES);
}

// ---------------------------------------------------------------------------------------------------------------------
// consent, revocation, and what gets a release row

for (const p of people) {
  if (p.cls === "released_consented") {
    p.consentFollowup = true;
  } else if (p.cls === "released_declined") {
    p.consentFollowup = false;
  } else {
    p.consentFollowup = chance(0.78);
  }
  p.shareTpw = p.consentFollowup ? chance(0.95) : chance(0.55);
}
// about 5% of released people revoked consent. Early cohorts revoke only after the 3-year window, so they stay complete.
{
  const want = Math.round(0.05 * people.filter((p) => p.relDay !== null).length);
  let n = 0;
  for (const p of shuffle(people.filter((x) => x.cls === "released_consented" && !x.dup))) {
    if (n >= want) break;
    const rel = p.relDay as number;
    if (rel <= ASOF - 1160) p.revoked = ri(rel + 1160, ASOF - 1);
    else if (rel >= ASOF - 1095) p.revoked = ri(rel + 30, ASOF - 1);
    else continue;
    n++;
  }
  for (const p of people.filter((x) => x.cls === "unreleased" && x.consentFollowup && !x.dup)) {
    if (chance(0.03)) p.revoked = ri(Math.min(...p.enrolls.map((e) => e.date)) + 14, ASOF - 1);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// releases, simulated outcomes, follow-up

type Rel = { id: string; p: Person; day: number; type: string; sup: string; source: string; post: boolean };
type Out = { p: Person; rel: Rel; type: string; day: number; precision: "exact" | "interval"; earliest: number | null; category: string | null };
type Fup = { p: Person; rel: Rel; observed: number; lastNeg: number | null; censored: boolean; complete: boolean };
const releases: Rel[] = [];
const outcomes: Out[] = [];
const followUps: Fup[] = [];
const usedRelIds = new Set<string>();
const hex8 = () => {
  for (;;) {
    const h = Math.floor(rand() * 0xffffffff).toString(16).padStart(8, "0");
    if (!usedRelIds.has(h)) {
      usedRelIds.add(h);
      return h;
    }
  }
};

const RISK_RTP: Record<string, number> = { low: 0.12, moderate: 0.22, high: 0.32, unknown: 0.21 };
const RISK_CONV: Record<string, number> = { low: 0.18, moderate: 0.41, high: 0.56, unknown: 0.4 };
const SUP_MULT: Record<string, number> = { parole: 0.92, prcs: 1.12, discharged: 0.6 };
const yearDraw = () => {
  const u = rand();
  return u < 0.45 ? ri(1, 365) : u < 0.78 ? ri(366, 730) : ri(731, 1095);
};
const knownRisk = (p: Person) => (p.hasP4 ? p.risk : "unknown");

const consentedReleased = people.filter((p) => p.cls === "released_consented");
// planted: two first returns that happen after day 1,095 (excluded from 3-year rates and flagged)
const latePick = shuffle(consentedReleased.filter((p) => !p.dup && p.revoked === null && (p.relDay as number) <= ASOF - 1200 && p.priorRelDay === null)).slice(0, 2);
for (const p of latePick) p.late = true;

for (const p of consentedReleased) {
  const relDay = p.relDay as number;
  const rel: Rel = { id: `rel_${hex8()}`, p, day: relDay, type: p.sup === "discharged" ? "discharge" : p.priorRelDay !== null ? "re_release" : "first_release", sup: p.sup, source: p.enrolls[0]!.cycle.org.persona === 4 ? "cbo_report" : "simulated", post: true };
  releases.push(rel);
  if (p.priorRelDay !== null) {
    releases.push({ id: `rel_${hex8()}`, p, day: p.priorRelDay, type: "first_release", sup: weighted([["parole", 55], ["prcs", 45]] as const), source: p.enrolls[0]!.cycle.org.persona === 4 ? "cbo_report" : "simulated", post: false });
  }
  // how long we could watch this person
  const horizonEnd = Math.min(ASOF, p.revoked ?? ASOF);
  const H = horizonEnd - relDay;
  const completer = p.enrolls[0]!.completed === "yes";
  const mult = (completer ? 0.92 : 1) * (SUP_MULT[p.sup] ?? 1);
  const pRtp = Math.min(0.9, (RISK_RTP[knownRisk(p)] ?? 0.2) * mult);
  const pConv = Math.min(0.9, (RISK_CONV[knownRisk(p)] ?? 0.4) * mult);
  const pArr = Math.min(0.85, pConv + 0.2);

  let rtp: number | null = null; // latent day of return, if any
  if (p.late) rtp = ri(1100, 1190);
  else if (chance(pRtp)) rtp = yearDraw();
  const viaConv = rtp !== null && !p.late && chance(0.6);
  const cat = () => weighted([["persons", 30], ["property", 28], ["drug_alcohol", 24], ["other", 18]] as const);
  let convDay: number | null = null;
  let convCat: string | null = null;
  if (viaConv && rtp !== null) {
    convDay = Math.max(1, rtp - ri(20, 200));
    convCat = cat();
  } else {
    const pc2 = Math.max(0, Math.min(1, (pConv - 0.6 * pRtp) / (1 - pRtp)));
    if (chance(pc2)) {
      convDay = yearDraw();
      convCat = cat();
    }
  }
  let arrDay: number | null = null;
  if (convDay !== null) {
    if (chance(0.95)) arrDay = Math.max(1, convDay - ri(7, 90));
  } else if (rtp !== null && !p.late && chance(0.55)) {
    arrDay = Math.max(1, rtp - ri(10, 120));
  } else if (rtp === null) {
    const pa2 = Math.max(0, Math.min(1, (pArr - pConv) / (1 - pConv)));
    if (chance(pa2)) arrDay = yearDraw();
  }
  const jailDay = chance(0.04) ? ri(30, 900) : null;

  const add = (type: string, day: number, precision: "exact" | "interval", earliest: number | null, category: string | null) => {
    outcomes.push({ p, rel, type, day: relDay + day, precision, earliest, category });
  };
  if (arrDay !== null && arrDay <= H) add("arrest", arrDay, "exact", null, cat());
  if (convDay !== null && convDay <= H) add("conviction", convDay, "exact", null, convCat);
  if (jailDay !== null && jailDay <= H) add("county_jail", jailDay, "exact", null, weighted([["other", 40], ["drug_alcohol", 35], ["property", 25]] as const));
  if (rtp !== null && rtp <= H) {
    const category = p.late ? "other" : viaConv ? convCat : "supervision_violation";
    if (!p.late && chance(0.35)) {
      // the locator only bounds the date: last negative check, then the first check that saw them inside
      const E = Math.max(relDay, relDay + rtp - ri(1, 89));
      const Fd = Math.min(horizonEnd, E + 90);
      let mid = E + Math.floor((Fd - E) / 2);
      if (convDay !== null) mid = Math.max(mid, relDay + convDay + 1);
      add("return_to_prison", Math.min(mid, horizonEnd) - relDay, "interval", E, category);
    } else {
      add("return_to_prison", rtp, "exact", null, category);
    }
  }
  // follow-up: custody checks about every 90 days
  const ev = outcomes.find((o) => o.rel === rel && o.type === "return_to_prison");
  let observed: number;
  let lastNeg: number | null;
  let censored: boolean;
  let complete: boolean;
  if (ev) {
    const t = ev.day - relDay;
    observed = Math.min(1095, t);
    lastNeg = ev.precision === "interval" ? ev.earliest : Math.max(relDay, ev.day - ri(1, 89));
    if (t > 1095) lastNeg = relDay + 1095 - ri(0, 60);
    censored = false;
    complete = true;
  } else {
    const last = p.revoked !== null ? Math.max(relDay, p.revoked - ri(0, 60)) : ASOF - ri(0, 89);
    observed = Math.max(0, Math.min(1095, last - relDay));
    lastNeg = last;
    censored = observed < 1095;
    complete = !censored;
  }
  followUps.push({ p, rel, observed, lastNeg, censored, complete });
}

// planted: a few people returned and were released again; only the first return counts
const rtpOf = new Map<Person, Out>();
for (const o of outcomes) if (o.type === "return_to_prison") rtpOf.set(o.p, o);
const releasedAgain = shuffle([...rtpOf.entries()].filter(([p, o]) => !p.late && p.priorRelDay === null && p.revoked === null && o.day <= D("2025-06-30") && p.cdcr !== null)).slice(0, 6);
for (const [p, o] of releasedAgain) {
  const day = o.day + ri(200, 700);
  p.reReleaseDay = Math.min(day, REL_CAP);
  const base = releases.find((r) => r.p === p && r.post)!;
  const rel: Rel = { id: `rel_${hex8()}`, p, day: p.reReleaseDay, type: "re_release", sup: weighted([["parole", 55], ["prcs", 45]] as const), source: "simulated", post: true };
  releases.push(rel);
  const last = ASOF - ri(0, 89);
  const observed = Math.min(1095, last - rel.day);
  followUps.push({ p, rel, observed, lastNeg: last, censored: observed < 1095, complete: observed >= 1095 });
  void base;
}
releases.sort((a, b) => a.id.localeCompare(b.id));

// ---------------------------------------------------------------------------------------------------------------------
// mock locator (consistent with the simulated returns)

type MockRec = { cdcr_number: string; first_name: string; last_name: string; status: "in_custody" | "not_found"; facility: string | null; admission_date: string | null; projected_release_date: string | null };
const custodyOf = new Map<Person, { status: "in_custody" | "released" | "unknown"; projected: number | null; source: string; asOf: string; mock: MockRec | null }>();

// edge-case people
const pickBy = <T>(xs: T[], used: Set<unknown>): T | undefined => xs.find((x) => !used.has(x));
const usedEdge = new Set<unknown>();
const inCustodyReturns = [...rtpOf.entries()]
  .filter(([p]) => p.cdcr !== null && p.revoked === null && p.reReleaseDay === null && !p.late)
  .map(([p]) => p);
const pairA = shuffle(inCustodyReturns)[0]!;
const pairB = shuffle(inCustodyReturns.filter((p) => p !== pairA && p.enrolls[0]!.cycle.org.id !== pairA.enrolls[0]!.cycle.org.id))[0]!;
usedEdge.add(pairA).add(pairB);
{
  // same first and last name, different people
  for (const nm of [`${pairA.first} ${pairA.last}`, `${pairB.first} ${pairB.last}`]) usedNames.delete(nm);
  const [f, l] = uniqueName();
  pairA.first = pairB.first = f;
  pairA.last = pairB.last = l;
}
const errorPerson = pickBy(shuffle(consentedReleased.filter((p) => p.cdcr !== null && p.revoked === null && !rtpOf.has(p) && p.reReleaseDay === null && !p.late)), usedEdge) as Person;
usedEdge.add(errorPerson);
const returnedAgain = releasedAgain.map(([p]) => p).find((p) => p.cdcr !== null) as Person;

for (const p of people) {
  const firstEnr = Math.min(...p.enrolls.map((e) => e.date));
  const lastCycle = p.enrolls.reduce((a, b) => (b.cycle.start > a.cycle.start ? b : a)).cycle;
  const cboAsOf = `${F(Math.min(ASOF, (lastCycle.end as number) + 3))}T00:00:00Z`;
  let rec: MockRec | null = null;
  const base = { first_name: p.first, last_name: p.last };
  if (p.cls === "unreleased") {
    const projected = ASOF + ri(60, 3650);
    custodyOf.set(p, { status: "in_custody", projected, source: "cbo_report", asOf: cboAsOf, mock: null });
    if (p.cdcr) rec = { cdcr_number: p.cdcr, ...base, status: "in_custody", facility: lastCycle.fac, admission_date: F(firstEnr - ri(365, 365 * 14)), projected_release_date: F(projected) };
  } else if (p.cls === "released_declined") {
    custodyOf.set(p, { status: "unknown", projected: null, source: "cbo_report", asOf: cboAsOf, mock: null });
    if (p.cdcr) rec = { cdcr_number: p.cdcr, ...base, status: "not_found", facility: null, admission_date: null, projected_release_date: null };
  } else {
    const o = rtpOf.get(p);
    if (o && p.reReleaseDay === null) {
      const projected = Math.max(o.day + ri(240, 1000), ASOF + ri(60, 700));
      custodyOf.set(p, { status: "in_custody", projected, source: "simulated", asOf: `${F(ASOF)}T00:00:00Z`, mock: null });
      if (p.cdcr) rec = { cdcr_number: p.cdcr, ...base, status: "in_custody", facility: pick(RETURN_FACILITIES), admission_date: F(o.day), projected_release_date: F(projected) };
    } else {
      custodyOf.set(p, { status: "released", projected: null, source: "simulated", asOf: `${F(ASOF)}T00:00:00Z`, mock: null });
      if (p.cdcr) rec = { cdcr_number: p.cdcr, ...base, status: "not_found", facility: null, admission_date: null, projected_release_date: null };
    }
  }
  custodyOf.get(p)!.mock = rec;
}

// ---------------------------------------------------------------------------------------------------------------------
// writing CSVs

const cell = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "true" : "false") : typeof v === "number" ? String(v) : String(v));
const outputs = new Map<string, { header: string[]; rows: string[][] }>();
function csv(file: string, header: string[], rows: unknown[][]) {
  outputs.set(file, { header, rows: rows.map((r) => r.map(cell)) });
}
const dateOrNull = (n: number | null) => (n === null ? null : F(n));

csv("org.csv", ["org_id", "org_name", "org_type", "data_persona", "primary_contact_email", "has_data_agreement"],
  ORGS.map((o) => [o.id, o.name, o.type, o.persona, o.contacts[0]!.email, o.agreement]));
csv("contacts.csv", ["contact_id", "org_id", "name", "email", "title", "is_primary", "rank"],
  ORGS.flatMap((o) => o.contacts.map((c, i) => [`ct_${o.short}_${i + 1}`, o.id, c.name, c.email, c.title, i === 0, i + 1])));
csv("program.csv", ["program_id", "org_id", "program_name", "program_category", "completion_rule", "credit_types_offered"],
  ORGS.flatMap((o) => o.programs.map((p) => [`prog_${o.short}_${p.key}`, o.id, p.name, p.category, p.rule, p.credits])));

// persona 1 and 2 aggregates, plus the planted messiness
for (const c of cycles.filter((x) => x.org.persona <= 2)) {
  const sparse = c.org.persona === 2;
  const size = sparse ? ri(14, 40) : ri(12, 32);
  c.nEnr = c.inProgress ? Math.max(10, Math.round(size * 0.9)) : size;
  c.nComp = c.inProgress ? null : Math.min(c.nEnr, Math.round(c.nEnr * between(0.55, 0.9)));
  if (!sparse && !c.inProgress) c.totalHours = round(c.nEnr * (c.hoursPer as number) * between(0.62, 0.85), 0);
  if (sparse) {
    c.S = chance(0.7) ? null : c.S;
    c.hoursPer = null;
    c.totalHours = null;
    if (chance(0.3) && !c.inProgress) {
      c.end = null;
      c.flags.push("end_date_missing");
    }
  }
}
const sparseCycles = cycles.filter((x) => x.org.persona === 2 && !x.inProgress);
// planted on persona 2: two cycles with no completed count, one with approximate-looking counts, one superseded resubmission
const missingComp = sparseCycles.filter((c) => c.end !== null).slice(0, 2);
for (const c of missingComp) {
  c.nComp = null;
  c.flags.push("n_completed_missing");
}
const approx = sparseCycles.filter((c) => !missingComp.includes(c) && c.org.id === "org_second_chapter")[0] ?? sparseCycles.filter((c) => !missingComp.includes(c))[0]!;
approx.nEnr = 30;
approx.nComp = 22;
approx.flags.push("approximate_counts");
for (const c of cycles.filter((x) => x.org.persona === 2 && x.prog.rule === "unstated")) c.flags.push("completion_rule_unstated");
// two aggregate cycles are still waiting for the CBO to confirm (they do not count yet)
const waiting = cycles.filter((c) => c.org.persona === 1 && !c.inProgress).slice(-2);
for (const c of waiting) {
  c.status = "awaiting_confirmation";
  c.flags.push("awaiting_confirmation");
}
for (const c of cycles.filter((x) => x.inProgress)) c.flags.push("in_progress");
// a corrected resubmission: the first, typo'd one is superseded
const resub = sparseCycles.find((c) => !missingComp.includes(c) && c !== approx && c.end !== null)!;
const superseded: Cycle = { ...resub, id: `${resub.id}_v1`, short: `${resub.short}_v1`, status: "superseded", nEnr: (resub.nEnr as number) + ri(3, 8), people: [], sessions: [], flags: ["superseded"] };

const cycleRows = [...cycles, superseded].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
csv("program_cycle.csv",
  ["cycle_id", "program_id", "facility_code", "yard", "start_date", "end_date", "sessions_planned", "course_hours_planned_per_participant", "n_enrolled", "n_completed", "total_course_hours_delivered", "source_grain", "status"],
  cycleRows.map((c) => {
    const derived = c.org.persona >= 3;
    return [c.id, `prog_${c.org.short}_${c.prog.key}`, c.fac, c.yard, dateOrNull(c.start), dateOrNull(c.end), c.S, c.hoursPer, derived ? null : c.nEnr, derived ? null : c.nComp, derived ? null : c.totalHours, derived ? "derived_from_individuals" : "aggregate", c.status];
  }));
csv("session.csv", ["session_id", "cycle_id", "session_date", "cancelled", "cancel_reason"],
  cycles.flatMap((c) => c.sessions.map((s) => [s.id, c.id, F(s.date), s.cancelled, s.reason])));
csv("session_attendance.csv", ["session_id", "person_ref", "status"],
  cycles.flatMap((c) => c.people.flatMap((e) => c.sessions.filter((s) => !s.cancelled).map((s) => [s.id, e.person.ref, e.present.has(s.id) ? "present" : e.excused.has(s.id) ? "excused" : "absent"]))));

csv("person_identity.csv", ["cdcr_number", "first_name", "last_name", "date_of_birth", "org_id", "org_internal_id"],
  people.flatMap((p) => {
    const orgs = [...new Set(p.enrolls.map((e) => e.cycle.org.id))];
    return orgs.map((orgId) => {
      const org = ORGS.find((o) => o.id === orgId)!;
      return [p.cdcr, p.first, p.last, org.persona === 4 ? p.dob : null, orgId, org.persona === 4 ? p.internal[orgId] : null];
    });
  }));

const consentVersion = (day: number) => (day < D("2023-07-01") ? "CF-2022-01" : day < D("2025-01-01") ? "CF-2023-07" : "CF-2025-01");
csv("consent.csv", ["person_ref", "org_id", "consent_followup", "consent_share_with_tpw", "consent_date", "revoked_date", "consent_form_version"],
  people.flatMap((p) => {
    const byOrg = new Map<string, number>();
    for (const e of p.enrolls) byOrg.set(e.cycle.org.id, Math.min(byOrg.get(e.cycle.org.id) ?? Infinity, e.date));
    return [...byOrg.entries()].map(([orgId, enrolled]) => {
      const date = Math.max(enrolled - ri(0, 7), D("2022-01-01"));
      return [p.ref, orgId, p.consentFollowup, p.shareTpw, F(date), dateOrNull(p.revoked), consentVersion(date)];
    });
  }));

const cohortRelease = (p: Person) => releases.find((r) => r.p === p && r.post && r.day === p.relDay);
csv("person_attributes.csv",
  ["person_ref", "birth_year", "age_band_at_release", "age_band_raw", "risk_band", "commitment_offense_category", "sentence_type", "prior_cdcr_stays_band", "county_of_release"],
  people.map((p) => {
    const rel = cohortRelease(p);
    if (p.hasP4) {
      return [p.ref, Number((p.dob as string).slice(0, 4)), rel ? bandOfAge(ageOn(p.dob as string, F(rel.day))) : "unknown", null, p.risk, p.offense, p.sentence, p.prior, rel ? p.county : null];
    }
    // an attendance sheet has no birth date: keep the coarse band raw, never map it to a CDCR band
    const age = ageOn(p.dob as string, F(p.relDay ?? ASOF));
    const raw = age < 30 ? "18-29" : age < 40 ? "30-39" : age < 50 ? "40-49" : age < 60 ? "50-59" : "60+";
    return [p.ref, null, "unknown", raw, null, null, null, null, rel ? p.county : null];
  }));

csv("enrollment.csv",
  ["enrollment_id", "cycle_id", "person_ref", "enrollment_date", "sessions_attended", "sessions_planned_for_person", "attendance_rate", "hours_attended", "completed", "completion_basis", "completion_date"],
  cycles.flatMap((c) => c.people.map((e) => [e.id, c.id, e.person.ref, F(e.date), e.A, e.P, e.rate, e.hours, e.completed, e.basis, dateOrNull(e.compDate)])));

// credits: completers earn them; applied is blank for 20% of people, lower than earned for 15% of the rest
type Credit = { p: Person; cycle: Cycle; type: string; earned: number; applied: number | null; date: number | null };
const credits: Credit[] = [];
for (const c of cycles) {
  const offered = c.prog.credits.split("|");
  for (const e of c.people) {
    if (e.completed !== "yes") continue;
    const rows: [string, number][] = [];
    if (offered.includes("rac")) rows.push(["rac", ri(10, 40)]);
    if (offered.includes("emc") && (!offered.includes("rac") || chance(0.3))) rows.push(["emc", ri(30, 90)]);
    if (offered.includes("mcc") && chance(0.4)) rows.push(["mcc", ri(10, 30)]);
    const blank = chance(0.2);
    for (const [type, earned] of rows) {
      const applied = blank ? null : chance(0.85) ? earned : Math.floor(earned * between(0.3, 0.9));
      credits.push({ p: e.person, cycle: c, type, earned, applied, date: e.compDate });
    }
  }
}
csv("credit_award.csv", ["person_ref", "cycle_id", "credit_type", "credit_days_earned", "credit_days_applied", "award_date"],
  credits.map((x) => [x.p.ref, x.cycle.id, x.type, x.earned, x.applied, dateOrNull(x.date)]));

csv("custody_status.csv", ["person_ref", "status", "projected_release_date", "as_of", "source"],
  people.map((p) => {
    const c = custodyOf.get(p)!;
    return [p.ref, c.status, dateOrNull(c.projected), c.asOf, c.source];
  }));
csv("release_event.csv", ["release_id", "person_ref", "release_date", "release_fiscal_year", "release_type", "supervision_type", "source", "post_program"],
  releases.map((r) => [r.id, r.p.ref, F(r.day), fyOf(r.day), r.type, r.sup, r.source, r.post]));
csv("outcome_event.csv",
  ["person_ref", "release_id", "outcome_type", "outcome_date", "outcome_date_precision", "outcome_date_earliest", "days_to_outcome", "within_3yr", "outcome_offense_category", "outcome_source", "evidence_check_id"],
  outcomes
    .slice()
    .sort((a, b) => a.rel.id.localeCompare(b.rel.id) || a.type.localeCompare(b.type))
    .map((o) => [o.p.ref, o.rel.id, o.type, F(o.day), o.precision, dateOrNull(o.earliest), o.day - o.rel.day, o.day - o.rel.day <= 1095, o.category, "simulated", null]));
csv("follow_up_status.csv", ["person_ref", "release_id", "days_observed", "last_negative_check", "censored", "follow_up_complete"],
  followUps.slice().sort((a, b) => a.rel.id.localeCompare(b.rel.id)).map((f) => [f.p.ref, f.rel.id, f.observed, dateOrNull(f.lastNeg), f.censored, f.complete]));

// ---------------------------------------------------------------------------------------------------------------------
// mock_locator.json

const mockRecords = people.map((p) => custodyOf.get(p)!.mock).filter((m): m is MockRec => m !== null).sort((a, b) => a.cdcr_number.localeCompare(b.cdcr_number));
const recOf = (p: Person) => mockRecords.find((m) => m.cdcr_number === p.cdcr) as MockRec;
const mockJson = {
  meta: { seed: SEED, generated_on: "2026-10-24", note: "Synthetic. Every person here is invented. Do not send these names to the real locator." },
  records: mockRecords,
  edge_cases: {
    name_only_two_matches: { query: { first_name: pairA.first, last_name: pairA.last }, matches: [recOf(pairA), recOf(pairB)] },
    returned_and_released_shows_not_found: { cdcr_number: returnedAgain.cdcr as string },
    error_response: { cdcr_number: errorPerson.cdcr as string, error: "Service unavailable" },
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// write everything, then compute the expected files from what is on disk

for (const dir of ["canonical", "expected"]) rmSync(join(OUT, dir), { recursive: true, force: true });
rmSync(join(OUT, "mock_locator.json"), { force: true });
rmSync(join(OUT, "README.md"), { force: true });
mkdirSync(join(OUT, "canonical"), { recursive: true });
mkdirSync(join(OUT, "expected"), { recursive: true });
for (const [file, { header, rows }] of outputs) {
  writeFileSync(join(OUT, "canonical", file), Papa.unparse({ fields: header, data: rows }, { newline: "\n" }) + "\n");
}
writeFileSync(join(OUT, "mock_locator.json"), JSON.stringify(mockJson, null, 2) + "\n");

// ---- independent expected metrics: re-read the CSVs, apply schema-v2 definitions only (no repo code) ----
const load = (file: string) => Papa.parse<Record<string, string>>(readFileSync(join(OUT, "canonical", file), "utf8"), { header: true, skipEmptyLines: true }).data;
const bool = (s: string | undefined) => s === "true";
const numOrNull = (s: string | undefined) => (s === undefined || s === "" ? null : Number(s));
const days = (a: string, b: string) => D(b) - D(a);

type Row = Record<string, string>;
const eRel = load("release_event.csv");
const eOut = load("outcome_event.csv").filter((r) => r.outcome_type === "return_to_prison");
const eFol = load("follow_up_status.csv");
const eEnr = load("enrollment.csv");
const eCyc = load("program_cycle.csv");
const ePrg = load("program.csv");
const asOfS = F(ASOF);

type CP = { ref: string; relId: string; relDate: string; fy: string; eventDays: number | null; source: string | null; observed: number };
function cohortPeople(filterRef?: (ref: string, relDate: string) => boolean): CP[] {
  const first = new Map<string, Row>();
  for (const r of eRel) {
    if (!bool(r.post_program) || r.release_date! > asOfS) continue;
    if (filterRef && !filterRef(r.person_ref!, r.release_date!)) continue;
    const cur = first.get(r.person_ref!);
    if (!cur || r.release_date! < cur.release_date! || (r.release_date === cur.release_date && r.release_id! < cur.release_id!)) first.set(r.person_ref!, r);
  }
  const ev = new Map(eOut.map((r) => [`${r.person_ref}|${r.release_id}`, r]));
  const fo = new Map(eFol.map((r) => [`${r.person_ref}|${r.release_id}`, r]));
  const out: CP[] = [];
  for (const r of first.values()) {
    const key = `${r.person_ref}|${r.release_id}`;
    const since = days(r.release_date!, asOfS);
    const e = ev.get(key);
    const eventDays = e ? days(r.release_date!, e.outcome_date!) : null;
    const f = fo.get(key);
    const fromRow = numOrNull(f?.days_observed) ?? 0;
    const fromCheck = f?.last_negative_check ? Math.max(0, days(r.release_date!, f.last_negative_check)) : 0;
    let observed = Math.min(since, Math.max(fromRow, fromCheck, eventDays ?? 0));
    if (eventDays === null || eventDays > 1095) observed = Math.min(observed, 1095);
    out.push({ ref: r.person_ref!, relId: r.release_id!, relDate: r.release_date!, fy: r.release_fiscal_year!, eventDays, source: e ? "simulated" : null, observed });
  }
  return out;
}
function km(group: CP[]): { est: number; lo: number; hi: number } | null {
  const obs = group.map((p) => (p.eventDays !== null && p.eventDays <= 1095 ? { t: p.eventDays, ev: true } : { t: Math.min(p.observed, 1095), ev: false }));
  if (obs.length === 0 || obs.every((o) => o.t === 0 && !o.ev)) return null;
  const times = [...new Set(obs.filter((o) => o.ev).map((o) => o.t))].sort((a, b) => a - b);
  let s = 1;
  let g = 0;
  for (const t of times) {
    const atRisk = obs.filter((o) => o.t >= t).length;
    const d = obs.filter((o) => o.ev && o.t === t).length;
    s *= 1 - d / atRisk;
    if (atRisk > d) g += d / (atRisk * (atRisk - d));
  }
  const se = s * Math.sqrt(g);
  const clip = (x: number) => Math.min(1, Math.max(0, x));
  return { est: 1 - s, lo: clip(1 - s - 1.96 * se), hi: clip(1 - s + 1.96 * se) };
}
const COHORT_HEADER = ["org_id", "program_id", "release_fiscal_year", "outcome_type", "stratum_field", "stratum_value", "n_released", "n_with_1yr", "n_with_2yr", "n_with_3yr", "n_event_1yr", "n_event_2yr", "n_event_3yr", "rate_1yr", "rate_2yr", "rate_3yr", "km_3yr_estimate", "km_3yr_ci_low", "km_3yr_ci_high", "benchmark_rate_3yr", "expected_events_3yr", "standardization_basis", "observed_expected_ratio", "follow_up_complete", "suppressed", "outcome_source_mix", "data_quality_flags"];
const BENCH_RTP = 0.204; // CDCR FY2020-21 all-releases return to prison, crude (schema 8.3)
type CohortStat = { orgId: string; fy: string; n: number; withN: number[]; ev: number[]; complete: boolean; km: ReturnType<typeof km>; mix: Record<string, number>; flags: string[] };
function cohortRows(orgId: string, group: CP[]): { row: string[]; stat: CohortStat }[] {
  const byFy = new Map<string, CP[]>();
  for (const p of group) byFy.set(p.fy, [...(byFy.get(p.fy) ?? []), p]);
  return [...byFy.keys()].sort().map((fy) => {
    const g = byFy.get(fy)!;
    const win = [365, 730, 1095];
    const withN = win.map((w) => g.filter((p) => (p.eventDays !== null && p.eventDays <= w) || p.observed >= w).length);
    const ev = win.map((w) => g.filter((p) => p.eventDays !== null && p.eventDays <= w).length);
    const complete = g.every((p) => (p.eventDays !== null && p.eventDays <= 1095) || p.observed >= 1095);
    const k = km(g);
    const events = g.filter((p) => p.eventDays !== null);
    const mix: Record<string, number> = events.length ? { simulated: 1 } : {};
    const flags: string[] = [];
    if (g.length < 30) flags.push("small_cohort");
    if (!complete) flags.push("interim_rates");
    if (g.some((p) => p.eventDays !== null && p.eventDays > 1095)) flags.push("event_after_window");
    const expected = g.length * BENCH_RTP;
    const rate = (i: number) => (withN[i] ? round(ev[i]! / withN[i]!, 4) : null);
    const row = [orgId, "ALL", fy, "return_to_prison", "all", "all", g.length, ...withN, ...ev, rate(0), rate(1), rate(2), k ? round(k.est, 4) : null, k ? round(k.lo, 4) : null, k ? round(k.hi, 4) : null, BENCH_RTP, round(expected, 2), "crude", complete ? round(ev[2]! / expected, 4) : null, complete, g.length < 30, JSON.stringify(mix), flags.join("|")].map(cell);
    return { row, stat: { orgId, fy, n: g.length, withN, ev, complete, km: k, mix, flags } };
  });
}
const allCohort = cohortRows("TPW_ALL", cohortPeople());
// per org: people whose release is on or after the start of that org's cycle they were enrolled in
const cycleStart = new Map(eCyc.map((r) => [r.cycle_id!, r.start_date!]));
const progOrg = new Map(ePrg.map((r) => [r.program_id!, r.org_id!]));
const cycleOrg = new Map(eCyc.map((r) => [r.cycle_id!, progOrg.get(r.program_id!)!]));
const orgRows: { row: string[]; stat: CohortStat }[] = [];
for (const org of ORGS.filter((o) => o.persona >= 3)) {
  const enrolled = new Map<string, string[]>();
  for (const r of eEnr) if (cycleOrg.get(r.cycle_id!) === org.id) enrolled.set(r.person_ref!, [...(enrolled.get(r.person_ref!) ?? []), cycleStart.get(r.cycle_id!)!]);
  orgRows.push(...cohortRows(org.id, cohortPeople((ref, rel) => (enrolled.get(ref) ?? []).some((s) => s <= rel))));
}
writeFileSync(join(OUT, "expected", "cohort_outcome_metrics.csv"), Papa.unparse({ fields: COHORT_HEADER, data: [...allCohort, ...orgRows].map((x) => x.row) }, { newline: "\n" }) + "\n");

// ---- cycle_metrics (schema 8.1) from the canonical files ----
const eCred = load("credit_award.csv");
const CYCLE_HEADER = ["org_id", "program_id", "cycle_id", "facility_code", "start_date", "end_date", "n_enrolled", "n_completed", "completion_rate", "total_hours_delivered", "mean_hours_per_participant", "mean_attendance_rate", "credit_days_earned_total", "credit_days_applied_total", "years_saved", "dollars_saved", "data_quality_flags"];
const COST_PER_YEAR = 21534; // assumption cost_per_year_2026
const ruleOfProgram = new Map(ePrg.map((r) => [r.program_id!, r.completion_rule!]));
const cycleFlags = new Map(cycleRows.map((c) => [c.id, c.flags]));
const cycleMetricRows: unknown[][] = [];
for (const c of eCyc.filter((r) => r.status === "confirmed")) {
  const enr = eEnr.filter((r) => r.cycle_id === c.cycle_id);
  const derived = c.source_grain === "derived_from_individuals";
  const flags = [...(cycleFlags.get(c.cycle_id!) ?? [])];
  const nEnrolled = derived ? enr.length : numOrNull(c.n_enrolled);
  let nCompleted: number | null;
  if (derived) {
    nCompleted = enr.every((r) => r.completed === "yes" || r.completed === "no") ? enr.filter((r) => r.completed === "yes").length : null;
    if (nCompleted === null) flags.push("n_completed_unknown");
  } else nCompleted = numOrNull(c.n_completed);
  const stated = ruleOfProgram.get(c.program_id!) !== "unstated";
  const completionRate = stated && nCompleted !== null && nEnrolled ? round(nCompleted / nEnrolled, 4) : null;
  if (!stated) flags.push("completion_rate_not_computed");
  let totalHours: number | null;
  let meanHours: number | null;
  if (derived) {
    const hrs = enr.map((r) => numOrNull(r.hours_attended)).filter((x): x is number => x !== null);
    totalHours = hrs.length ? round(hrs.reduce((a, b) => a + b, 0), 1) : null;
    meanHours = hrs.length ? round(hrs.reduce((a, b) => a + b, 0) / hrs.length, 2) : null;
    if (hrs.length < enr.length && hrs.length) flags.push("hours_missing_for_some");
  } else {
    totalHours = numOrNull(c.total_course_hours_delivered);
    meanHours = totalHours !== null && nEnrolled ? round(totalHours / nEnrolled, 2) : null;
  }
  const rates = enr.map((r) => numOrNull(r.attendance_rate)).filter((x): x is number => x !== null);
  const meanRate = derived && rates.length ? round(rates.reduce((a, b) => a + b, 0) / rates.length, 4) : null;
  const cr = eCred.filter((r) => r.cycle_id === c.cycle_id);
  const earned = cr.length ? cr.reduce((a, r) => a + Number(r.credit_days_earned), 0) : null;
  const appliedKnown = cr.map((r) => numOrNull(r.credit_days_applied)).filter((x): x is number => x !== null);
  const applied = cr.length ? appliedKnown.reduce((a, b) => a + b, 0) : null;
  if (cr.length && appliedKnown.length < cr.length) flags.push("credit_days_applied_partial");
  const years = applied !== null && applied > 0 ? round(applied / 365, 3) : null;
  cycleMetricRows.push([progOrg.get(c.program_id!), c.program_id, c.cycle_id, c.facility_code, c.start_date, c.end_date, nEnrolled, nCompleted, completionRate, totalHours, meanHours, meanRate, earned, applied, years, years !== null ? round(years * COST_PER_YEAR, 2) : null, [...new Set(flags)].join("|")]);
}
writeFileSync(join(OUT, "expected", "cycle_metrics.csv"), Papa.unparse({ fields: CYCLE_HEADER, data: cycleMetricRows.map((r) => r.map(cell)) }, { newline: "\n" }) + "\n");

// ---- Sam's expected follow-up questions and the rows the checks must flag (line numbers count the header as line 1) ----
const q = (tpl: string, program: string) => tpl.replace("{program}", program);
const Q = {
  end_date: "What date did {program} end?",
  n_completed: "How many people completed {program}?",
  completion_rule: "What counts as completing {program}? For example, attending 80% of sessions.",
};
const questions: Record<string, { field: string; issue_type: string; question: string }[]> = {};
const orgOfCycle = (c: Cycle) => c.org.id;
for (const c of cycles.filter((x) => x.org.persona === 2)) {
  const key = `${orgOfCycle(c)}_submission`;
  const list = (questions[key] ??= []);
  const name = `${c.prog.name} (${c.fac}, ${F(c.start)})`;
  if (c.flags.includes("end_date_missing")) list.push({ field: "end_date", issue_type: "missing_required", question: q(Q.end_date, name) });
  if (c.flags.includes("n_completed_missing")) list.push({ field: "n_completed", issue_type: "missing_required", question: q(Q.n_completed, name) });
  if (c.flags.includes("approximate_counts")) list.push({ field: "n_enrolled", issue_type: "invalid_value", question: `You wrote about 30 people enrolled in ${name}. What was the exact number?` });
  if (c.flags.includes("completion_rule_unstated") && !list.some((x) => x.field === "completion_rule")) list.push({ field: "completion_rule", issue_type: "missing_required", question: q(Q.completion_rule, c.prog.name) });
}
for (const k of Object.keys(questions)) if (questions[k]!.length === 0) delete questions[k];
const noCdcrCount = [...noCdcr].length;
for (const org of ORGS.filter((o) => o.persona === 4)) {
  const n = [...noCdcr].filter((p) => p.enrolls[0]!.cycle.org.id === org.id).length;
  if (n > 0) (questions[`${org.id}_individuals`] ??= []).push({ field: "cdcr_number", issue_type: "missing_required", question: `${n} people in your file have no CDCR number. Can you send their numbers? Without one we cannot check custody.` });
}
writeFileSync(join(OUT, "expected", "sam_followup_questions.json"), JSON.stringify(questions, null, 2) + "\n");

const lineOf = (file: string, test: (r: Row) => boolean) =>
  load(file).map((r, i) => [r, i + 2] as const).filter(([r]) => test(r)).map(([, line]) => line);
const failures: { file: string; row: number; check: string; reason: string }[] = [];
const lateRels = new Set(latePick.map((p) => p.ref));
for (const line of lineOf("outcome_event.csv", (r) => r.outcome_type === "return_to_prison" && Number(r.days_to_outcome) > 1095 && lateRels.has(r.person_ref!)))
  failures.push({ file: "outcome_event.csv", row: line, check: "Events after day 1095 are excluded from 3-year rates and flagged", reason: "The first return is after day 1,095, so it stays out of the 1, 2 and 3 year counts." });
for (const line of lineOf("release_event.csv", (r) => r.post_program === "false"))
  failures.push({ file: "release_event.csv", row: line, check: "A release before program participation is excluded from that program's outcome cohort", reason: "Released before the person's first program started, so it is not a program outcome." });
failures.push(...lineOf("program_cycle.csv", (r) => r.cycle_id === approx.id).map((line) => ({ file: "program_cycle.csv", row: line, check: 'Approximate numbers ("about 30") are flagged, never silently rounded', reason: "The CBO wrote about 30 enrolled; the count is round and must be confirmed." })));
const releasedRefs = new Set(eRel.map((r) => r.person_ref));
for (const line of lineOf("consent.csv", (r) => r.revoked_date !== "" && r.consent_followup === "true" && releasedRefs.has(r.person_ref)))
  failures.push({ file: "consent.csv", row: line, check: "No custody check without active consent", reason: "Consent was revoked. Lookups stop, already counted outcomes stay." });
writeFileSync(join(OUT, "expected", "validation_failures.json"), JSON.stringify(failures, null, 2) + "\n");

// ---------------------------------------------------------------------------------------------------------------------
// README and a summary on stdout

const counts = [...outputs.entries()].map(([file, { rows }]) => [file, rows.length] as const);
const total = counts.reduce((s, [, n]) => s + n, 0);
const facilitiesWithPrograms = [...new Set(cycles.map((c) => c.fac))].sort();
const orgsAt = (fac: string) => new Set(cycles.filter((c) => c.fac === fac).map((c) => c.org.id)).size;
// Public view (product rules): the whole row is hidden under 30 people; a year's rate is hidden when its denominator is under 30 or it has 1 to 10 events.
const hiddenWhy = (s: CohortStat) => (s.n < 30 ? "whole row (n_released < 30)" : s.withN[2]! < 30 ? "3-yr rate (n_with_3yr < 30)" : s.ev[2]! >= 1 && s.ev[2]! <= 10 ? "3-yr rate (1 to 10 events)" : "nothing hidden at 3 years");
const fyTable = allCohort.map(({ stat: s }) => `| ${s.fy} | ${s.n} | ${s.withN[2]} | ${s.ev[2]} | ${s.complete} | ${hiddenWhy(s)} |`);
const sizeBytes = [...outputs.values()].reduce((s, { header, rows }) => s + Papa.unparse({ fields: header, data: rows }).length, 0);
const readme = `# Synthetic demo dataset

Everything here is invented: orgs, people, names, CDCR numbers (\`SYN\` + 5 digits, \`SYN10000\` to \`SYN39999\`) and emails (\`@example.org\`).
Seed \`${SEED}\`. Data is censored at \`2026-10-24\`. Regenerate with \`pnpm exec tsx scripts/synthetic/generate.ts\` (same seed, same bytes).

**Demo assumption, not a finding.** Simulated 3-year return-to-prison probability is a base rate by risk band (low 0.12, moderate 0.22, high 0.32, unknown 0.21),
times 0.92 for people who completed, times a supervision factor (parole 0.92, PRCS 1.12, discharged 0.6). That lands near the CDCR FY2020-21 rate of 20.4%.
Timing: 45% of returns in year 1, 33% in year 2, 22% in year 3. Participants self-select, so the product says "association, not cause".

## What is here

| File | Rows |
|---|---|
${counts.map(([f, n]) => `| canonical/${f} | ${n} |`).join("\n")}
| **total** | **${total}** (about ${(sizeBytes / 1024 / 1024).toFixed(2)} MB of CSV) |

Also: \`expected/cohort_outcome_metrics.csv\`, \`expected/cycle_metrics.csv\`, \`expected/sam_followup_questions.json\`, \`expected/validation_failures.json\`, \`mock_locator.json\`.

## Shape

- ${ORGS.length} orgs, 3 per persona. Persona 4 orgs have \`has_data_agreement = true\`.
- ${cycleRows.length} program cycle rows (${cycles.length} live cycles plus 1 superseded resubmission), 2022-01 to 2026-09, at ${facilitiesWithPrograms.length} of the 31 institutions: ${facilitiesWithPrograms.join(", ")}.
- Served by fewer than 3 orgs (facility-level suppression): ${facilitiesWithPrograms.filter((f) => orgsAt(f) < 3).map((f) => `${f} (${orgsAt(f)})`).join(", ")}.
- ${people.length} distinct people (persona 3 and 4 only). Persona 1 and 2 cycles are counts only.
- ${people.filter((p) => p.dup).length} people attend programs at two orgs (two \`person_identity\` rows, same CDCR number).
- ${noCdcrCount} persona 4 people have no CDCR number (\`org_id:org_internal_id\` refs). They are all still inside, because they cannot be looked up.

## Release cohorts (return to prison, TPW_ALL, post-program first release)

| Fiscal year | n_released | n_with_3yr | n_event_3yr | follow_up_complete | Public view |
|---|---|---|---|---|---|
${fyTable.join("\n")}

FY2021_22 and FY2022_23 have the full 3 years of follow-up. FY2023_24 to FY2025_26 are interim (checks run about every 90 days, so the newest people have less than 3 years).
There is no FY2020_21 cohort: programs start in 2022, so releases in FY2020_21 happen before participation (\`post_program = false\`).
Rates differ between cohorts partly by chance (about 150 people each). An interim cohort's naive \`rate_3yr\` is inflated because people with an early event count in \`n_with_3yr\` before most others do: read \`km_3yr_estimate\` for the projected rate.

## Planted cases

| Case | Where | Count |
|---|---|---|
| Released before the program, came back, released again (\`re_release\`) | \`release_event.csv\` \`post_program = false\` rows | ${releases.filter((r) => !r.post).length} |
| Returned and released again; only the first return counts | \`release_event.csv\` second \`re_release\` rows | ${releasedAgain.length} |
| First return after day 1,095, so excluded from 3-year rates | \`outcome_event.csv\` \`days_to_outcome > 1095\` | ${latePick.length} |
| Interval-precision returns (\`outcome_date_earliest\`) | \`outcome_event.csv\` | ${outcomes.filter((o) => o.precision === "interval").length} |
| Consent revoked | \`consent.csv\` \`revoked_date\` | ${people.filter((p) => p.revoked !== null).length} people |
| Declined follow-up | \`consent.csv\` \`consent_followup = false\` | ${people.filter((p) => !p.consentFollowup).length} people |
| Cancelled sessions (lockdown etc.) | \`session.csv\` | ${cycles.reduce((s, c) => s + c.sessions.filter((x) => x.cancelled).length, 0)} |
| Cycle with no completed count | persona 2 | ${missingComp.length} |
| Cycle with approximate-looking counts (30 enrolled, 22 finished) | \`${approx.id}\` | 1 |
| Cycle with no end date | persona 2 | ${cycles.filter((c) => c.flags.includes("end_date_missing")).length} |
| Program rule \`unstated\` | Riverbend Release Readiness Workshop | 1 |
| Cycles still running (end date in the future, no completed count) | ${IN_PROGRESS.length} cycles | ${IN_PROGRESS.length} |
| Cycles waiting for CBO confirmation (do not count yet) | status \`awaiting_confirmation\` | ${waiting.length} |
| Superseded resubmission | \`${superseded.id}\` | 1 |

Mock locator edge cases: name-only query with two matches (${pairA.first} ${pairA.last}), a person who returned and was released again (\`${returnedAgain.cdcr}\`, shows \`not_found\`), an error response (\`${errorPerson.cdcr}\`).
All three are released, consented people, so they appear on the lookups page.

## Choices where the contract was ambiguous

- Release rows are written only for people with follow-up consent (including those who later revoked). The Worker counts every \`post_program = 1\` release in \`n_released\` with no consent filter, and nobody may check a person who declined, so a declined person would block every cohort from \`follow_up_complete\`. Declined people have a consent row and \`custody_status = unknown\`.
- The cycle \`status\` enum has no \`in_progress\`, so a running cycle is \`confirmed\` with a future end date and no completed count.
- The approximate flags (\`n_enrolled_approx\` etc.) are filled by the loader, not the CSV. The approximate cycle just has round numbers; \`expected/cycle_metrics.csv\` flags it \`approximate_counts\`.
- Persona 3 attendance uses a shifted draw (completers 0.8 to 1.0, non-completers Beta(2,3)) instead of Beta(6,2), so an 80% rule gives about 65 to 70% completion. Completion follows the rule when it parses.
- Persona 3 birth dates are blank (an attendance sheet has none). \`age_band_raw\` keeps a coarse band and \`age_band_at_release\` is \`unknown\`.
- A returned person who was released again is \`not_found\` in the mock: they are out now. For every return still in custody the mock says \`in_custody\` with \`admission_date = outcome_date\`, including interval-precision returns (the number agrees; the real tool would not give that date).
- \`release_id\` and \`enrollment_id\` are opaque, so no identifier reaches the analytics database.
- \`outcome_source_mix\` is \`{}\` for a cohort with no events.
`;
writeFileSync(join(OUT, "README.md"), readme);

console.log(`people ${people.length}, cycles ${cycleRows.length}, rows ${total}`);
for (const [f, n] of counts) console.log(`  ${f}: ${n}`);
for (const { stat: s } of allCohort) console.log(`  ${s.fy}: n=${s.n} with3=${s.withN[2]} ev3=${s.ev[2]} complete=${s.complete} km=${s.km ? round(s.km.est, 3) : "-"}`);
