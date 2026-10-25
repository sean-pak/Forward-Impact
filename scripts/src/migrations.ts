import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type TableInfo = { name: string; columns: string[] };

/** Read every .sql file in a migrations dir, in name order, as one string. */
export function readMigrations(dir: string): string {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

/** Tables and their column names from CREATE TABLE statements (enough for our own DDL). */
export function parseTables(sql: string): TableInfo[] {
  const noComments = sql.replace(/--.*$/gm, "");
  const tables: TableInfo[] = [];
  const re = /CREATE TABLE (\w+)\s*\(([\s\S]*?)\n\);/g;
  for (const m of noComments.matchAll(re)) {
    const columns: string[] = [];
    // split on commas that are not inside parentheses
    let depth = 0;
    let cur = "";
    const parts: string[] = [];
    for (const ch of m[2] ?? "") {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        parts.push(cur);
        cur = "";
      } else cur += ch;
    }
    parts.push(cur);
    for (const part of parts) {
      const first = part.trim().split(/\s+/)[0] ?? "";
      if (!first || ["PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "CONSTRAINT"].includes(first.toUpperCase())) continue;
      columns.push(first);
    }
    tables.push({ name: m[1] ?? "", columns });
  }
  return tables;
}

/** SQL that empties a database so migrations can run again from scratch. */
export function dropAllSql(tables: TableInfo[]): string {
  const drops = tables.map((t) => `DROP TABLE IF EXISTS ${t.name};`);
  return [...drops, "DROP TABLE IF EXISTS d1_migrations;"].join("\n") + "\n";
}
