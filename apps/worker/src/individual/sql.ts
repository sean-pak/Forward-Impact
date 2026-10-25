const NAME = /^[a-z_]+$/;

/**
 * Inserts many rows with few statements: one bound JSON array per statement (D1 limits bound parameters and
 * queries per request). Table and column names are code constants, checked here so nothing else can reach the SQL.
 */
export function bulkInsert(db: D1Database, table: string, columns: readonly string[], rows: unknown[][], size = 400): D1PreparedStatement[] {
  if (!NAME.test(table) || !columns.every((c) => NAME.test(c))) throw new Error("bad table or column name");
  const select = columns.map((_, i) => `json_extract(value,'$[${i}]')`).join(", ");
  const sql = `INSERT INTO ${table} (${columns.join(", ")}) SELECT ${select} FROM json_each(?)`;
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += size) out.push(db.prepare(sql).bind(JSON.stringify(rows.slice(i, i + size))));
  return out;
}
