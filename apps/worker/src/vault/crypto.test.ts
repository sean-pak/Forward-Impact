import { describe, expect, it } from "vitest";
import { decryptField, encryptField, fromBase64, hmacHex, importVaultKeys, toBase64 } from "./crypto";
import { OTHER_ENC_B64, TEST_ENC_B64, TEST_HMAC_B64, testKeys } from "./testKeys";

describe("encryptField / decryptField", () => {
  it("round-trips unicode", async () => {
    const k = await testKeys();
    const blob = await encryptField(k, "José O'Brien-Núñez", "pk_1:first");
    expect(await decryptField(k, blob, "pk_1:first")).toBe("José O'Brien-Núñez");
  });

  it("uses a different IV and ciphertext every time", async () => {
    const k = await testKeys();
    const a = await encryptField(k, "SYN00001", "pk_1:cdcr");
    const b = await encryptField(k, "SYN00001", "pk_1:cdcr");
    expect(a).not.toBe(b);
    expect(toBase64(fromBase64(a).slice(0, 12))).not.toBe(toBase64(fromBase64(b).slice(0, 12)));
    expect(fromBase64(a)).toHaveLength(12 + "SYN00001".length + 16); // iv + ct + GCM tag
  });

  it("contains no plaintext, raw or base64", async () => {
    const k = await testKeys();
    const secret = "SYN00001";
    const blob = await encryptField(k, secret, "pk_1:cdcr");
    expect(blob).not.toContain(secret);
    expect(blob).not.toContain(btoa(secret));
    const raw = new TextDecoder("latin1").decode(fromBase64(blob));
    expect(raw).not.toContain(secret);
  });

  it("fails with the wrong key", async () => {
    const k = await testKeys();
    const other = await importVaultKeys(TEST_HMAC_B64, OTHER_ENC_B64);
    const blob = await encryptField(k, "secret", "pk_1:first");
    await expect(decryptField(other, blob, "pk_1:first")).rejects.toThrow(/decrypt failed/);
  });

  it("fails when the blob is tampered with or moved to another row or field", async () => {
    const k = await testKeys();
    const blob = await encryptField(k, "secret", "pk_1:first");
    const bytes = fromBase64(blob);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    await expect(decryptField(k, toBase64(bytes), "pk_1:first")).rejects.toThrow();
    await expect(decryptField(k, blob, "pk_2:first")).rejects.toThrow();
    await expect(decryptField(k, blob, "pk_1:last")).rejects.toThrow();
  });

  it("errors never contain the plaintext or the key", async () => {
    const k = await testKeys();
    const blob = await encryptField(k, "Hunter2Secret", "a");
    const err = await decryptField(k, blob, "b").catch((e: Error) => e.message);
    expect(err).not.toContain("Hunter2Secret");
    expect(err).not.toContain(TEST_ENC_B64);
  });
});

describe("importVaultKeys", () => {
  it("rejects missing, short, or non-base64 keys without echoing them", async () => {
    await expect(importVaultKeys(undefined, TEST_ENC_B64)).rejects.toThrow(/VAULT_HMAC_KEY/);
    await expect(importVaultKeys(TEST_HMAC_B64, toBase64(new Uint8Array(16)))).rejects.toThrow(/VAULT_ENC_KEY/);
    await expect(importVaultKeys("not base64 !!!", TEST_ENC_B64)).rejects.toThrow(/VAULT_HMAC_KEY/);
    const err = await importVaultKeys("not base64 !!!", TEST_ENC_B64).catch((e: Error) => e.message);
    expect(err).not.toContain("not base64");
  });

  it("rejects using one key for both jobs", async () => {
    await expect(importVaultKeys(TEST_ENC_B64, TEST_ENC_B64)).rejects.toThrow(/different/);
  });
});

describe("hmacHex", () => {
  it("matches a direct WebCrypto HMAC-SHA256 over the same key bytes", async () => {
    const raw = await crypto.subtle.importKey("raw", fromBase64(TEST_HMAC_B64), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", raw, new TextEncoder().encode("cdcr:SYN00001")));
    const expected = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await hmacHex(await testKeys(), "cdcr:SYN00001")).toBe(expected);
    expect(expected).toHaveLength(64);
  });
});
