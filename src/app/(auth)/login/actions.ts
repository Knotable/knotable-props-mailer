'use server';

import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  clearBypassSessionCookie,
  ensureUserProfile,
  ALLOWED_EMAIL,
  setBypassSessionCookie,
  verifyBypassPassword,
} from "@/lib/authAccess";
import { logError } from "@/lib/logger";
import { checkRateLimitSync as checkRateLimit } from "@/lib/rateLimit";
import { createServerSupabaseClient } from "@/lib/supabaseServer";
import { env } from "@/lib/env";

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

const appUrl = (path: string) => `${env.appBaseUrl.replace(/\/$/, "")}${path}`;

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
      `/login/code?email=${encodeURIComponent(email)}&trace=${encodeURIComponent(correlationId)}&error=${encodeURIComponent(
        `rate:${Math.ceil(retryAfterMs / 1000)}`,
      )}`,
    );
  }

  if (!email) {
    await logAuthTrace(correlationId, "Login code request missing email", { ip, userAgent });
    redirect(`/login/code?trace=${encodeURIComponent(correlationId)}&error=missing-email`);
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
    // Supabase returns 429 with a message like "For security purposes, you can only
    // request this after 26 seconds." — surface that as a rate-limit error so the
    // user sees a countdown rather than a generic "couldn't send" message.
    const retrySecondsMatch = error.message?.match(/after\s+(\d+)\s+second/i);
    const retrySeconds = retrySecondsMatch ? parseInt(retrySecondsMatch[1], 10) : null;
    const isRateLimit = error.status === 429 || retrySeconds !== null;

    await logAuthTrace(correlationId, "Login code send failed", {
      email,
      ip,
      userAgent,
      errorCode: error.status,
      errorMessage: error.message,
      isRateLimit,
      retrySeconds,
    });

    if (isRateLimit) {
      redirect(
        `/login/code?email=${encodeURIComponent(email)}&trace=${encodeURIComponent(correlationId)}&error=${encodeURIComponent(
          `rate:${retrySeconds ?? 60}`,
        )}`,
      );
    }

    const errorCode = /signups not allowed|user not found|not found/i.test(error.message ?? "")
      ? "account-not-found"
      : "send-code";
    redirect(
      `/login/code?email=${encodeURIComponent(email)}&trace=${encodeURIComponent(correlationId)}&error=${errorCode}`,
    );
  }

  await logAuthTrace(correlationId, "Login code sent", { email, ip, userAgent });
  redirect(`/login/code?email=${encodeURIComponent(email)}&trace=${encodeURIComponent(correlationId)}&sent=1`);
}

export async function sendPasswordReset(formData: FormData) {
  const correlationId = randomUUID();
  const { ip, userAgent } = await getRequestMeta();
  const { allowed, retryAfterMs } = checkRateLimit(`password-reset:${ip}`, 6, 5 * 60 * 1000);
  const email = normalizeEmail(formData.get("email"));

  if (!allowed) {
    await logAuthTrace(correlationId, "Password reset request rate-limited", {
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
    await logAuthTrace(correlationId, "Password reset request missing email", { ip, userAgent });
    redirect(`/login?trace=${encodeURIComponent(correlationId)}&error=missing-email`);
  }

  await logAuthTrace(correlationId, "Password reset request started", { email, ip, userAgent });
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    // Supabase SSR uses PKCE and redirects back with `?code=...`. Preserve the
    // recovery intent because the authorization-code callback does not include
    // an OTP type the way token-hash templates do.
    redirectTo: appUrl("/loginWithToken?next=/reset-password"),
  });

  if (error) {
    const retrySecondsMatch = error.message?.match(/after\s+(\d+)\s+second/i);
    const retrySeconds = retrySecondsMatch ? parseInt(retrySecondsMatch[1], 10) : null;
    const isRateLimit = error.status === 429 || retrySeconds !== null;

    await logAuthTrace(correlationId, "Password reset request failed", {
      email,
      ip,
      userAgent,
      errorCode: error.status,
      errorMessage: error.message,
      isRateLimit,
      retrySeconds,
    });
    redirect(
      `/login?email=${encodeURIComponent(email)}&trace=${encodeURIComponent(correlationId)}&error=${encodeURIComponent(
        isRateLimit ? `reset-rate:${retrySeconds ?? 60}` : "reset-password",
      )}`,
    );
  }

  await logAuthTrace(correlationId, "Password reset email sent", { email, ip, userAgent });
  redirect(`/login?email=${encodeURIComponent(email)}&trace=${encodeURIComponent(correlationId)}&reset=1`);
}

