// pnpm keys:generate            print fresh VAULT_HMAC_KEY / VAULT_ENC_KEY
// pnpm keys:generate --write    also append them to apps/worker/.dev.vars (refuses to overwrite existing keys)
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { DEV_VARS, parseDevVars } from "./keys";

const key = () => randomBytes(32).toString("base64");
const hmac = key();
const enc = key();

if (process.argv.includes("--write")) {
  const existing = existsSync(DEV_VARS) ? parseDevVars(readFileSync(DEV_VARS, "utf8")) : {};
  if (existing.VAULT_HMAC_KEY || existing.VAULT_ENC_KEY) {
    console.error("apps/worker/.dev.vars already has vault keys. Not overwriting: new keys would make every stored identity unreadable.");
    process.exit(1);
  }
  appendFileSync(DEV_VARS, `VAULT_HMAC_KEY=${hmac}\nVAULT_ENC_KEY=${enc}\n`);
  console.log("Wrote VAULT_HMAC_KEY and VAULT_ENC_KEY to apps/worker/.dev.vars (gitignored).");
  console.log("Deployed Worker needs the same two values:");
  console.log("  cd apps/worker && pnpm exec wrangler secret put VAULT_HMAC_KEY   (paste the value from .dev.vars)");
  console.log("  cd apps/worker && pnpm exec wrangler secret put VAULT_ENC_KEY");
} else {
  console.log(`VAULT_HMAC_KEY=${hmac}`);
  console.log(`VAULT_ENC_KEY=${enc}`);
  console.error("\nStore these in a password manager. Losing VAULT_ENC_KEY makes stored identities unreadable; changing VAULT_HMAC_KEY orphans every person_key.");
}
