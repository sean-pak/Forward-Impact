// pnpm seed:muse ./synthetic --local            load Muse CSVs into an already migrated local D1
// pnpm seed:muse ./synthetic --remote --yes     same against the deployed databases
// Adds to what is there. For a clean slate use: pnpm db:reset --local --data ./synthetic
// Needs VAULT_HMAC_KEY / VAULT_ENC_KEY (environment or apps/worker/.dev.vars): the same two the Worker holds.
import { resolve } from "node:path";
import { execFile, parseTarget } from "./d1";
import { loadDataset } from "./dataset";
import { loadScriptKeys } from "./keys";

const argv = process.argv.slice(2);
const dir = argv.find((a) => !a.startsWith("--"));
if (!dir) {
  console.error("Usage: pnpm seed:muse <dir> --local | --remote --yes");
  process.exit(1);
}
const target = parseTarget(new Set(argv), "writes to the deployed tpw_analytics and tpw_vault");

const data = await loadDataset(resolve(dir), await loadScriptKeys());
console.log(`Validated ${dir}: ${JSON.stringify(data.counts)}`);
if (!data.vaultSql) console.warn("No person_identity.csv rows: nothing goes to the vault.");
else execFile("VAULT", target, "seed_vault.sql", data.vaultSql);
execFile("DB", target, "seed_muse.sql", data.analyticsSql);
console.log("Done. Verify with a raw SELECT (see docs/PROGRESS.md for the queries).");
