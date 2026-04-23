'use server';

import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  ALLOWED_EMAIL,
  clearBypassSessionCookie,
  setBypassSessionCookie,
  verifyBypassPassword,
} from "@/lib/authAccess";
import { logError } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import { createServerSupabaseClient } from "@/lib/supabaseServer";

const normalizeEmail = (value: FormDataEntryValue | null) =>
  String(value ?? "").trim().toLowerCase();

async function getRequestMeta() {
  const headerStore = await headers();
  const ip =
    headerStore.get("x-forwarded-for")?.split(",")[0].trim() ??
    headerStore.get("x-real-ip") ??
    "unknown";
  const userAgent = headerStore.get("user-agent") ?? "unknown";
  return { ip, userAgent };
}

async function logAuthTrace(
  correlationId: string,
  message: string,
  payload: Record<string, unknown>,
) {
  await logError({
    message,
    source: "auth",
    payload,
    correlationId,
  });
}

export async function sendLoginCode(formData: FormData) {
  const correlationId = randomUUID();
  const { ip, userAgent } = await getRequestMeta();
  const { allowed, retryAfterMs } = checkRateLimit(`login-code:${ip}`, 6, 5 * 60 * 1000);
  const email = normalizeEmail(formData.get("email"));

  if (!allowed) {
    await logAuthTrace(correlationId, "Login code request rate-limited", {
      email,
      ip,
      userAgent,
      retryAfterMs,
    });
    redirect(
      `/login?email=${encodeURIComponent(email)}&trace=${encodeURIComponent(correlationId)}&error=${encodeURIComponent(
        `rate:${Math.ceil(retryAfterMs / 1000)}`,
      )}`,
    );
  }

  if (!email) {
    await logAuthTrace(correlationId, "Login code request missing email", { ip, userAgent });
    redirect(`/login?trace=${encodeURIComponent(correlationId)}&error=missing-email`);
  }

  if (email !== ALLOWED_EMAIL) {
    await logAuthTrace(correlationId, "Login code requested for unauthorized email", {
      email,
      ip,
      userAgent,
    });
    redirect(
      `/login?email=${encodeURIComponent(email)}&trace=${encodeURIComponent(correlationId)}&error=unauthorized`,
    );
  }

  await logAuthTrace(correlationId, "Login code request started", { email, ip, userAgent });
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
    },
  });

  if (error) {
    await logAuthTrace(correlationId, "Login code send failed", {
      email,
      ip,
      userAgent,
      errorCode: error.status,
      errorMessage: error.message,
    });
    redirect(
      `/login?email=${encodeURIComponent(email)}&trace=${encodeURIComponent(correlationId)}&error=send-code`,
    );
  }

  await logAuthTrace(correlationId, "Login code sent", { email, ip, userAgent });
  redirect(`/login?email=${encodeURIComponent(email)}&trace=${encodeURIComponent(correlationId)}&sent=1`);
}

export async function verifyLoginCode(formData: FormData) {
  const correlationId = randomUUID();
  const { ip, userAgent } = await getRequestMeta();
  const email = normalizeEmail(formData.get("email"));
  const token = String(formData.get("code") ?? "").trim();

  if (!email || !token) {
    await logAuthTrace(correlationId, "Login code verify missing input", {
      email,
      ip,
      userAgent,
      hasToken: Boolean(token),
    });
    redirect(
      `/login?email=${encodeURIComponent(email)}&trace=${encodeURIComponent(correlationId)}&error=missing-code`,
    );
  }

  if (email !== ALLOWED_EMAIL) {
    await logAuthTrace(correlationId, "Login code verify unauthorized email", {
      email,
      ip,
      userAgent,
    });
    redirect(
      `/login?email=${encodeURIComponent(email)}&trace=${encodeURIComponent(correlationId)}&error=unauthorized`,
    );
  }

  await logAuthTrace(correlationId, "Login code verify started", {
    email,
    ip,
    userAgent,
    tokenLength: token.length,
  });
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.verifyOtp({
    email,
    token,
    type: "email",
  });

  if (error) {
    await logAuthTrace(correlationId, "Login code verify failed", {
      email,
      ip,
      userAgent,
      errorCode: error.status,
      errorMessage: error.message,
    });
    redirect(
      `/login?email=${encodeURIComponent(email)}&trace=${encodeURIComponent(correlationId)}&sent=1&error=invalid-code`,
    );
  }

  await logAuthTrace(correlationId, "Login code verify succeeded", { email, ip, userAgent });
  redirect("/email/composer");
}

export async function bypassLogin(formData: FormData) {
  const correlationId = randomUUID();
  const { ip, userAgent } = await getRequestMeta();
  const password = String(formData.get("password") ?? "");

  await logAuthTrace(correlationId, "Bypass login attempt started", {
    ip,
    userAgent,
    passwordLength: password.length,
  });

  if (!verifyBypassPassword(password)) {
    await logAuthTrace(correlationId, "Bypass login attempt failed", { ip, userAgent });
    redirect(`/login?trace=${encodeURIComponent(correlationId)}&error=bypass-failed`);
  }

  await setBypassSessionCookie();
  await logAuthTrace(correlationId, "Bypass login succeeded", {
    ip,
    userAgent,
    allowedEmail: ALLOWED_EMAIL,
  });
  redirect("/email/composer");
}

export async function signOutAction() {
  await clearBypassSessionCookie();
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  redirect("/login");
}
