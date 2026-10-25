// WebCrypto only. HMAC-SHA256 for person keys, AES-256-GCM for identifier fields.
// Nothing in here logs, and no error message includes key material or plaintext.

export type VaultKeys = { hmac: CryptoKey; aes: CryptoKey };

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function decodeKey(name: string, b64: string | undefined, exactly?: number): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64((b64 ?? "").trim());
  } catch {
    throw new Error(`${name} must be base64 (run pnpm keys:generate)`);
  }
  const ok = exactly ? bytes.length === exactly : bytes.length >= 32;
  if (!ok) throw new Error(`${name} must be base64 of ${exactly ? "exactly" : "at least"} 32 bytes (run pnpm keys:generate)`);
  return bytes;
}

/** `VAULT_HMAC_KEY` and `VAULT_ENC_KEY` are base64 of 32 random bytes each, and must differ. */
export async function importVaultKeys(hmacB64: string | undefined, encB64: string | undefined): Promise<VaultKeys> {
  const hmacBytes = decodeKey("VAULT_HMAC_KEY", hmacB64);
  const aesBytes = decodeKey("VAULT_ENC_KEY", encB64, 32);
  if (toBase64(hmacBytes) === toBase64(aesBytes)) throw new Error("VAULT_HMAC_KEY and VAULT_ENC_KEY must be different keys");
  const [hmac, aes] = await Promise.all([
    crypto.subtle.importKey("raw", hmacBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    crypto.subtle.importKey("raw", aesBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
  ]);
  return { hmac, aes };
}

export async function hmacHex(keys: VaultKeys, message: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", keys.hmac, enc.encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * AES-256-GCM with a fresh random 12-byte IV. Output is base64(iv | ciphertext+tag).
 * `aad` binds the ciphertext to its place (person_key + field), so a blob copied into
 * another row or column fails to decrypt.
 */
export async function encryptField(keys: VaultKeys, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, keys.aes, enc.encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toBase64(out);
}

export async function decryptField(keys: VaultKeys, blob: string, aad: string): Promise<string> {
  try {
    const bytes = fromBase64(blob);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: enc.encode(aad) },
      keys.aes,
      bytes.slice(12),
    );
    return dec.decode(pt);
  } catch {
    throw new Error("vault decrypt failed (wrong key, tampered data, or ciphertext moved to another row)");
  }
}
