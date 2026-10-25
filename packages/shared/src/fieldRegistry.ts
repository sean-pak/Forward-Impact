import { z } from "zod";
import { CORE_FIELDS } from "./staticSeed";
import { CANONICAL_TARGETS, IDENTIFIER_TARGETS, INDIVIDUAL_TARGETS } from "./schemas";
import type { RegistryField } from "./formCycle";

export const FIELD_TYPES = ["text", "integer", "number", "boolean", "date", "enum"] as const;

/** Keys a registry field may never take: the core fields, every spreadsheet target, and a few names Sam uses itself. */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  ...CORE_FIELDS.map((f) => f.field_key),
  ...CANONICAL_TARGETS, ...IDENTIFIER_TARGETS, ...INDIVIDUAL_TARGETS,
  "session_date", "ignore", "program_id", "program_name", "facility_raw", "duplicate_person", "attendance_legend", "late_counts",
]);

export const MAX_KEY_LENGTH = 40;

/** "RAC eligible?" -> "rac_eligible". Lowercase letters, digits and single underscores; null when nothing usable is left. */
export function slugFieldKey(label: string): string | null {
  const key = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, MAX_KEY_LENGTH).replace(/_+$/, "");
  return key || null;
}

/** Why a key cannot be used, or null when it can. Underscore keys belong to Sam (`_completion_rule`, `_approx_asked`). */
export function fieldKeyProblem(key: string): string | null {
  if (key.startsWith("_")) return "A field key cannot start with an underscore.";
  if (!/^[a-z][a-z0-9_]*$/.test(key) || key.length > MAX_KEY_LENGTH) {
    return `A field key starts with a letter and uses only lowercase letters, digits and underscores (at most ${MAX_KEY_LENGTH}).`;
  }
  if (RESERVED_KEYS.has(key)) return `"${key}" is already used by a built-in field.`;
  return null;
}

/** Only {program} and {facility} may appear in an ask template, so outbound text stays in code's hands. */
const PLACEHOLDER = /\{([^{}]*)\}/g;
export function askTemplateProblem(template: string): string | null {
  for (const m of template.matchAll(PLACEHOLDER)) {
    if (m[1] !== "program" && m[1] !== "facility") return `Unknown placeholder {${m[1]}}. Use {program} or {facility}.`;
  }
  const stripped = template.replace(PLACEHOLDER, "");
  if (/[{}]/.test(stripped)) return "Unbalanced braces in the question.";
  return null;
}

/** The question when staff give none: "For {program}: RAC eligible?" */
export function defaultAskTemplate(label: string): string {
  return `For {program}: ${label.trim().replace(/\?+$/, "").trim()}?`;
}

export const NewFieldSchema = z
  .object({
    label: z.string().trim().min(1, "A label is required.").max(80, "The label can be at most 80 characters."),
    field_key: z.string().trim().optional(),
    type: z.enum(FIELD_TYPES),
    options: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
    required: z.boolean().default(false),
    ask_template: z.string().trim().max(240, "The question can be at most 240 characters.").optional(),
  })
  .transform((v, ctx) => {
    const fail = (message: string, path: string) => (ctx.addIssue({ code: "custom", message, path: [path] }), z.NEVER);
    const field_key = v.field_key || slugFieldKey(v.label);
    if (!field_key) return fail("The label has no letters or digits to make a key from.", "label");
    const keyProblem = fieldKeyProblem(field_key);
    if (keyProblem) return fail(keyProblem, "field_key");
    let options: string[] | null = null;
    if (v.type === "enum") {
      options = [...new Set(v.options ?? [])];
      if (options.length < 2) return fail("A choice field needs at least two different options.", "options");
    }
    const ask_template = v.ask_template || defaultAskTemplate(v.label);
    const askProblem = askTemplateProblem(ask_template);
    if (askProblem) return fail(askProblem, "ask_template");
    return { field_key, label: v.label, type: v.type, options, required: v.required, ask_template };
  });
export type NewField = z.output<typeof NewFieldSchema>;

/** Fills {program} and {facility}. A missing prison reads "the prison" so the sentence still makes sense. */
export function fillAsk(template: string, ctx: { program: string; facility?: string | null }): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => (name === "program" ? ctx.program : name === "facility" ? (ctx.facility ?? "the prison") : whole));
}

/** The question about a registry field for one cycle, with a hint on how to answer a yes/no or a choice. */
export function registryQuestion(f: Pick<RegistryField, "label" | "type" | "options" | "ask_template">, ctx: { program: string; facility?: string | null }): string {
  const base = fillAsk(f.ask_template || defaultAskTemplate(f.label), ctx);
  if (f.type === "boolean") return `${base} Please reply YES or NO.`;
  if (f.type === "enum" && f.options?.length) return `${base} Please choose one of: ${f.options.join(", ")}.`;
  if (f.type === "date") return `${base} Please use year-month-day.`;
  return base;
}

/** Lowercase words only, so "RAC Eligible?", "rac_eligible" and " RAC  eligible " compare equal. */
export function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** The active field a spreadsheet header names (by label or key), if any. */
export function matchRegistryHeader(header: string, registry: Pick<RegistryField, "field_key" | "label">[]): string | null {
  const h = normalizeHeader(header);
  if (!h) return null;
  return registry.find((f) => normalizeHeader(f.label) === h || normalizeHeader(f.field_key) === h)?.field_key ?? null;
}

const IDENTIFIER_WORDS = new Set([
  "name", "names", "first", "last", "middle", "surname", "fullname", "cdcr", "dob", "birth", "birthday", "birthdate", "born",
  "ssn", "social", "email", "emails", "mail", "phone", "telephone", "mobile", "cell", "fax", "address", "street", "zip",
  "id", "ids", "inmate", "offender", "booking",
]);

/** Headers that could hold or ask for an identifier. These are never turned into a field suggestion. */
export function isIdentifierHeader(header: string): boolean {
  const h = normalizeHeader(header);
  if (!h) return true;
  if (/@|\d{4,}/.test(header)) return true;
  return h.split(" ").some((w) => IDENTIFIER_WORDS.has(w) || /^id\d*$/.test(w));
}

/**
 * The label to suggest for a spreadsheet header, or null when it is not suitable: blank, too long or too short,
 * identifier-like, or already a built-in key. Only the header is ever used here, never a cell value.
 */
export function suggestableHeader(header: string): { key: string; label: string } | null {
  const label = header.trim().replace(/\s+/g, " ");
  if (label.length < 2 || label.length > 60 || !/[a-z]/i.test(label) || isIdentifierHeader(label)) return null;
  const key = slugFieldKey(label);
  if (!key || fieldKeyProblem(key)) return null;
  return { key, label };
}

/** A suggestion becomes a pending field once headers like it have shown up this many times. */
export const SUGGESTION_THRESHOLD = 2;
