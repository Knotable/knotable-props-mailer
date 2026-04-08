import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabaseServer";
import type { EmailOtpType } from "@supabase/supabase-js";

export default async function LoginWithTokenPage({ searchParams }: { searchParams: Record<string, string | string[]> }) {
  const supabase = await createServerSupabaseClient();
  const token_hash = searchParams.token_hash as string;
  const type = (searchParams.type as EmailOtpType | undefined) || "magiclink";
  if (!token_hash) {
    redirect("/login");
  }

  const { error } = await supabase.auth.verifyOtp({ type, token_hash });
  if (error) {
    console.error(error);
    redirect("/login?error=token");
  }

  redirect("/email/composer");
}
