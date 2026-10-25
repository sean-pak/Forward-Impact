import { encryptField, type VaultKeys } from "./crypto";
import { normalizeCdcr } from "./normalize";
import { personKey, type PersonKeyBasis, type PersonKeyInput } from "./personKey";

/** Plaintext in. `isSynthetic` is always stated by the caller, never guessed. */
export type IdentityInput = PersonKeyInput & { isSynthetic: boolean };

/** What goes into tpw_vault.person_identity: ciphertext and the org-scoped id map only. */
export type IdentityRow = {
  person_key: string;
  person_key_basis: PersonKeyBasis;
  cdcr_enc: string | null;
  first_enc: string | null;
  last_enc: string | null;
  dob_enc: string | null;
  org_ids: string; // JSON { org_id: org internal id or "" }
  is_synthetic: number;
};

const clean = (v: string | null | undefined) => (v == null || v.trim() === "" ? null : v.trim());

export async function buildIdentityRow(keys: VaultKeys, input: IdentityInput): Promise<IdentityRow> {
  const { personKey: pk, basis } = await personKey(keys, input);
  const field = async (name: string, value: string | null) => (value === null ? null : encryptField(keys, value, `${pk}:${name}`));
  const cdcr = clean(input.cdcrNumber);
  return {
    person_key: pk,
    person_key_basis: basis,
    cdcr_enc: await field("cdcr", cdcr === null ? null : normalizeCdcr(cdcr)),
    first_enc: await field("first", clean(input.firstName)),
    last_enc: await field("last", clean(input.lastName)),
    dob_enc: await field("dob", clean(input.dateOfBirth)),
    org_ids: JSON.stringify({ [input.orgId]: clean(input.orgInternalId) ?? "" }),
    is_synthetic: input.isSynthetic ? 1 : 0,
  };
}

/**
 * One statement for the Worker (bound params) and the seed scripts (params rendered as literals).
 * A person seen again keeps the first-written ciphertext, gains the new org in org_ids, and
 * stays synthetic only if every sighting was synthetic.
 */
export const UPSERT_IDENTITY_SQL = `INSERT INTO person_identity
  (person_key, person_key_basis, cdcr_enc, first_enc, last_enc, dob_enc, org_ids, is_synthetic)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (person_key) DO UPDATE SET
  cdcr_enc = COALESCE(person_identity.cdcr_enc, excluded.cdcr_enc),
  first_enc = COALESCE(person_identity.first_enc, excluded.first_enc),
  last_enc = COALESCE(person_identity.last_enc, excluded.last_enc),
  dob_enc = COALESCE(person_identity.dob_enc, excluded.dob_enc),
  org_ids = json_patch(person_identity.org_ids, excluded.org_ids),
  is_synthetic = MIN(person_identity.is_synthetic, excluded.is_synthetic)`;

export function identityParams(r: IdentityRow): (string | number | null)[] {
  return [r.person_key, r.person_key_basis, r.cdcr_enc, r.first_enc, r.last_enc, r.dob_enc, r.org_ids, r.is_synthetic];
}
