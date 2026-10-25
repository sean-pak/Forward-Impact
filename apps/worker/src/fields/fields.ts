import { NewFieldSchema, SUGGESTION_THRESHOLD, defaultAskTemplate, type NewField } from "@tpw/shared";

export type FieldRow = {
  field_key: string;
  label: string;
  type: string;
  options: string[] | null;
  required: boolean;
  ask_template: string;
  status: "active" | "retired" | "pending";
  is_core: boolean;
  /** For a pending field: how many uploads had a header like it. */
  seen_count: number | null;
};

export type FieldResult = { ok: true } | { ok: false; status: 400 | 404 | 409; error: string };

/** Every field in every status, core first, for the admin page. */
export async function listFields(db: D1Database): Promise<FieldRow[]> {
  const { results } = await db
    .prepare(
      `SELECT f.field_key, f.label, f.type, f.options, f.required, f.ask_template, f.status, f.is_core, s.seen_count
       FROM fields f LEFT JOIN field_suggestions s ON s.field_key = f.field_key
       ORDER BY f.is_core DESC, f.sort_order, f.field_key`,
    )
    .all<Omit<FieldRow, "options" | "required" | "is_core"> & { options: string | null; required: number; is_core: number }>();
  return results.map((r) => ({
    ...r, options: r.options ? (JSON.parse(r.options) as string[]) : null, required: r.required === 1, is_core: r.is_core === 1,
  }));
}

type Existing = { status: FieldRow["status"]; is_core: number } | null;
const existing = (db: D1Database, key: string) =>
  db.prepare("SELECT status, is_core FROM fields WHERE field_key = ?").bind(key).first<{ status: FieldRow["status"]; is_core: number }>();

/** Staff add a field. It is active at once, so the next email and the form both pick it up. */
export async function addField(db: D1Database, input: unknown): Promise<FieldResult & { field_key?: string }> {
  const parsed = NewFieldSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, error: parsed.error.issues[0]?.message ?? "Invalid field." };
  const f: NewField = parsed.data;
  const have: Existing = await existing(db, f.field_key);
  if (have) {
    const hint = have.status === "retired" ? "It was retired: reactivate it instead." : have.status === "pending" ? "It is waiting in the suggestions: approve it instead." : "It is already in use.";
    return { ok: false, status: 409, error: `A field with the key "${f.field_key}" exists. ${hint}` };
  }
  await db
    .prepare(
      `INSERT INTO fields (field_key, label, type, options, required, ask_template, status, is_core, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, 'active', 0, 100)`,
    )
    .bind(f.field_key, f.label, f.type, f.options ? JSON.stringify(f.options) : null, +f.required, f.ask_template)
    .run();
  return { ok: true, field_key: f.field_key };
}

/**
 * Moves a non-core field between statuses. Retiring leaves stored answers in `extra` alone; the field just stops being asked
 * and shown. Approve may set the type (and options) the pending suggestion could not know.
 */
async function move(db: D1Database, key: string, from: FieldRow["status"][], to: FieldRow["status"], what: string): Promise<FieldResult> {
  const have = await existing(db, key);
  if (!have) return { ok: false, status: 404, error: "No such field." };
  if (have.is_core) return { ok: false, status: 409, error: "Built-in fields cannot be changed here." };
  if (!from.includes(have.status)) return { ok: false, status: 409, error: `Only ${from.join(" or ")} fields can be ${what}; this one is ${have.status}.` };
  await db.prepare("UPDATE fields SET status = ? WHERE field_key = ? AND is_core = 0").bind(to, key).run();
  return { ok: true };
}

export const retireField = (db: D1Database, key: string) => move(db, key, ["active"], "retired", "retired");
export const reactivateField = (db: D1Database, key: string) => move(db, key, ["retired"], "active", "reactivated");

export async function approveField(db: D1Database, key: string, opts: { type?: string; options?: string[] } = {}): Promise<FieldResult> {
  const have = await existing(db, key);
  if (have?.status === "pending" && opts.type) {
    // Re-validate through the same schema, so a choice field still needs two options.
    const row = await db.prepare("SELECT label, ask_template, required FROM fields WHERE field_key = ?").bind(key).first<{ label: string; ask_template: string; required: number }>();
    const parsed = NewFieldSchema.safeParse({ label: row!.label, field_key: key, type: opts.type, options: opts.options, required: row!.required === 1, ask_template: row!.ask_template });
    if (!parsed.success) return { ok: false, status: 400, error: parsed.error.issues[0]?.message ?? "Invalid field." };
    await db.prepare("UPDATE fields SET type = ?, options = ? WHERE field_key = ?")
      .bind(parsed.data.type, parsed.data.options ? JSON.stringify(parsed.data.options) : null, key).run();
  }
  return move(db, key, ["pending"], "active", "approved");
}

/** Dismissing a suggestion retires it and remembers the choice, so the same header is never suggested again. */
export async function dismissField(db: D1Database, key: string): Promise<FieldResult> {
  const r = await move(db, key, ["pending"], "retired", "dismissed");
  if (r.ok) await db.prepare("UPDATE field_suggestions SET dismissed = 1 WHERE field_key = ?").bind(key).run();
  return r;
}

/**
 * Counts table headers that nothing used (headers only, never cell values). At the threshold a header becomes a `pending`
 * field. INSERT OR IGNORE: a key that already exists in any status, retired included, is never touched.
 */
export async function recordHeaderSightings(db: D1Database, headers: { key: string; label: string }[], now = new Date()): Promise<void> {
  if (headers.length === 0) return;
  const at = now.toISOString();
  for (const h of headers) {
    await db
      .prepare(
        `INSERT INTO field_suggestions (field_key, label, seen_count, last_seen) VALUES (?, ?, 1, ?)
         ON CONFLICT(field_key) DO UPDATE SET seen_count = seen_count + 1, last_seen = excluded.last_seen`,
      )
      .bind(h.key, h.label, at)
      .run();
    await db
      .prepare(
        `INSERT OR IGNORE INTO fields (field_key, label, type, options, required, ask_template, status, is_core, sort_order)
         SELECT field_key, label, 'text', NULL, 0, ?, 'pending', 0, 100 FROM field_suggestions
         WHERE field_key = ? AND seen_count >= ? AND dismissed = 0`,
      )
      .bind(defaultAskTemplate(h.label), h.key, SUGGESTION_THRESHOLD)
      .run();
  }
}
