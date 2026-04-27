import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const ALLOWED_EMAIL = process.env.ALLOWED_EMAIL ?? "a@sarva.co";
export const BYPASS_COOKIE_NAME = "props-mailer-bypass";

const BYPASS_PASSWORD_SHA256 =
  "cf1878cb8ecc9dd537b2a25273d5ff92eb8eec876a6dfb008d6f52a1d667cb53";
const BYPASS_COOKIE_HMAC_KEY =
  "074e9acec6c6dbd092dc617febf7cf5ce24c80ab2013c06aea1f4639092a3bf5";
const BYPASS_DURATION_MS = 12 * 60 * 60 * 1000;

export type ServerAuthContext = {
  userId: string;
  email: string;
  isBypass: boolean;
} | null;

const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const secureCompareHex = (left: string, right: string) => {
  const leftBuf = Buffer.from(left, "hex");
  const rightBuf = Buffer.from(right, "hex");
  return leftBuf.length === rightBuf.length && timingSafeEqual(leftBuf, rightBuf);
};

const signBypassExpiry = (expiresAtMs: number) =>
  createHmac("sha256", Buffer.from(BYPASS_COOKIE_HMAC_KEY, "hex"))
    .update(String(expiresAtMs))
    .digest("hex");

export const verifyBypassPassword = (candidate: string) =>
  secureCompareHex(sha256Hex(candidate), BYPASS_PASSWORD_SHA256);

export const createBypassCookieValue = (expiresAtMs = Date.now() + BYPASS_DURATION_MS) => {
  const signature = signBypassExpiry(expiresAtMs);
  return `${expiresAtMs}.${signature}`;
};

export const isValidBypassCookieValue = (rawValue: string | undefined) => {
  if (!rawValue) return false;
  const [expiresAtRaw, signature] = rawValue.split(".");
  const expiresAtMs = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAtMs) || !signature) return false;
  if (Date.now() >= expiresAtMs) return false;
  return secureCompareHex(signature, signBypassExpiry(expiresAtMs));
};

export const requestHasBypassAccess = (request: NextRequest) =>
  isValidBypassCookieValue(request.cookies.get(BYPASS_COOKIE_NAME)?.value);

export async function setBypassSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.set({
    name: BYPASS_COOKIE_NAME,
    value: createBypassCookieValue(),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: BYPASS_DURATION_MS / 1000,
  });
}

export async function clearBypassSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.set({
    name: BYPASS_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(0),
  });
}

async function resolveAllowedProfile() {
  const supabase = getSupabaseAdmin();
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, email")
    .eq("email", ALLOWED_EMAIL)
    .maybeSingle();

  if (error || !profile?.id) {
    throw new Error(`Allowed profile not found for ${ALLOWED_EMAIL}`);
  }

  return { userId: profile.id, email: profile.email };
}

export async function createServerAppClient() {
  const cookieStore = await cookies();
  if (isValidBypassCookieValue(cookieStore.get(BYPASS_COOKIE_NAME)?.value)) {
    return getSupabaseAdmin();
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Missing Supabase env vars");
  }

  const safeSetCookie = (name: string, value: string, options?: Record<string, unknown>) => {
    // Next.js App Router only allows cookie writes in Server Actions and Route
    // Handlers. During Server Component re-renders triggered by revalidation,
    // Supabase may try to refresh auth cookies, which must be ignored here.
    try {
      cookieStore.set({ name, value, ...options });
    } catch {}
  };

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      get(name) {
        return cookieStore.get(name)?.value;
      },
      set(name, value, options) {
        safeSetCookie(name, value, options);
      },
      remove(name, options) {
        safeSetCookie(name, "", options);
      },
    },
  });
}

export async function getServerAuthContext(): Promise<ServerAuthContext> {
  const cookieStore = await cookies();
  if (isValidBypassCookieValue(cookieStore.get(BYPASS_COOKIE_NAME)?.value)) {
    const profile = await resolveAllowedProfile();
    return { ...profile, isBypass: true };
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) return null;

  const safeSetCookie = (name: string, value: string, options?: Record<string, unknown>) => {
    try {
      cookieStore.set({ name, value, ...options });
    } catch {}
  };

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      get(name) {
        return cookieStore.get(name)?.value;
      },
      set(name, value, options) {
        safeSetCookie(name, value, options);
      },
      remove(name, options) {
        safeSetCookie(name, "", options);
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.id || user.email !== ALLOWED_EMAIL) return null;
  return { userId: user.id, email: user.email, isBypass: false };
}
