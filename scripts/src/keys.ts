import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importVaultKeys, type VaultKeys } from "../../apps/worker/src/vault/crypto";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEV_VARS = join(root, "apps/worker/.dev.vars");

/** Minimal KEY=VALUE parser for .dev.vars (no export, optional quotes, # comments). */
export function parseDevVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trimStart().startsWith("#")) continue;
    out[m[1] as string] = (m[2] as string).replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/**
 * The same two secrets the Worker holds. Environment first, then apps/worker/.dev.vars
 * (gitignored). The seed scripts need them because only the vault code can scramble.
 */
export async function loadScriptKeys(): Promise<VaultKeys> {
  const file = existsSync(DEV_VARS) ? parseDevVars(readFileSync(DEV_VARS, "utf8")) : {};
  const hmac = process.env.VAULT_HMAC_KEY ?? file.VAULT_HMAC_KEY;
  const enc = process.env.VAULT_ENC_KEY ?? file.VAULT_ENC_KEY;
  if (!hmac || !enc) {
    throw new Error("VAULT_HMAC_KEY / VAULT_ENC_KEY not found in the environment or apps/worker/.dev.vars. Run: pnpm keys:generate --write");
  }
  return importVaultKeys(hmac, enc);
}
