'use server';

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { logError } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import { createServerSupabaseClient } from "@/lib/supabaseServer";

const ALLOWED_EMAIL = process.env.ALLOWED_EMAIL ?? "a@sarva.co";

const normalizeEmail = (value: FormDataEntryValue | null) =>
  String(value ?? "").trim().toLowerCase();

export async function sendLoginCode(formData: FormData) {
  const headerStore = await headers();
  const ip =
    headerStore.get("x-forwarded-for")?.split(",")[0].trim() ??
    headerStore.get("x-real-ip") ??
    "unknown";
  const { allowed, retryAfterMs } = checkRateLimit(`login-code:${ip}`, 3, 10 * 60 * 1000);
  const email = normalizeEmail(formData.get("email"));

  if (!allowed) {
    redirect(
      `/login?email=${encodeURIComponent(email)}&error=${encodeURIComponent(
        `rate:${Math.ceil(retryAfterMs / 1000)}`,
      )}`,
    );
  }

  if (!email) {
    redirect("/login?error=missing-email");
  }

  if (email !== ALLOWED_EMAIL) {
    logError({
      message: "Login code requested for unauthorized email",
      source: "auth",
      payload: { email, ip },
    }).catch(console.error);
    redirect(`/login?email=${encodeURIComponent(email)}&error=unauthorized`);
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
    },
  });

  if (error) {
    logError({
      message: "Login code OTP error",
      source: "auth",
      payload: { email, errorCode: error.status, errorMessage: error.message },
    }).catch(console.error);
    redirect(`/login?email=${encodeURIComponent(email)}&error=send-code`);
  }

  redirect(`/login?email=${encodeURIComponent(email)}&sent=1`);
}

export async function verifyLoginCode(formData: FormData) {
  const email = normalizeEmail(formData.get("email"));
  const token = String(formData.get("code") ?? "").trim();

  if (!email || !token) {
    redirect(`/login?email=${encodeURIComponent(email)}&error=missing-code`);
  }

  if (email !== ALLOWED_EMAIL) {
    redirect(`/login?email=${encodeURIComponent(email)}&error=unauthorized`);
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.verifyOtp({
    email,
    token,
    type: "email",
  });

  if (error) {
    logError({
      message: "Login code verification error",
      source: "auth",
      payload: { email, errorCode: error.status, errorMessage: error.message },
    }).catch(console.error);
    redirect(`/login?email=${encodeURIComponent(email)}&sent=1&error=invalid-code`);
  }

  redirect("/email/composer");
}

export async function signOutAction() {
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  redirect("/login");
}
