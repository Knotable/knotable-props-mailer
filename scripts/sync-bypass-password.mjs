#!/usr/bin/env node
// Keeps the app's bypass password equal to the BYPASS_PASSWORD value (the
// GitHub repository secret). Runs as the first step of the 5-minute SES
// Autopilot workflow, so setting or changing the secret takes effect within
// about five minutes with nothing else to click. Stores only SHA-256 of the
// password plus a cookie-signing key, in the service-role-only app_settings
// row "bypass_auth". Never prints the password (Actions logs are public).
//
// Local use: BYPASS_PASSWORD=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run bypass:sync
import crypto from "node:crypto";

const password = process.env.BYPASS_PASSWORD ?? "";
const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!password) {
  console.log("BYPASS_PASSWORD is not set; bypass password left unchanged.");
  process.exit(0);
}
if (!url || !serviceKey) {
  console.log("Supabase credentials are not configured; cannot sync the bypass password.");
  process.exit(0);
}

const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
const passwordSha256 = crypto.createHash("sha256").update(password, "utf8").digest("hex");

try {
  const current = await fetch(`${url}/rest/v1/app_settings?key=eq.bypass_auth&select=value`, { headers });
  if (!current.ok) throw new Error(`read failed: HTTP ${current.status}`);
  const existing = (await current.json())[0]?.value;
  if (existing?.passwordSha256 === passwordSha256 && /^[0-9a-f]{64}$/.test(existing?.cookieHmacKey ?? "")) {
    console.log("Bypass password already in sync.");
    process.exit(0);
  }
  const value = {
    passwordSha256,
    // New key on every password change: signs out existing bypass sessions.
    cookieHmacKey: crypto.randomBytes(32).toString("hex"),
    rotatedAt: new Date().toISOString(),
    rotatedBy: process.env.GITHUB_ACTIONS ? "github-secret-sync" : "cli",
  };
  const write = await fetch(`${url}/rest/v1/app_settings?on_conflict=key`, {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      key: "bypass_auth",
      value,
      description: "Emergency bypass login: SHA-256 of BYPASS_PASSWORD and the cookie HMAC key. Service role only.",
      updated_at: value.rotatedAt,
    }),
  });
  if (!write.ok) throw new Error(`write failed: HTTP ${write.status}`);
  console.log(`Bypass password ${existing ? "updated" : "set"} from BYPASS_PASSWORD; it works at /login/bypass and /ai/login within a minute.`);
} catch (error) {
  // Never block the sender on this: report and move on.
  console.log(`::warning::Bypass password sync failed (${error.message}).`);
}
