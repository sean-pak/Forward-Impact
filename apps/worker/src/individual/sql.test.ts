import { describe, expect, it } from "vitest";
import { bulkInsert } from "./sql";

function fakeD1() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = { prepare: (sql: string) => ({ bind: (...params: unknown[]) => (calls.push({ sql, params }), { sql, params }) }) } as unknown as D1Database;
  return { db, calls };
}

describe("bulkInsert", () => {
  it("sends rows as one JSON parameter per statement and splits large inserts", () => {
    const { db, calls } = fakeD1();
    const rows = Array.from({ length: 5 }, (_, i) => [`s${i}`, i]);
    expect(bulkInsert(db, "sessions", ["session_id", "cancelled"], rows, 2)).toHaveLength(3);
    expect(calls[0]!.sql).toBe("INSERT INTO sessions (session_id, cancelled) SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]') FROM json_each(?)");
    expect(JSON.parse(calls[2]!.params[0] as string)).toEqual([["s4", 4]]);
  });
  it("sends nothing for no rows", () => {
    expect(bulkInsert(fakeD1().db, "sessions", ["session_id"], [])).toEqual([]);
  });
  it("refuses a table or column name that is not a plain identifier", () => {
    expect(() => bulkInsert(fakeD1().db, "sessions; DROP TABLE x", ["a"], [[1]])).toThrow();
    expect(() => bulkInsert(fakeD1().db, "sessions", ["a) --"], [[1]])).toThrow();
  });
});
