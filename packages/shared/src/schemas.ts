import { z } from "zod";

/** What the LLM may return for text and DOCX (PRD 7.2). Every field is required but nullable: null = not stated. */
export const ExtractedCycleSchema = z.object({
  program_name: z.string().nullable(),
  facility_raw: z.string().nullable().describe("The prison exactly as written, for example \"Men's Colony\""),
  yard: z.string().nullable(),
  start_date: z.string().nullable().describe("YYYY-MM-DD only when year, month and day are all stated, else null"),
  end_date: z.string().nullable().describe("YYYY-MM-DD only when year, month and day are all stated, else null"),
  sessions_planned: z.number().nullable(),
  course_hours_planned_per_participant: z.number().nullable(),
  n_enrolled: z.number().nullable(),
  n_completed: z.number().nullable(),
  total_course_hours_delivered: z.number().nullable(),
  n_enrolled_approx: z.boolean().describe("true when the writer said about / around / roughly / ~"),
  n_completed_approx: z.boolean(),
  total_course_hours_delivered_approx: z.boolean(),
  completion_rule_stated: z.string().nullable().describe("The rule for counting someone as completed, only if the writer states one"),
  evidence: z.string().nullable().describe("A short quote from the text that supports the counts"),
});
export type ExtractedCycle = z.infer<typeof ExtractedCycleSchema>;

export const ExtractionResultSchema = z.object({
  persona: z.number().int().min(1).max(4).nullable(),
  cycles: z.array(ExtractedCycleSchema).max(50),
});
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

/** Where a spreadsheet column goes. Identifier targets never get values from the LLM; code routes them. */
export const CANONICAL_TARGETS = [
  "program_name", "facility_raw", "yard", "start_date", "end_date", "sessions_planned",
  "course_hours_planned_per_participant", "n_enrolled", "n_completed", "total_course_hours_delivered", "completion_rule",
] as const;
export const IDENTIFIER_TARGETS = ["id_first_name", "id_last_name", "id_full_name", "id_cdcr", "id_dob"] as const;
export const ColumnTargetSchema = z.enum([...CANONICAL_TARGETS, ...IDENTIFIER_TARGETS, "session_date", "ignore"]);
export type ColumnTarget = z.infer<typeof ColumnTargetSchema>;

export const ColumnMappingSchema = z
  .object({
    persona: z.number().int().min(1).max(4),
    columns: z.array(z.object({ index: z.number().int().min(0), target: ColumnTargetSchema })).max(200),
    unmapped_marks: z.array(z.string()).max(20),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<number>();
    const targets = new Set<string>();
    for (const c of m.columns) {
      if (seen.has(c.index)) ctx.addIssue({ code: "custom", message: `column ${c.index} is mapped twice` });
      seen.add(c.index);
      if (c.target !== "ignore" && c.target !== "session_date" && targets.has(c.target)) {
        ctx.addIssue({ code: "custom", message: `target ${c.target} is used by more than one column` });
      }
      targets.add(c.target);
    }
  });
export type ColumnMapping = z.infer<typeof ColumnMappingSchema>;

/** What the LLM may return for a reply to Sam's question (PRD 7.5). Code validates and applies it. */
export const ReplyClassificationSchema = z.object({
  intent: z.enum(["confirm", "answer", "correction", "unclear"]),
  field_key: z.string().nullable().describe("The field the reply sets, for example n_completed. Null for confirm and unclear."),
  value: z.string().nullable().describe("The value exactly as the writer gave it, as text. Null when none was given."),
  approx: z.boolean().describe("true when the writer said about / around / roughly"),
  cycle_hint: z.string().nullable().describe("For a correction: the program name, prison or start date the writer is talking about, as written"),
  also: z
    .array(
      z.object({
        field_key: z.string(),
        value: z.string(),
        approx: z.boolean(),
        cycle_hint: z.string().nullable(),
      }),
    )
    .max(5)
    .describe("Other facts the same reply gives or changes, beyond the main one. Empty when there are none."),
  expected_numbers: z.boolean().describe("true when the reply gives an expected, hoped-for or projected number instead of a count"),
});
export type ReplyClassification = z.infer<typeof ReplyClassificationSchema>;
