// Plain D1 helpers for the demo reset. The vault's copy of these calls lives in vault/demo.ts.
const CHUNK = 40; // statements per D1 batch

/** Empties every table the migrations created. Table names come from sqlite_master, so nothing user-supplied is quoted in. */
export async function wipeTables(db: D1Database): Promise<number> {
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations'")
    .all<{ name: string }>();
  for (let i = 0; i < results.length; i += CHUNK) {
    await db.batch(results.slice(i, i + CHUNK).map((t) => db.prepare(`DELETE FROM "${t.name.replace(/"/g, '""')}"`)));
  }
  // AUTOINCREMENT counters, so ids start from 1 again. The table only exists when some table uses AUTOINCREMENT.
  await db.prepare("DELETE FROM sqlite_sequence").run().catch(() => undefined);
  return results.length;
}

/** Runs literal SQL statements in order, a chunk at a time. */
export async function runStatements(db: D1Database, statements: string[]): Promise<void> {
  for (let i = 0; i < statements.length; i += CHUNK) {
    await db.batch(statements.slice(i, i + CHUNK).map((s) => db.prepare(s)));
  }
}
