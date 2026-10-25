// pnpm db:reset --local            drop, migrate, seed the local D1 (safe)
// pnpm db:reset --remote --yes     same against the deployed D1 databases (destroys data, vault included)
// Needs Node 22+ (wrangler). Add --no-seed to stop after migrating.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dropAllSql, parseTables, readMigrations } from "./migrations";
import { fixtureSeedSql, staticSeedSql } from "./seedSql";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const worker = join(root, "apps/worker");
const args = new Set(process.argv.slice(2));

const remote = args.has("--remote");
if (!remote && !args.has("--local")) {
  console.error("Pick a target: --local or --remote --yes");
  process.exit(1);
}
if (remote && !args.has("--yes")) {
  console.error("--remote drops every table in tpw_analytics AND tpw_vault (identities included). Re-run with --yes to confirm.");
  process.exit(1);
}
const target = remote ? "--remote" : "--local";

const tmp = join(root, ".wrangler/db-reset");
mkdirSync(tmp, { recursive: true });

function wrangler(...a: string[]) {
  execFileSync("pnpm", ["exec", "wrangler", ...a], { cwd: worker, stdio: "inherit" });
}
function exec(binding: "DB" | "VAULT", file: string) {
  wrangler("d1", "execute", binding, target, `--file=${file}`);
}

for (const [binding, dir] of [["DB", "analytics"], ["VAULT", "vault"]] as const) {
  const migrationsDir = join(worker, "migrations", dir);
  const dropFile = join(tmp, `drop_${dir}.sql`);
  writeFileSync(dropFile, dropAllSql(parseTables(readMigrations(migrationsDir))));
  console.log(`\n== ${binding}: drop ==`);
  exec(binding, dropFile);
  console.log(`== ${binding}: migrate ==`);
  wrangler("d1", "migrations", "apply", binding, target);
}

if (!args.has("--no-seed")) {
  const fx = fixtureSeedSql(join(root, "fixtures/seed"));
  const seedFile = join(tmp, "seed.sql");
  writeFileSync(seedFile, staticSeedSql() + fx.sql);
  console.log("\n== DB: seed (static + fixtures) ==");
  exec("DB", seedFile);
  console.log(`Seeded fixtures: ${JSON.stringify(fx.counts)}. Skipped ${fx.skippedIdentities} fixture identities (vault arrives in phase 2).`);
}
