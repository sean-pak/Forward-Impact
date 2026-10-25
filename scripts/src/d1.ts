import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./keys";

export const worker = join(root, "apps/worker");
export const tmpDir = join(root, ".wrangler/db-reset");

export type Target = "--local" | "--remote";

/** Shared flag handling for the scripts that touch D1. */
export function parseTarget(args: Set<string>, what: string): Target {
  const remote = args.has("--remote");
  if (!remote && !args.has("--local")) {
    console.error("Pick a target: --local or --remote --yes");
    process.exit(1);
  }
  if (remote && !args.has("--yes")) {
    console.error(`--remote ${what}. Re-run with --yes to confirm.`);
    process.exit(1);
  }
  return remote ? "--remote" : "--local";
}

export function wrangler(...a: string[]) {
  execFileSync("pnpm", ["exec", "wrangler", ...a], { cwd: worker, stdio: "inherit" });
}

export function execFile(binding: "DB" | "VAULT", target: Target, name: string, sql: string) {
  mkdirSync(tmpDir, { recursive: true });
  const file = join(tmpDir, name);
  writeFileSync(file, sql);
  wrangler("d1", "execute", binding, target, `--file=${file}`);
}
