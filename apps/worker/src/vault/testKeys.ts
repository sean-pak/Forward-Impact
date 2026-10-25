import { importVaultKeys, toBase64 } from "./crypto";

// Fixed keys for tests only. Never used outside *.test.ts.
export const TEST_HMAC_B64 = toBase64(new Uint8Array(32).fill(7));
export const TEST_ENC_B64 = toBase64(new Uint8Array(32).fill(9));
export const OTHER_ENC_B64 = toBase64(new Uint8Array(32).fill(11));

export const testKeys = () => importVaultKeys(TEST_HMAC_B64, TEST_ENC_B64);
