import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { parseCsv } from "../../apps/worker/src/demo/seedSql";

// The SQL builders live in the Worker (the demo reset runs there); the scripts add only file access.
export { bindLiterals, insert, lit, parseCsv, staticSeedSql } from "../../apps/worker/src/demo/seedSql";

export function csvExists(dir: string, file: string): boolean {
  return existsSync(join(dir, file));
}

/** Parse a CSV file and validate every row; one bad row refuses the whole file. */
export function readCsv<S extends z.ZodTypeAny>(dir: string, file: string, schema: S): z.infer<S>[] {
  return parseCsv(file, readFileSync(join(dir, file), "utf8"), schema);
}
