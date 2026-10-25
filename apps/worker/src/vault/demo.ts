// Demo reset support. Lives in vault/ because it empties and refills the VAULT binding and reads the vault keys.
import { wipeTables, runStatements } from "../demo/db";
// The bundled seed files include the synthetic identities in plaintext, so they live here with the code that scrambles them.
export { DEMO_FILES } from "./demoBundle.generated";
import { importVaultKeys, type VaultKeys } from "./crypto";
import type { VaultEnv } from "./store";

/** The keys the seed identities are scrambled with. Throws ConfigError when a secret is malformed. */
export function demoVaultKeys(env: VaultEnv): Promise<VaultKeys> {
  return importVaultKeys(env.VAULT_HMAC_KEY, env.VAULT_ENC_KEY);
}

/**
 * Replaces everything in the vault with the given ciphertext statements. The access log goes with it, so this is only
 * for the demo (the route that calls it refuses unless DEMO_MODE is "true").
 */
export async function replaceVault(env: VaultEnv, statements: string[]): Promise<number> {
  await wipeTables(env.VAULT);
  await runStatements(env.VAULT, statements);
  return statements.length;
}
