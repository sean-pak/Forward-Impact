import { importContacts } from "../outreach";
import { staticSeedStatements } from "./seedSql";
import { runStatements, wipeTables } from "./db";
import { buildDataset, type SeedFiles } from "../vault/seedDataset";
import { DEMO_FILES, demoVaultKeys, replaceVault } from "../vault/demo";
import type { VaultEnv } from "../vault";
import { ConfigError } from "../config";

export type DemoEnv = VaultEnv & {
  DB: D1Database;
  /** Must be exactly "true". Reset deletes everything, the vault's audit log included. */
  DEMO_MODE?: string;
  /** The test inbox that plays the CBO. Becomes the only real org, with this address as its contact. */
  DEMO_CBO_EMAIL?: string;
  DEMO_CBO_ORG?: string;
  /** Comma-separated program names the CBO org already runs (no cycles), so a sheet naming one is recognized. */
  DEMO_CBO_PROGRAMS?: string;
};

export type ResetResult =
  | { ok: true; counts: Record<string, number>; cbo: { org_name: string; email: string } | null; tables_wiped: number }
  | { ok: false; status: 403 | 500; error: string };

/**
 * Puts both databases back to the demo's starting state: static reference data, the bundled synthetic dataset
 * (`pnpm demo:bundle` writes it), and the CBO test org with its inbox as the contact and its known programs. Nothing is dropped until the
 * dataset has been built and validated, so a bad bundle or a malformed key leaves the data alone.
 */
export async function resetDemo(env: DemoEnv, files: SeedFiles = DEMO_FILES): Promise<ResetResult> {
  if (env.DEMO_MODE !== "true") {
    return { ok: false, status: 403, error: 'Demo reset is off. Set DEMO_MODE to "true" in wrangler.toml and deploy the Worker.' };
  }
  let data;
  try {
    data = await buildDataset(files, await demoVaultKeys(env));
  } catch (e) {
    const why = e instanceof ConfigError ? "a vault secret is malformed" : "the demo dataset is invalid";
    return { ok: false, status: 500, error: `Nothing was changed: ${why}. ${e instanceof Error ? e.message.slice(0, 200) : ""}`.trim() };
  }
  try {
    const wiped = await wipeTables(env.DB);
    await replaceVault(env, data.vault);
    await runStatements(env.DB, [...staticSeedStatements(), ...data.analytics]);
    const email = env.DEMO_CBO_EMAIL?.trim().toLowerCase();
    const orgName = env.DEMO_CBO_ORG?.trim() || "Demo CBO";
    if (email) {
      const imported = await importContacts(env.DB, `org,name,email,title\n"${orgName.replace(/"/g, '""')}",Demo Contact,${email},Program Director\n`);
      if (imported.rejected.length) throw new Error(`the CBO test contact was rejected: ${imported.rejected[0]!.reason}`);
      const org = await env.DB.prepare("SELECT org_id FROM orgs WHERE lower(org_name) = lower(?)").bind(orgName).first<{ org_id: string }>();
      const programs = (env.DEMO_CBO_PROGRAMS ?? "").split(",").map((p) => p.trim()).filter(Boolean);
      if (org && programs.length) {
        await env.DB.batch(
          programs.map((name, i) =>
            env.DB.prepare("INSERT INTO programs (program_id, org_id, program_name, is_synthetic) VALUES (?, ?, ?, 0)").bind(`prog_demo_${i + 1}`, org.org_id, name),
          ),
        );
      }
    }
    return { ok: true, counts: data.counts, cbo: email ? { org_name: orgName, email } : null, tables_wiped: wiped };
  } catch (e) {
    return { ok: false, status: 500, error: `Reset stopped part way (${e instanceof Error ? e.message.slice(0, 200) : "unknown"}). Run it again.` };
  }
}
