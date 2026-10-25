import { hmacHex, type VaultKeys } from "./crypto";
import { normalizeCdcr, normalizeInternalId, normalizeName } from "./normalize";

export type PersonKeyBasis = "cdcr_number" | "org_internal_id" | "org_name";

export type PersonKeyInput = {
  cdcrNumber?: string | null;
  orgId: string;
  orgInternalId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  dateOfBirth?: string | null; // YYYY-MM-DD
};

const blank = (v: string | null | undefined): v is null | undefined => v == null || v.trim() === "";

/**
 * person_key = "pk_" + first 16 hex of HMAC-SHA256(VAULT_HMAC_KEY, message). PRD section 6.
 * Best basis wins: CDCR number (same person across orgs), else the org's own id, else org + name + DOB.
 * The last two cannot be matched across orgs, so the basis is stored and surfaced.
 */
export async function personKey(keys: VaultKeys, p: PersonKeyInput): Promise<{ personKey: string; basis: PersonKeyBasis }> {
  let basis: PersonKeyBasis;
  let message: string;
  if (!blank(p.cdcrNumber)) {
    basis = "cdcr_number";
    message = `cdcr:${normalizeCdcr(p.cdcrNumber)}`;
  } else if (!blank(p.orgInternalId)) {
    basis = "org_internal_id";
    message = `org:${p.orgId}:${normalizeInternalId(p.orgInternalId)}`;
  } else {
    const name = normalizeName(p.firstName, p.lastName);
    if (!name) throw new Error("cannot make a person_key without a CDCR number, an org internal id, or a name");
    basis = "org_name";
    message = `name:${p.orgId}:${name}:${p.dateOfBirth?.trim() ?? ""}`;
  }
  return { personKey: "pk_" + (await hmacHex(keys, message)).slice(0, 16), basis };
}
