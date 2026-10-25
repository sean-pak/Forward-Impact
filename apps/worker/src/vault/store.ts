// The only file that talks to the VAULT binding (with index.ts re-exporting it).
import { decryptField, importVaultKeys, type VaultKeys } from "./crypto";
import { buildIdentityRow, identityParams, UPSERT_IDENTITY_SQL, type IdentityInput } from "./identity";
import type { PersonKeyBasis } from "./personKey";

export type VaultEnv = {
  VAULT: D1Database;
  VAULT_HMAC_KEY: string;
  VAULT_ENC_KEY: string;
};

/** Who may ask for plaintext, and why. Every value is written to vault_access_log. */
export type ReidentifyPurpose = "org_report" | "locator_check" | "admin_vault_view" | "self_check";

export type Identity = {
  personKey: string;
  basis: PersonKeyBasis;
  cdcrNumber: string | null;
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: string | null;
  /** { org_id: that org's own id for the person }, "" when the org gave none. */
  orgInternalIds: Record<string, string>;
  isSynthetic: boolean;
};

type Row = {
  person_key: string;
  person_key_basis: PersonKeyBasis;
  cdcr_enc: string | null;
  first_enc: string | null;
  last_enc: string | null;
  dob_enc: string | null;
  org_ids: string;
  is_synthetic: number;
};

const CHUNK = 50; // D1 allows 100 bound parameters per statement

export class Vault {
  constructor(private db: D1Database, private keys: VaultKeys) {}

  /** Encrypts and stores one person. Returns only the key, never the plaintext. */
  async upsertIdentity(input: IdentityInput): Promise<{ personKey: string; basis: PersonKeyBasis }> {
    const row = await buildIdentityRow(this.keys, input);
    await this.db.prepare(UPSERT_IDENTITY_SQL).bind(...identityParams(row)).run();
    return { personKey: row.person_key, basis: row.person_key_basis };
  }

  /**
   * Plaintext comes out only here. The access log row is written first; if that fails,
   * nothing is decrypted. With `orgId`, only people that org reported are returned.
   */
  async reidentify(
    personKeys: string[],
    opts: { purpose: ReidentifyPurpose; actor: string; orgId?: string },
  ): Promise<Identity[]> {
    const unique = [...new Set(personKeys)];
    await this.db
      .prepare("INSERT INTO vault_access_log (actor, purpose, org_id, n_person_keys) VALUES (?, ?, ?, ?)")
      .bind(opts.actor, opts.purpose, opts.orgId ?? null, unique.length)
      .run();

    const out: Identity[] = [];
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK);
      const { results } = await this.db
        .prepare(`SELECT * FROM person_identity WHERE person_key IN (${chunk.map(() => "?").join(",")})`)
        .bind(...chunk)
        .all<Row>();
      for (const r of results) {
        const orgIds = JSON.parse(r.org_ids) as Record<string, string>;
        if (opts.orgId !== undefined && !(opts.orgId in orgIds)) continue;
        const get = (blob: string | null, field: string) => (blob === null ? Promise.resolve(null) : decryptField(this.keys, blob, `${r.person_key}:${field}`));
        const [cdcr, first, last, dob] = await Promise.all([
          get(r.cdcr_enc, "cdcr"),
          get(r.first_enc, "first"),
          get(r.last_enc, "last"),
          get(r.dob_enc, "dob"),
        ]);
        out.push({
          personKey: r.person_key,
          basis: r.person_key_basis,
          cdcrNumber: cdcr,
          firstName: first,
          lastName: last,
          dateOfBirth: dob,
          orgInternalIds: orgIds,
          isSynthetic: r.is_synthetic === 1,
        });
      }
    }
    return out;
  }

  /** Counts plus proof the keys can decrypt a stored row. Never returns plaintext. */
  async status(): Promise<{ identities: number; synthetic: number; can_decrypt: boolean | null }> {
    const counts = await this.db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(is_synthetic), 0) AS syn FROM person_identity")
      .first<{ n: number; syn: number }>();
    const sample = await this.db.prepare("SELECT person_key FROM person_identity LIMIT 1").first<{ person_key: string }>();
    let can: boolean | null = null;
    if (sample) {
      try {
        can = (await this.reidentify([sample.person_key], { purpose: "self_check", actor: "system" })).length === 1;
      } catch {
        can = false;
      }
    }
    return { identities: counts?.n ?? 0, synthetic: counts?.syn ?? 0, can_decrypt: can };
  }
}

export async function createVault(env: VaultEnv): Promise<Vault> {
  return new Vault(env.VAULT, await importVaultKeys(env.VAULT_HMAC_KEY, env.VAULT_ENC_KEY));
}

export async function pingVault(env: Pick<VaultEnv, "VAULT">): Promise<boolean> {
  try {
    await env.VAULT.prepare("SELECT 1").first();
    return true;
  } catch {
    return false;
  }
}
