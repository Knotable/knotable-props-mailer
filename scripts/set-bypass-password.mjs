#!/usr/bin/env node
// Sets (or rotates) the emergency bypass password without touching Vercel:
// writes SHA-256(password) and a fresh cookie-signing key to the
// service-role-only app_settings row "bypass_auth". Rotating the key signs
// out every existing bypass session.
//
//   BYPASS_NEW_PASSWORD='...' node scripts/set-bypass-password.mjs --deliver none
//   node scripts/set-bypass-password.mjs --deliver email   # generate + email it
//   node scripts/set-bypass-password.mjs --deliver stdout  # local terminals only
//
// Actions logs are public: stdout delivery is refused there.
import crypto from "node:crypto";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const deliver = args.get("--deliver") ?? "stdout";
if (!["email", "stdout", "none"].includes(deliver)) throw new Error("--deliver must be email, stdout, or none");
if (deliver === "stdout" && process.env.GITHUB_ACTIONS) throw new Error("Refusing to print a password into public Actions logs; use --deliver email.");

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");

const chosen = process.env.BYPASS_NEW_PASSWORD?.trim();
if (chosen && chosen.length < 16) throw new Error("BYPASS_NEW_PASSWORD must be at least 16 characters.");
if (!chosen && deliver === "none") throw new Error("Nothing to deliver: set BYPASS_NEW_PASSWORD or use --deliver email/stdout.");
const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
const generated = Array.from({ length: 5 }, () =>
  Array.from(crypto.randomBytes(5), (byte) => alphabet[byte % alphabet.length]).join(""),
).join("-");
const password = chosen || generated;

const value = {
  passwordSha256: crypto.createHash("sha256").update(password, "utf8").digest("hex"),
  cookieHmacKey: crypto.randomBytes(32).toString("hex"),
  rotatedAt: new Date().toISOString(),
  rotatedBy: process.env.GITHUB_ACTOR ? `github:${process.env.GITHUB_ACTOR}` : "cli",
};

const response = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/app_settings?on_conflict=key`, {
  method: "POST",
  headers: {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates,return=minimal",
  },
  body: JSON.stringify({
    key: "bypass_auth",
    value,
    description: "Emergency bypass login: SHA-256 of the password and the cookie HMAC key. Service role only.",
    updated_at: value.rotatedAt,
  }),
});
if (!response.ok) throw new Error(`Unable to store bypass secrets: HTTP ${response.status} ${await response.text()}`);

const appUrl = (process.env.APP_BASE_URL || "https://knotable-props-mailer.vercel.app").replace(/\/+$/, "");
const loginUrl = `${appUrl}/login/bypass`;
console.log(`Bypass password ${chosen ? "set from BYPASS_NEW_PASSWORD" : "generated"}; existing bypass sessions were signed out.`);
console.log("Note: BYPASS_PASSWORD_SHA256/BYPASS_COOKIE_HMAC_KEY in Vercel, if ever set, take precedence over this.");

if (deliver === "stdout") {
  console.log(`\n  Password: ${password}\n  Log in:   ${loginUrl}\n`);
} else if (deliver === "email") {
  const to = process.env.SES_OPERATOR_EMAIL || "a@sarva.co";
  const from = process.env.SES_NOTIFY_FROM || "Props Mailer <a@sarva.co>";
  await new SESv2Client({ region: process.env.AWS_REGION || "us-east-1" }).send(new SendEmailCommand({
    FromEmailAddress: from,
    Destination: { ToAddresses: [to] },
    Content: {
      Simple: {
        Subject: { Data: "[Props Mailer] Emergency bypass password" },
        Body: {
          Text: {
            Data: [
              chosen ? "Your chosen bypass password (GitHub secret BYPASS_PASSWORD) is now active." : `New bypass password: ${password}`,
              "",
              `Log in: ${loginUrl}`,
              "Sessions last 12 hours. Rotating the password signs out existing bypass sessions.",
              "",
              "If you did not request this, run the Reset bypass password workflow again to rotate it.",
            ].join("\n"),
          },
        },
      },
    },
  }));
  console.log(`Emailed login details to ${to.replace(/^(.).*(@.*)$/, "$1***$2")}.`);
}