export async function sendSignupCode(formData: FormData) {
  const correlationId = randomUUID();
  const { ip, userAgent } = await getRequestMeta();
  const { allowed, retryAfterMs } = checkRateLimit(`signup-code:${ip}`, 6, 5 * 60 * 1000);
  const email = normalizeEmail(formData.get("email"));

  if (!allowed) {
    await logAuthTrace(correlationId, "Signup code request rate-limited", {
      email,
      ip,
      userAgent,
      retryAfterMs,
    });
    redirect(
      `/signup?email=${encodeURIComponent(email)}&trace=${encodeURIComponent(correlationId)}&error=${encodeURIComponent(
        `rate:${Math.ceil(retryAfterMs / 1000)}`,
      )}`,
    );
  }

  if (!email) {
    await logAuthTrace(correlationId, "Signup code request missing email", { ip, userAgent });
    redirect(`/signup?trace=${encodeURIComponent(correlationId)}&error=missing-email`);
  }

  await logAuthTrace(correlationId, "Signup code request started", { email, ip, userAgent });
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
    },
  });

  if (error) {
    const retrySecondsMatch = error.message?.match(/after\s+(\d+)\s+second/i);
    const retrySeconds = retrySecondsMatch ? parseInt(retrySecondsMatch[1], 10) : null;
    const isRateLimit = error.status === 429 || retrySeconds !== null;

    await logAuthTrace(correlationId, "Signup code send failed", {
      email,
      ip,
      userAgent,
      errorCode: error.status,
      errorMessage: error.message,
      isRateLimit,
      retrySeconds,
    });

    if (isRateLimit) {
      redirect(
        `/signup?email=${encodeURIComponent(email)}&trace=${encodeURIComponent(correlationId)}&error=${encodeURIComponent(
          `rate:${retrySeconds ?? 60}`,
        )}`,
      );
    }

    redirect(
      `/signup?email=${encodeURIComponent(email)}&trace=${encodeURIComponent(correlationId)}&error=send-code`,
    );
  }

  await logAuthTrace(correlationId, "Signup code sent", { email, ip, userAgent });
  redirect(`/login/code?email=${encodeURIComponent(email)}&trace=${encodeURIComponent(correlationId)}&sent=1&signup=1`);
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
      `/login/code?email=${encodeURIComponent(email)}&trace=${encodeURIComponent(correlationId)}&error=missing-code`,
    );
  }

  await logAuthTrace(correlationId, "Login code verify started", {
    email,
    ip,
    userAgent,
    tokenLength: token.length,
  });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.verifyOtp({
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
      `/login/code?email=${encodeURIComponent(email)}&trace=${encodeURIComponent(correlationId)}&sent=1&error=invalid-code`,
    );
  }

  const verifiedUser = data.user ?? (await supabase.auth.getUser()).data.user;
  if (verifiedUser?.id && verifiedUser.email) {
    await ensureUserProfile(verifiedUser.id, verifiedUser.email);
  }

  await logAuthTrace(correlationId, "Login code verify succeeded", { email, ip, userAgent });
  redirect("/email/composer");
}

