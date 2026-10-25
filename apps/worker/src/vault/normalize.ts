/** CDCR numbers: uppercase, no spaces, no dashes. "ab-123 45" -> "AB12345". */
export function normalizeCdcr(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, "");
}

/** Names for keying only: no accents or punctuation, uppercase, single spaces. */
export function normalizeName(first: string | null | undefined, last: string | null | undefined): string {
  return `${first ?? ""} ${last ?? ""}`
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Org-internal ids: trimmed and uppercased so "d-0003 " and "D-0003" are the same person. */
export function normalizeInternalId(raw: string): string {
  return raw.trim().toUpperCase();
}
