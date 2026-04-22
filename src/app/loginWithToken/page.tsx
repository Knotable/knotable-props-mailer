import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabaseServer";
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

  const { error } = await supabase.auth.verifyOtp({ type, token_hash });
  if (error) {
    console.error("[loginWithToken] OTP verification failed:", error.message);
    redirect("/login?error=use-code");
  }

  redirect("/email/composer");
}
