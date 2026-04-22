'use server';

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { env } from "@/lib/env";
import { createServerSupabaseClient } from "@/lib/supabaseServer";
import { logError } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";

const ALLOWED_EMAIL = process.env.ALLOWED_EMAIL ?? "a@sarva.com";

export async function sendMagicLink(formData: FormData) {
  const headerStore = await headers();
  const ip =
    headerStore.get("x-forwarded-for")?.split(",")[0].trim() ??
    headerStore.get("x-real-ip") ??
    "unknown";

  // 3 magic-link requests per IP per 10 minutes.
  const { allowed, retryAfterMs } = checkRateLimit(`magic-link:${ip}`, 3, 10 * 60 * 1000);
  if (!allowed) {
    throw new Error(
      `Too many requests. Try again in ${Math.ceil(retryAfterMs / 1000)} seconds.`,
    );
  }

  const email = String(formData.get("email")).toLowerCase().trim();

  if (email !== ALLOWED_EMAIL) {
    // Log the rejected attempt (no user_id yet — use null).
    logError({
      message: "Magic link requested for unauthorized email",
      source: "auth",
      payload: { email, ip },
    }).catch(console.error);
    throw new Error("This tool is restricted to authorized users.");
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${env.appBaseUrl}/loginWithToken`,
      shouldCreateUser: false,
    },
  });
  if (error) {
    logError({
      message: "Magic link OTP error",
      source: "auth",
      payload: { email, errorCode: error.status, errorMessage: error.message },
    }).catch(console.error);
    throw error;
  }
}

export async function signOutAction() {
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  redirect("/login");
}

