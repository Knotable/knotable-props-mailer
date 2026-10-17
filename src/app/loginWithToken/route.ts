import { NextRequest, NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { ensureUserProfile } from "@/lib/authAccess";
import { createServerSupabaseClient } from "@/lib/supabaseServer";
import { POST_LOGIN_RETURN_COOKIE, safeReturnPath } from "@/lib/postLoginReturn";

const OTP_TYPES = new Set<EmailOtpType>([
  "email",
  "email_change",
  "invite",
  "magiclink",
  "recovery",
  "signup",
]);

const redirectTo = (request: NextRequest, path: string) =>
  NextResponse.redirect(new URL(path, request.url));

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code")?.trim() ?? "";
  const tokenHash = request.nextUrl.searchParams.get("token_hash")?.trim() ?? "";
  const rawType = request.nextUrl.searchParams.get("type")?.trim() ?? "";
  const isRecovery =
    rawType === "recovery" || request.nextUrl.searchParams.get("next") === "/reset-password";
  const supabase = await createServerSupabaseClient();

  // Modern @supabase/ssr password reset links return an authorization code.
  // Legacy/custom email templates may still return token_hash + type.
  const result = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : tokenHash && OTP_TYPES.has(rawType as EmailOtpType)
      ? await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type: rawType as EmailOtpType,
        })
      : { data: { user: null }, error: new Error("Missing or invalid auth callback parameters") };

  if (result.error) {
    console.error("[loginWithToken] Authentication callback failed:", result.error.message);
    return redirectTo(request, isRecovery ? "/login?error=invalid-recovery-link" : "/login/code?error=invalid-link");
  }

  const user = result.data.user ?? (await supabase.auth.getUser()).data.user;
  if (user?.id && user.email) {
    await ensureUserProfile(user.id, user.email);
  }

  if (isRecovery) return redirectTo(request, "/reset-password");
  const returnTo = safeReturnPath(request.cookies.get(POST_LOGIN_RETURN_COOKIE)?.value);
  const response = redirectTo(request, returnTo ?? "/email/composer");
  if (returnTo) response.cookies.delete(POST_LOGIN_RETURN_COOKIE);
  return response;
}
