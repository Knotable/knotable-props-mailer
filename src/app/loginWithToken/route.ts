import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/lib/supabaseServer";
import { ensureUserProfile } from "@/lib/authAccess";

export const dynamic = "force-dynamic";

/**
 * GET /loginWithToken?token_hash=...&type=magiclink|recovery|...
 *
 * Verifies emailed sign-in/recovery links. This must be a Route Handler, not a
 * Server Component page: verifying the OTP makes @supabase/ssr persist the new
 * session via cookie writes, and Next.js only allows cookie writes in Route
 * Handlers and Server Actions. The previous page.tsx implementation meant even
 * a valid link could not keep its session, which is why emailed links appeared
 * to be "not supported".
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get("token_hash");
  const type = (url.searchParams.get("type") as EmailOtpType | null) || "magiclink";

  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, url.origin));

  if (!tokenHash) {
    return redirectTo("/login/code?error=use-code");
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });

  if (error) {
    console.error("[loginWithToken] OTP verification failed:", error.message);
    return redirectTo("/login/code?error=link-invalid");
  }

  const user = data.user ?? (await supabase.auth.getUser()).data.user;
  if (user?.id && user.email) {
    await ensureUserProfile(user.id, user.email);
  }

  if (type === "recovery") {
    return redirectTo("/reset-password");
  }

  return redirectTo("/email/composer");
}
