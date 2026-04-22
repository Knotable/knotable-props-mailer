'use server';

import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { createServerSupabaseClient } from "@/lib/supabaseServer";

const ALLOWED_EMAIL = process.env.ALLOWED_EMAIL ?? "a@sarva.co";

export async function sendMagicLink(formData: FormData) {
  const email = String(formData.get("email")).toLowerCase().trim();

  if (email !== ALLOWED_EMAIL) {
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
  if (error) throw error;
}

export async function signOutAction() {
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  redirect("/login");
}
