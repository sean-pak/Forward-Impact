import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDevVars } from "./keys";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules" || n === ".next") return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const rel = (p: string) => relative(root, p);

describe("vault boundary", () => {
  const worker = walk(join(root, "apps/worker/src")).filter((f) => f.endsWith(".ts") && !f.includes("/vault/") && !f.endsWith(".test.ts"));

  it("only apps/worker/src/vault/ touches the VAULT binding", () => {
    expect(worker.length).toBeGreaterThan(0);
    for (const f of worker) {
      // the Env type declares the binding; nothing else may name it
      const text = readFileSync(f, "utf8").replace(/^\s*VAULT: D1Database;\s*$/m, "");
      expect(text, rel(f)).not.toMatch(/\bVAULT\b/);
    }
  });

  it("only the vault reads the vault keys", () => {
    for (const f of worker) {
      const text = readFileSync(f, "utf8").replace(/^\s*VAULT_(HMAC|ENC)_KEY: string;\s*$/gm, "");
      expect(text, rel(f)).not.toMatch(/VAULT_(HMAC|ENC)_KEY/);
    }
  });

  it("the web app has no database or vault access at all", () => {
    for (const f of walk(join(root, "apps/web")).filter((p) => /\.(ts|tsx)$/.test(p) && !p.includes("/.next/"))) {
      const text = readFileSync(f, "utf8");
      expect(text, rel(f)).not.toMatch(/VAULT_|\bVAULT\b|D1Database/);
    }
  });

  it("the person_identity table is only named inside vault/", () => {
    for (const f of worker) expect(readFileSync(f, "utf8"), rel(f)).not.toMatch(/person_identity|vault_access_log|locator_raw/);
  });
});

describe("parseDevVars", () => {
  it("reads KEY=VALUE lines, quotes, and skips comments", () => {
    expect(parseDevVars("# c\nA=1\nB=\"two\"\n  C = three \nlower=x\n")).toEqual({ A: "1", B: "two", C: "three" });
  });
});
