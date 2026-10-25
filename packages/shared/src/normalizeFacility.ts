import { FACILITIES } from "./facilities";

/** Lowercase, drop apostrophes and periods, turn everything else non-alphanumeric into a space. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’`.]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// normalized text -> set of codes it could mean
const LOOKUP: Map<string, Set<string>> = (() => {
  const m = new Map<string, Set<string>>();
  const add = (text: string, code: string) => {
    const key = norm(text);
    if (!key) return;
    const set = m.get(key) ?? new Set<string>();
    set.add(code);
    m.set(key, set);
  };
  for (const f of FACILITIES) {
    add(f.facility_code, f.facility_code);
    add(f.facility_name, f.facility_code);
    for (const a of f.aliases) add(a, f.facility_code);
  }
  return m;
})();

/**
 * Map raw facility text ("Men's Colony", "S.Q.", "san quentin") to a facility code.
 * Returns null when nothing matches or the text could mean more than one prison;
 * the caller flags that as `ambiguous_mapping` and asks. Never guesses.
 */
export function normalizeFacility(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const hit = LOOKUP.get(norm(raw));
  if (!hit || hit.size !== 1) return null;
  return [...hit][0] ?? null;
}
