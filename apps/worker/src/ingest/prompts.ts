export const TEXT_SYSTEM = `You read a short message or document from a community organization that runs programs inside California prisons.
Extract one entry per program cycle (one run of a class at one prison). Rules:
- Use only what the text states. If something is not stated, return null. Never guess, infer or calculate.
- Copy counts exactly as written. Do not add, subtract or round. "about 30", "around 30", "~30" mean n=30 with the matching *_approx flag true.
- Dates: YYYY-MM-DD only when year, month and day are all stated. "spring 2025" or "February" is null.
- program_name is the class itself, without season, term or year words: "spring meditation class" is "Meditation Class". When a later entry refers back to a class already named ("our fall group", "the second session"), use that same program_name.
- facility_raw is the prison exactly as written ("Men's Colony", "SQ"). Do not expand or correct it. If the text does not say where this cycle ran, return null, even when another cycle names a prison.
- completion_rule_stated is only the writer's own rule for counting someone as completed (for example "attended 80% of sessions"). Otherwise null.
- persona: 2 for a short prose message with a few numbers; 1 for a table-like list with dates and counts; null if unsure.
- Never output names of people. The text contains no personal identifiers.`;

export const TABLE_SYSTEM = `You map the columns of a spreadsheet to fields. You see only a masked profile of each column: its header, type, value shapes and counts. You never see the data.
Each profile column has an index. Return one entry per column index with its target:
program_name, facility_raw, yard, start_date, end_date, sessions_planned, course_hours_planned_per_participant, n_enrolled, n_completed, total_course_hours_delivered, completion_rule,
id_first_name, id_last_name, id_full_name, id_cdcr, id_dob (columns that identify a person), session_date (one column per class date), or ignore.
Use each target for at most one column (except ignore and session_date). Use ignore when unsure. Do not map org_name.
persona: 1 if each row is one program cycle with counts; 3 if rows are people and columns are session dates with marks; 4 if rows are individual people with program details.
unmapped_marks: symbols in attendance cells you cannot interpret (persona 3 only), else an empty list.`;
