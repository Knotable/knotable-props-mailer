import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabaseServer";
import type { EmailOtpType } from "@supabase/supabase-js";

// searchParams is a Promise in Next.js 15+ — must be awaited.
export default async function LoginWithTokenPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[]>>;
}) {
  const params = await searchParams;
  const supabase = await createServerSupabaseClient();

  const token_hash = params.token_hash as string | undefined;
  const type = (params.type as EmailOtpType | undefined) ?? "magiclink";

  if (!token_hash) {
    redirect("/login");
  }

  const { error } = await supabase.auth.verifyOtp({ type, token_hash });
  if (error) {
    console.error("[loginWithToken] OTP verification failed:", error.message);
    redirect("/login?error=token");
  }

  redirect("/email/composer");
}
