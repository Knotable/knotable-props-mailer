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
  role: "admin" | "user";
  canSend: boolean;
  canManageUsers: boolean;
} | null;

type ProfileAccess = {
  userId: string;
  email: string;
  role: "admin" | "user";
  canSend: boolean;
};

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

const normalizeEmail = (email: string | null | undefined) => String(email ?? "").trim().toLowerCase();

const isOwnerEmail = (email: string | null | undefined) => normalizeEmail(email) === normalizeEmail(ALLOWED_EMAIL);

const normalizeRole = (role: string | null | undefined): "admin" | "user" =>
  role === "admin" ? "admin" : "user";

async function selectProfileById(userId: string): Promise<ProfileAccess | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, role, can_send")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    // Keep auth usable during the deploy window before the can_send migration
    // has been applied. Once the column exists this fallback is not used.
    const { data: fallback, error: fallbackError } = await supabase
      .from("profiles")
      .select("id, email, role")
      .eq("id", userId)
      .maybeSingle();
    if (fallbackError || !fallback?.id) return null;
    return {
      userId: fallback.id,
      email: fallback.email,
      role: normalizeRole(fallback.role),
      canSend: isOwnerEmail(fallback.email),
    };
  }

  if (!data?.id) return null;
  const role = normalizeRole(data.role);
  return {
    userId: data.id,
    email: data.email,
    role,
    canSend: isOwnerEmail(data.email) || Boolean((data as { can_send?: boolean | null }).can_send),
  };
}

export async function ensureUserProfile(userId: string, email: string): Promise<ProfileAccess> {
  const supabase = getSupabaseAdmin();
  const normalizedEmail = normalizeEmail(email);
  const owner = isOwnerEmail(normalizedEmail);
  const existing = await selectProfileById(userId);

  if (existing) {
    if (owner && (existing.role !== "admin" || !existing.canSend || existing.email !== normalizedEmail)) {
      const { error } = await supabase
        .from("profiles")
        .update({ email: normalizedEmail, role: "admin", can_send: true })
        .eq("id", userId);
      if (error) {
        await supabase
          .from("profiles")
          .update({ email: normalizedEmail, role: "admin" })
          .eq("id", userId);
      }
      return {
        userId,
        email: normalizedEmail,
        role: "admin",
        canSend: true,
      };
    }

    if (existing.email !== normalizedEmail) {
      await supabase.from("profiles").update({ email: normalizedEmail }).eq("id", userId);
      return { ...existing, email: normalizedEmail };
    }

    return existing;
  }

  const insertWithPermissions = {
    id: userId,
    email: normalizedEmail,
    role: owner ? "admin" : "user",
    can_send: owner,
  };
  const { error } = await supabase.from("profiles").insert(insertWithPermissions);
  if (error) {
    const { error: fallbackError } = await supabase.from("profiles").insert({
      id: userId,
      email: normalizedEmail,
      role: owner ? "admin" : "user",
    });
    if (fallbackError) throw fallbackError;
  }

  return {
    userId,
    email: normalizedEmail,
    role: owner ? "admin" : "user",
    canSend: owner,
  };
}

function toAuthContext(profile: ProfileAccess, isBypass: boolean): NonNullable<ServerAuthContext> {
  const role = isOwnerEmail(profile.email) ? "admin" : profile.role;
  const canSend = isOwnerEmail(profile.email) || profile.canSend;
  return {
    userId: profile.userId,
    email: profile.email,
    isBypass,
    role,
    canSend,
    canManageUsers: role === "admin",
  };
}

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

async function resolveAllowedProfile(): Promise<ProfileAccess> {
  const supabase = getSupabaseAdmin();
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, email, role, can_send")
    .eq("email", ALLOWED_EMAIL)
    .maybeSingle();

  if (!error && profile?.id) {
    return ensureUserProfile(profile.id, profile.email);
  }

  // No profile row yet — upsert the hardcoded bypass user so bypass auth
  // always works even before a Supabase auth user has been created.
  const BYPASS_USER_ID = "00000000-0000-0000-0000-000000000001";
  const { data: upserted, error: upsertError } = await supabase
    .from("profiles")
    .upsert({ id: BYPASS_USER_ID, email: ALLOWED_EMAIL, role: "admin", can_send: true }, { onConflict: "id" })
    .select("id, email, role, can_send")
    .single();

  if (upsertError || !upserted?.id) {
    const { data: fallback, error: fallbackError } = await supabase
      .from("profiles")
      .upsert({ id: BYPASS_USER_ID, email: ALLOWED_EMAIL, role: "admin" }, { onConflict: "id" })
      .select("id, email")
      .single();
    if (fallbackError || !fallback?.id) {
      throw new Error(`Allowed profile not found for ${ALLOWED_EMAIL}`);
    }
    return { userId: fallback.id, email: fallback.email, role: "admin" as const, canSend: true };
  }

  return {
    userId: upserted.id,
    email: upserted.email,
    role: "admin",
    canSend: true,
  };
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
    return toAuthContext(profile, true);
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

  if (!user?.id || !user.email) return null;
  const profile = await ensureUserProfile(user.id, user.email);
  return toAuthContext(profile, false);
}

export async function requireServerAuthContext(): Promise<NonNullable<ServerAuthContext>> {
  const auth = await getServerAuthContext();
  if (!auth?.userId) throw new Error("Unauthorized");
  return auth;
}

export async function requireAdminAuthContext(): Promise<NonNullable<ServerAuthContext>> {
  const auth = await requireServerAuthContext();
  if (!auth.canManageUsers) throw new Error("Admin access required");
  return auth;
}

export async function requireCanSendAuthContext(): Promise<NonNullable<ServerAuthContext>> {
  const auth = await requireServerAuthContext();
  if (!auth.canSend) {
    throw new Error("This account can draft and review mail, but an admin has not enabled sending.");
  }
  return auth;
}
