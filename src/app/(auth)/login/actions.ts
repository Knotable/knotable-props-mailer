'use server';

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabaseServer";

const ALLOWED_EMAIL = process.env.ALLOWED_EMAIL ?? "a@sarva.co";

const normalizeEmail = (value: FormDataEntryValue | null) =>
  String(value ?? "").trim().toLowerCase();

export async function sendLoginCode(formData: FormData) {
  const email = normalizeEmail(formData.get("email"));

  if (!email) {
    redirect("/login?error=missing-email");
  }

  if (email !== ALLOWED_EMAIL) {
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
    redirect(`/login?email=${encodeURIComponent(email)}&sent=1&error=invalid-code`);
  }

  redirect("/email/composer");
}

export async function signOutAction() {
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  redirect("/login");
}
