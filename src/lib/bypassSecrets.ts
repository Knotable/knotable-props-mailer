// Emergency-bypass secrets. Vercel env vars win (BYPASS_PASSWORD, or the
// hash/key pair); otherwise they are read from the service-role-only
// app_settings row "bypass_auth" (RLS enabled, no policies), which the SES
// Autopilot workflow keeps in sync with the BYPASS_PASSWORD GitHub secret.
// Uses fetch and Web Crypto so it runs in both Node and the edge proxy.

export const BYPASS_SETTINGS_KEY = "bypass_auth";
const HEX_256 = /^[0-9a-f]{64}$/i;
const CACHE_MS = 60_000;

export type BypassSecrets = { passwordSha256: string; cookieHmacKey: string; source: "env" | "database" };

let cached: { value: BypassSecrets | null; at: number } | null = null;

const normalize = (passwordSha256: unknown, cookieHmacKey: unknown, source: BypassSecrets["source"]): BypassSecrets | null => {
  const password = typeof passwordSha256 === "string" ? passwordSha256.trim().toLowerCase() : "";
  const key = typeof cookieHmacKey === "string" ? cookieHmacKey.trim().toLowerCase() : "";
  if (!HEX_256.test(password) || !HEX_256.test(key) || password === key) return null;
  return { passwordSha256: password, cookieHmacKey: key, source };
};

async function loadFromDatabase(): Promise<BypassSecrets | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/app_settings?key=eq.${BYPASS_SETTINGS_KEY}&select=value`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const rows = (await response.json()) as Array<{ value?: { passwordSha256?: unknown; cookieHmacKey?: unknown } }>;
    const value = rows[0]?.value;
    return value ? normalize(value.passwordSha256, value.cookieHmacKey, "database") : null;
  } catch {
    return null;
  }
}

const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");

// A plain BYPASS_PASSWORD env var (e.g. set in Vercel) also works. Its cookie
// key is derived with the service-role key so it is not guessable from the
// password alone.
async function fromPlainPassword(): Promise<BypassSecrets | null> {
  const password = process.env.BYPASS_PASSWORD;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!password || !serviceKey) return null;
  const encoder = new TextEncoder();
  const passwordSha256 = hex(await crypto.subtle.digest("SHA-256", encoder.encode(password)));
  const key = await crypto.subtle.importKey("raw", encoder.encode(serviceKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const cookieHmacKey = hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`props-mailer-bypass-cookie:${passwordSha256}`)));
  return normalize(passwordSha256, cookieHmacKey, "env");
}

export async function getBypassSecrets(): Promise<BypassSecrets | null> {
  const fromEnv = normalize(process.env.BYPASS_PASSWORD_SHA256, process.env.BYPASS_COOKIE_HMAC_KEY, "env") ?? (await fromPlainPassword());
  if (fromEnv) return fromEnv;
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = await loadFromDatabase();
  cached = { value, at: Date.now() };
  return value;
}

export function clearBypassSecretsCache() {
  cached = null;
}
