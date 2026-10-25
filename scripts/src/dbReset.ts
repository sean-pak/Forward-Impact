// pnpm db:reset --local            drop, migrate, seed the local D1 (safe)
// pnpm db:reset --remote --yes     same against the deployed D1 databases (destroys data, vault included)
// Needs Node 22+ (wrangler). Add --no-seed to stop after migrating.
// Seeds fixtures/seed by default; --data <dir> seeds that directory instead (for example ./synthetic).
// Seeding needs VAULT_HMAC_KEY / VAULT_ENC_KEY (environment or apps/worker/.dev.vars).
import { join, resolve } from "node:path";
import { execFile, parseTarget, worker, wrangler } from "./d1";
import { loadDataset } from "./dataset";
import { loadScriptKeys, root } from "./keys";
import { dropAllSql, parseTables, readMigrations } from "./migrations";
import { staticSeedSql } from "./seedSql";

const argv = process.argv.slice(2);
const args = new Set(argv);
const dataFlag = argv.indexOf("--data");
const dataDir = dataFlag >= 0 ? resolve(process.env.INIT_CWD ?? process.cwd(), argv[dataFlag + 1] ?? "") : join(root, "fixtures/seed");

const target = parseTarget(args, "drops every table in tpw_analytics AND tpw_vault (identities included)");

// Validate and encrypt the seed data before dropping anything: a bad file must not leave an empty database.
const data = args.has("--no-seed") ? null : await loadDataset(dataDir, await loadScriptKeys());

for (const [binding, dir] of [["DB", "analytics"], ["VAULT", "vault"]] as const) {
  const migrationsDir = join(worker, "migrations", dir);
  console.log(`\n== ${binding}: drop ==`);
  execFile(binding, target, `drop_${dir}.sql`, dropAllSql(parseTables(readMigrations(migrationsDir))));
  console.log(`== ${binding}: migrate ==`);
  wrangler("d1", "migrations", "apply", binding, target);
}

if (data) {
  console.log("\n== VAULT: seed identities (ciphertext) ==");
  if (data.vaultSql) execFile("VAULT", target, "seed_vault.sql", data.vaultSql);
  console.log("== DB: seed (static + dataset) ==");
  execFile("DB", target, "seed.sql", staticSeedSql() + data.analyticsSql);
  console.log(`Seeded ${dataDir}: ${JSON.stringify(data.counts)}`);
}
