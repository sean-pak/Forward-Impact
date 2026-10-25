import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Real SQLite behind the D1 interface, built from the real migrations. node:sqlite needs Node 22.13+.
export const sqlite = await import("node:sqlite").catch(() => null);
export const ROOT = join(__dirname, "../../../..");
export const FIXTURES = join(ROOT, "fixtures/ingest");

class Stmt {
  constructor(private db: import("node:sqlite").DatabaseSync, readonly sql: string, readonly params: unknown[] = []) {}
  bind(...p: unknown[]) { return new Stmt(this.db, this.sql, p); }
  async first<T>() { return (this.db.prepare(this.sql).get(...(this.params as never[])) ?? null) as T | null; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...(this.params as never[])) as T[] }; }
  async run() { const r = this.db.prepare(this.sql).run(...(this.params as never[])); return { meta: { changes: Number(r.changes) } }; }
}

/** A D1-shaped database over an in-memory SQLite, plus `q` for reading rows in tests. */
export function makeD1(kind: "analytics" | "vault") {
  const raw = new sqlite!.DatabaseSync(":memory:");
  const dir = join(ROOT, "apps/worker/migrations", kind);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) raw.exec(readFileSync(join(dir, f), "utf8"));
  const db = {
    prepare: (sql: string) => new Stmt(raw, sql),
    batch: async (list: Stmt[]) => {
      raw.exec("BEGIN");
      try { for (const s of list) await s.run(); raw.exec("COMMIT"); } catch (e) { raw.exec("ROLLBACK"); throw e; }
      return [];
    },
  } as unknown as D1Database;
  const q = (sql: string, ...p: unknown[]) => raw.prepare(sql).all(...(p as never[])) as Record<string, unknown>[];
  /** Every row of every table as one string, for "this value appears nowhere" checks. */
  const dump = () => {
    const tables = q("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((t) => t.name as string);
    return tables.map((t) => `${t}: ${JSON.stringify(q(`SELECT * FROM ${t}`))}`).join("\n");
  };
  return { db, q, raw, dump };
}

export const readFixture = (name: string) => readFileSync(join(FIXTURES, name));
export const readJson = (name: string) => JSON.parse(readFixture(name).toString("utf8"));
