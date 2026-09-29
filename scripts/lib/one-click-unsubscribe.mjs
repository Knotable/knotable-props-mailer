// RFC 8058 one-click unsubscribe, shared by the SES worker (which signs a link
// per recipient) and the app's /api/unsubscribe route (which verifies it).
// Gmail and Yahoo require List-Unsubscribe with an HTTPS URL plus
// List-Unsubscribe-Post for bulk senders; a one-click unsubscribe also turns
// many "report spam" clicks into unsubscribes.
//
// The signing key comes from UNSUBSCRIBE_HMAC_KEY if set, otherwise from the
// service-role-only app_settings row below, which the worker creates on first
// use. Nothing needs to be configured in Vercel or GitHub.
import crypto from "node:crypto";

export const UNSUBSCRIBE_SETTINGS_KEY = "unsubscribe_link";
export const UNSUBSCRIBE_PATH = "/api/unsubscribe";
const HEX_256 = /^[0-9a-f]{64}$/i;

export function normalizeUnsubscribeKey(value) {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  return HEX_256.test(key) ? key : null;
}

export function generateUnsubscribeKey() {
  return crypto.randomBytes(32).toString("hex");
}

function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

// The signature binds campaign, list and address, so a link can only
// unsubscribe that address from the list the message was sent to.
export function unsubscribeSignature({ secret, emailId, listId, recipient }) {
  if (!normalizeUnsubscribeKey(secret)) throw new Error("A 64-hex-character unsubscribe signing key is required.");
  if (!listId) throw new Error("An unsubscribe link needs the list the recipient was sent from.");
  return crypto.createHmac("sha256", secret).update(`v2\n${emailId}\n${listId}\n${normalizeEmail(recipient)}`).digest("hex");
}

export function unsubscribeUrl({ baseUrl, secret, emailId, listId, recipient }) {
  const url = new URL(UNSUBSCRIBE_PATH, String(baseUrl).replace(/\/+$/, "") + "/");
  url.searchParams.set("c", emailId);
  url.searchParams.set("l", listId);
  url.searchParams.set("r", Buffer.from(normalizeEmail(recipient), "utf8").toString("base64url"));
  url.searchParams.set("s", unsubscribeSignature({ secret, emailId, listId, recipient }));
  return url.toString();
}

// Returns the recipient address if the link is genuine, otherwise null.
export function verifyUnsubscribe({ secret, emailId, listId, encodedRecipient, signature }) {
  if (!normalizeUnsubscribeKey(secret) || !emailId || !listId || !encodedRecipient || !/^[0-9a-f]{64}$/i.test(signature ?? "")) return null;
  let recipient;
  try {
    recipient = normalizeEmail(Buffer.from(String(encodedRecipient), "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!recipient.includes("@")) return null;
  const expected = Buffer.from(unsubscribeSignature({ secret, emailId, listId, recipient }), "hex");
  const given = Buffer.from(String(signature).toLowerCase(), "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? recipient : null;
}

// Headers for one recipient. The mailto fallback keeps reply-based
// unsubscribes working for clients that ignore the HTTPS link.
export function listUnsubscribeHeaders({ url, replyTo }) {
  const targets = [];
  if (url) targets.push(`<${url}>`);
  if (replyTo) targets.push(`<mailto:${replyTo}?subject=Unsubscribe>`);
  if (!targets.length) return [];
  const headers = [{ Name: "List-Unsubscribe", Value: targets.join(", ") }];
  if (url) headers.push({ Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" });
  return headers;
}
