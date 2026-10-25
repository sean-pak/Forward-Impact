/** A completion rule Sam can apply to attendance counts. Anything else stays text for the CBO's own wording. */
export type CompletionRule = { kind: "pct"; min: number } | { kind: "count"; min: number };

/**
 * "attended at least 80% of sessions", "attendance >= 80%", "all sessions", "at least 10 sessions".
 * Returns null for any other wording: Sam never guesses what a rule means.
 */
export function parseCompletionRule(text: string): CompletionRule | null {
  const t = text.toLowerCase();
  const pct = /(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)/.exec(t);
  if (pct) {
    const n = Number(pct[1]);
    return n > 0 && n <= 100 ? { kind: "pct", min: n / 100 } : null;
  }
  if (/\b(?:all|every|each)\b[^.]*\bsessions?\b|\bperfect attendance\b/.test(t)) return { kind: "pct", min: 1 };
  const count = /(?:at least|minimum of|no fewer than)\s*(\d+)\s*(?:or more\s*)?sessions?|(\d+)\s*(?:or more|\+)\s*sessions?/.exec(t);
  if (count) {
    const n = Number(count[1] ?? count[2]);
    return n > 0 ? { kind: "count", min: n } : null;
  }
  return null;
}

/** True when the person met the rule. `planned` excludes cancelled sessions. */
export function ruleMet(rule: CompletionRule, attended: number, planned: number): boolean {
  if (rule.kind === "count") return attended >= rule.min;
  return planned > 0 && attended / planned >= rule.min - 1e-9;
}

/**
 * A completion rule written in the notes rows above a sheet ("Completion = attended at least 80% of sessions").
 * Returned as standard wording built by code, never the sheet's own sentence, which could hold a name.
 */
export function ruleFromNotes(lines: string[]): string | null {
  for (const line of lines) {
    for (const sentence of line.split(/(?<=[.;!?])\s+|\n/)) {
      if (!/complet|graduat|certificate/i.test(sentence)) continue;
      const rule = parseCompletionRule(sentence);
      if (!rule) continue;
      return rule.kind === "count" ? `attended at least ${rule.min} sessions` : rule.min === 1 ? "attended all sessions" : `attended at least ${Math.round(rule.min * 1000) / 10}% of sessions`;
    }
  }
  return null;
}
