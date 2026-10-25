// pnpm google:auth            sign in as the mailbox once and print GOOGLE_REFRESH_TOKEN
// pnpm google:auth --write    also append it to apps/worker/.dev.vars (refuses to overwrite)
// Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the environment or apps/worker/.dev.vars.
// Loopback flow for a Desktop OAuth client: a one-shot local server catches the redirect.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";
import { DEV_VARS, parseDevVars } from "./keys";

const SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const TIMEOUT_MS = 5 * 60 * 1000;

const file = existsSync(DEV_VARS) ? parseDevVars(readFileSync(DEV_VARS, "utf8")) : {};
const clientId = process.env.GOOGLE_CLIENT_ID ?? file.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? file.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(`GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not found in the environment or apps/worker/.dev.vars.

Human setup checklist (PRD 11):
  1. Google Cloud project under the seanpak.com Workspace; enable the Gmail API.
  2. OAuth consent screen: user type Internal. Add scope gmail.modify.
  3. Credentials > Create OAuth client ID > application type Desktop app.
  4. Add to apps/worker/.dev.vars:
       GOOGLE_CLIENT_ID=...
       GOOGLE_CLIENT_SECRET=...
  5. Run: pnpm google:auth --write   (sign in as hello@seanpak.com)`);
  process.exit(1);
}

const TokenSchema = z.object({ refresh_token: z.string().optional() });

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("base64url");

const server = createServer();
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const redirectUri = `http://127.0.0.1:${port}`;

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: SCOPE,
  access_type: "offline",
  prompt: "consent",
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
}).toString();

console.log("Open this URL in a browser and sign in as the mailbox (hello@seanpak.com):\n");
console.log(authUrl.toString());
console.log(`\nWaiting for the redirect on ${redirectUri} (5 minutes)...`);

const code = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Timed out waiting for sign-in")), TIMEOUT_MS);
  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", redirectUri);
    const err = url.searchParams.get("error");
    const got = url.searchParams.get("code");
    if (url.searchParams.get("state") !== state || (!err && !got)) {
      res.writeHead(400).end("Unexpected request.");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" }).end(err ? `Sign-in failed: ${err}` : "Done. You can close this tab.");
    clearTimeout(timer);
    if (err) reject(new Error(`Google returned error: ${err}`));
    else resolve(got as string);
  });
}).finally(() => server.close());

const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: verifier,
  }),
});
if (!res.ok) {
  console.error(`Token exchange failed (${res.status}): ${await res.text()}`);
  process.exit(1);
}
const { refresh_token } = TokenSchema.parse(await res.json());
if (!refresh_token) {
  console.error("Google returned no refresh token. Remove the app at https://myaccount.google.com/permissions and run again.");
  process.exit(1);
}

if (process.argv.includes("--write")) {
  if (file.GOOGLE_REFRESH_TOKEN) {
    console.error("apps/worker/.dev.vars already has GOOGLE_REFRESH_TOKEN. Not overwriting; edit it by hand if you mean to replace it.");
    process.exit(1);
  }
  appendFileSync(DEV_VARS, `GOOGLE_REFRESH_TOKEN=${refresh_token}\n`);
  console.log("Wrote GOOGLE_REFRESH_TOKEN to apps/worker/.dev.vars (gitignored).");
} else {
  console.log(`GOOGLE_REFRESH_TOKEN=${refresh_token}`);
}
console.log("Deployed Worker needs these as secrets (paste each value from .dev.vars):");
for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]) {
  console.log(`  cd apps/worker && pnpm exec wrangler secret put ${k}`);
}
