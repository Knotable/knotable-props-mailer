import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabaseServer";
import { ensureUserProfile } from "@/lib/authAccess";
import type { EmailOtpType } from "@supabase/supabase-js";

type LoginWithTokenPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const pickParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] ?? "" : value ?? "";

export default async function LoginWithTokenPage({ searchParams }: LoginWithTokenPageProps) {
  const params = (await searchParams) ?? {};
  const supabase = await createServerSupabaseClient();
  const token_hash = pickParam(params.token_hash);
  const type = (pickParam(params.type) as EmailOtpType | "") || "magiclink";

  if (!token_hash) {
    redirect("/login?error=use-code");
  }

  const { data, error } = await supabase.auth.verifyOtp({ type, token_hash });
  if (error) {
    console.error("[loginWithToken] OTP verification failed:", error.message);
    redirect("/login?error=use-code");
  }

  const user = data.user ?? (await supabase.auth.getUser()).data.user;
  if (user?.id && user.email) {
    await ensureUserProfile(user.id, user.email);
  }

  redirect("/email/composer");
}