export async function signInWithPassword(formData: FormData) {
  const correlationId = randomUUID();
  const { ip, userAgent } = await getRequestMeta();
  const { allowed, retryAfterMs } = checkRateLimit(`login-password:${ip}`, 10, 5 * 60 * 1000);
  const email = normalizeEmail(formData.get("email"));
  const password = String(formData.get("password") ?? "");

  if (!allowed) {
    await logAuthTrace(correlationId, "Password login rate-limited", {
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

  if (!email || !password) {
    await logAuthTrace(correlationId, "Password login missing credentials", {
      email,
      ip,
      userAgent,
      hasPassword: Boolean(password),
    });
    redirect(
      `/login?email=${encodeURIComponent(email)}&trace=${encodeURIComponent(correlationId)}&error=missing-credentials`,
    );
  }

  await logAuthTrace(correlationId, "Password login started", { email, ip, userAgent });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user) {
    await logAuthTrace(correlationId, "Password login fallback failed", {
      email,
      ip,
      userAgent,
      errorCode: error?.status,
      errorMessage: error?.message,
    });
    redirect(
      `/login?email=${encodeURIComponent(email)}&trace=${encodeURIComponent(correlationId)}&error=invalid-credentials`,
    );
  }

  if (data.user.email) {
    await ensureUserProfile(data.user.id, data.user.email);
  }
  await clearBypassSessionCookie();
  await logAuthTrace(correlationId, "Password login succeeded", { email, ip, userAgent });
  redirect("/email/composer");
}

export async function updatePasswordAction(formData: FormData) {
  const correlationId = randomUUID();
  const { ip, userAgent } = await getRequestMeta();
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (!password || !confirmPassword) {
    await logAuthTrace(correlationId, "Password update missing input", {
      ip,
      userAgent,
      hasPassword: Boolean(password),
      hasConfirmPassword: Boolean(confirmPassword),
    });
    redirect(`/reset-password?trace=${encodeURIComponent(correlationId)}&error=missing-password`);
  }

  if (password !== confirmPassword) {
    await logAuthTrace(correlationId, "Password update mismatch", { ip, userAgent });
    redirect(`/reset-password?trace=${encodeURIComponent(correlationId)}&error=password-mismatch`);
  }

  if (password.length < 8) {
    await logAuthTrace(correlationId, "Password update weak password", {
      ip,
      userAgent,
      passwordLength: password.length,
    });
    redirect(`/reset-password?trace=${encodeURIComponent(correlationId)}&error=weak-password`);
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.updateUser({ password });

  if (error || !data.user) {
    await logAuthTrace(correlationId, "Password update failed", {
      ip,
      userAgent,
      errorCode: error?.status,
      errorMessage: error?.message,
    });
    redirect(`/reset-password?trace=${encodeURIComponent(correlationId)}&error=update-password`);
  }

  if (data.user.email) {
    await ensureUserProfile(data.user.id, data.user.email);
  }
  await clearBypassSessionCookie();
  await logAuthTrace(correlationId, "Password update succeeded", {
    ip,
    userAgent,
    email: data.user.email,
  });
  redirect("/email/composer");
}

export async function bypassLogin(formData: FormData) {
  const correlationId = randomUUID();
  const { ip, userAgent } = await getRequestMeta();
  const { allowed, retryAfterMs } = checkRateLimit(`login-bypass:${ip}`, 5, 15 * 60 * 1000);
  const password = String(formData.get("password") ?? "");

  if (!allowed) {
    await logAuthTrace(correlationId, "Bypass login rate-limited", { ip, userAgent, retryAfterMs });
    redirect(`/login/bypass?trace=${encodeURIComponent(correlationId)}&error=${encodeURIComponent(`rate:${Math.ceil(retryAfterMs / 1000)}`)}`);
  }

  await logAuthTrace(correlationId, "Bypass login attempt started", {
    ip,
    userAgent,
    passwordLength: password.length,
  });

  if (!password) {
    await logAuthTrace(correlationId, "Bypass login attempt missing password", { ip, userAgent });
    redirect(`/login/bypass?trace=${encodeURIComponent(correlationId)}&error=missing-bypass-password`);
  }

  if (!verifyBypassPassword(password)) {
    await logAuthTrace(correlationId, "Bypass login attempt failed", { ip, userAgent });
    redirect(`/login/bypass?trace=${encodeURIComponent(correlationId)}&error=bypass-failed`);
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
