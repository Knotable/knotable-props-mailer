// Emergency-bypass secrets. Vercel env vars win; otherwise they are read from
// the service-role-only app_settings row "bypass_auth" (RLS enabled, no
// policies), which the "Reset bypass password" workflow or the Account page
// writes. Uses plain fetch so it runs in both Node and the edge proxy.

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

export async function getBypassSecrets(): Promise<BypassSecrets | null> {
  const fromEnv = normalize(process.env.BYPASS_PASSWORD_SHA256, process.env.BYPASS_COOKIE_HMAC_KEY, "env");
  if (fromEnv) return fromEnv;
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = await loadFromDatabase();
  cached = { value, at: Date.now() };
  return value;
}

export function clearBypassSecretsCache() {
  cached = null;
}
