// Admin session: a signed, expiring cookie value. WebCrypto only (works in proxy and routes).
export const SESSION_COOKIE = "tpw_admin";
export const SESSION_MAX_AGE_S = 60 * 60 * 8;

const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Constant-time password check: compare HMACs of both strings, which are always the same length. */
export async function passwordMatches(input: string, expected: string, secret: string): Promise<boolean> {
  const [a, b] = await Promise.all([hmac(secret, `pw:${input}`), hmac(secret, `pw:${expected}`)]);
  return equalBytes(a, b);
}

export async function createSessionValue(secret: string, nowMs = Date.now()): Promise<string> {
  const exp = String(Math.floor(nowMs / 1000) + SESSION_MAX_AGE_S);
  return `${exp}.${toHex(await hmac(secret, `session:${exp}`))}`;
}

export async function verifySessionValue(value: string | undefined, secret: string, nowMs = Date.now()): Promise<boolean> {
  if (!value) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < Math.floor(nowMs / 1000)) return false;
  return equalBytes(enc.encode(sig), enc.encode(toHex(await hmac(secret, `session:${exp}`))));
}
