'use server';

import { env } from "@/lib/env";
import { createServerSupabaseClient } from "@/lib/supabaseServer";

export async function sendMagicLink(formData: FormData) {
  const email = String(formData.get("email"));
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${env.appBaseUrl}/loginWithToken`,
      shouldCreateUser: true,
    },
  });
  if (error) throw error;
}
