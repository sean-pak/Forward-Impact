// Reads a directory laid out per docs/SEED_CONTRACT.md (Muse output or fixtures/seed) and builds the seed.
// The building itself lives in the Worker (apps/worker/src/vault/seedDataset.ts) so the demo reset can run it there.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VaultKeys } from "../../apps/worker/src/vault/crypto";
import { buildDataset, type Dataset, type SeedFiles } from "../../apps/worker/src/vault/seedDataset";

export type { Dataset, SeedFiles };

/** Muse writes to synthetic/canonical/; fixtures are flat. */
export function dataDir(dir: string): string {
  return existsSync(join(dir, "canonical")) ? join(dir, "canonical") : dir;
}

export function readSeedFiles(rootDir: string): SeedFiles {
  const dir = dataDir(rootDir);
  return Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".csv")).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
}

export async function loadDataset(rootDir: string, keys: VaultKeys): Promise<Dataset> {
  return buildDataset(readSeedFiles(rootDir), keys);
}
