import type { NextRequest } from "next/server";

export const ALLOWED_EMAIL = process.env.ALLOWED_EMAIL ?? "a@sarva.co";
export const BYPASS_COOKIE_NAME = "props-mailer-bypass";

const BYPASS_COOKIE_HMAC_KEY =
  "074e9acec6c6dbd092dc617febf7cf5ce24c80ab2013c06aea1f4639092a3bf5";

const hexToBytes = (hex: string) => {
  if (hex.length % 2 !== 0) return null;

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const value = Number.parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(value)) return null;
    bytes[i / 2] = value;
  }

  return bytes;
};

const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const secureCompareHex = (left: string, right: string) => {
  const leftBytes = hexToBytes(left);
  const rightBytes = hexToBytes(right);

  if (!leftBytes || !rightBytes || leftBytes.length !== rightBytes.length) {
    return false;
  }

  let mismatch = 0;
  for (let i = 0; i < leftBytes.length; i++) {
    mismatch |= leftBytes[i] ^ rightBytes[i];
  }

  return mismatch === 0;
};

const signBypassExpiry = async (expiresAtMs: number) => {
  const keyBytes = hexToBytes(BYPASS_COOKIE_HMAC_KEY);
  if (!keyBytes) {
    throw new Error("Invalid bypass HMAC key");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(String(expiresAtMs)),
  );

  return bytesToHex(new Uint8Array(signature));
};

export const isValidBypassCookieValue = async (rawValue: string | undefined) => {
  if (!rawValue) return false;

  const [expiresAtRaw, signature] = rawValue.split(".");
  const expiresAtMs = Number(expiresAtRaw);

  if (!Number.isFinite(expiresAtMs) || !signature) return false;
  if (Date.now() >= expiresAtMs) return false;

  const expectedSignature = await signBypassExpiry(expiresAtMs);
  return secureCompareHex(signature, expectedSignature);
};

export const requestHasBypassAccess = async (request: NextRequest) =>
  isValidBypassCookieValue(request.cookies.get(BYPASS_COOKIE_NAME)?.value);
